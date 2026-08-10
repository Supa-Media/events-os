import { afterEach, describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import type { Doc, Id } from "../_generated/dataModel";
import { dualWriteGiftForDonation } from "../lib/givingDonors";
import {
  clampSubjectName,
  digestWindowStart,
  isDigestDue,
  localParts,
  meetsAmountFloor,
  normalizeRecipients,
  ruleCoversScope,
  ruleMatchesGift,
  shouldSendDigest,
} from "../lib/givingNotificationRules";
import {
  renderDigestEmail,
  renderImmediateGiftEmail,
  type NotificationGift,
} from "../lib/givingNotificationEmails";
import {
  MAX_DIGEST_MATCHES,
  collectWindowGifts,
} from "../givingNotificationDigests";

/**
 * Giving notification rules — "tell me when money comes in."
 *
 * Four things this suite exists to hold down:
 *
 *  1. THE THRESHOLD IS INCLUSIVE. A rule set at $500 fires on a gift of
 *     exactly $500. Asserted in cents, never against a formatted string.
 *  2. THE EMPTY-DIGEST ASYMMETRY. An empty daily is skipped AND leaves the
 *     watermark alone; an empty weekly is sent. Both directions are asserted,
 *     because either one flipping is silent in production.
 *  3. AN EMAIL CANNOT COST A GIFT. The immediate notification is scheduled
 *     from `recordGiftForDonor`, so a Resend transport failure has to leave
 *     the gift, the donor rollups and the scope aggregates untouched.
 *  4. THE TEMPLATES RENDER. HTML built by string concatenation has no type
 *     system watching it; these render the real templates and read the output.
 */

// ── Clock fixtures (America/New_York, the org's zone) ───────────────────────
// Verified against Intl: EDT is UTC-4 in August, EST is UTC-5 in January.
const MON_8AM_ET = Date.parse("2026-08-10T12:00:00Z"); // Monday 08:00 EDT
const MON_9AM_ET = Date.parse("2026-08-10T13:00:00Z"); // Monday 09:00 EDT
const TUE_8AM_ET = Date.parse("2026-08-11T12:00:00Z"); // Tuesday 08:00 EDT
const SUN_8AM_ET = Date.parse("2026-08-09T12:00:00Z"); // Sunday 08:00 EDT
const WINTER_MON_8AM_ET = Date.parse("2026-01-12T13:00:00Z"); // Monday 08:00 EST

const DAY_MS = 24 * 60 * 60 * 1000;

/** Well before any digest window — rules are created here so a rule's own
 *  `createdAt` can never clamp the first window under test. */
const SETUP_AT = MON_8AM_ET - 3 * DAY_MS;

// ── Fixtures for the pure tests ─────────────────────────────────────────────

const CHAPTER_A = "chapter_a" as Id<"chapters">;
const CHAPTER_B = "chapter_b" as Id<"chapters">;

function rule(
  over: Partial<Doc<"givingNotificationRules">> = {},
): Doc<"givingNotificationRules"> {
  return {
    _id: "rule1" as Id<"givingNotificationRules">,
    _creationTime: 0,
    name: "Every gift",
    recipients: ["dev@publicworship.life"],
    cadence: "immediate",
    scope: "all",
    isActive: true,
    createdBy: "u1" as Id<"users">,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as Doc<"givingNotificationRules">;
}

function giftLike(
  over: Partial<Doc<"gifts">> = {},
): Pick<Doc<"gifts">, "scope" | "amountCents"> {
  return { scope: "central", amountCents: 10_000, ...over } as Pick<
    Doc<"gifts">,
    "scope" | "amountCents"
  >;
}

function sampleGift(over: Partial<NotificationGift> = {}): NotificationGift {
  return {
    giftId: "g1",
    amountCents: 50_000,
    receivedAt: MON_8AM_ET,
    method: "stripe",
    scopeLabel: "New York",
    provenance: "Given on an event page",
    isBackdated: false,
    donor: {
      donorId: "d1",
      name: "Ada Donor",
      email: "ada@example.com",
      lifetimeCents: 50_000,
      giftCount: 1,
      isFirstGift: true,
      url: "https://publicworship.life/os/giving/donor/d1",
    },
    ...over,
  };
}

// ── Email capture (the house fetch stub) ────────────────────────────────────

function captureEmails(): {
  sent: { to: string; subject: string; html: string }[];
  restore: () => void;
} {
  const realFetch = globalThis.fetch;
  const prevKey = process.env.RESEND_API_KEY;
  const prevAppUrl = process.env.APP_URL;
  process.env.RESEND_API_KEY = "resend_test_key";
  process.env.APP_URL = "https://publicworship.life/os";
  const sent: { to: string; subject: string; html: string }[] = [];
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    sent.push({ to: body.to, subject: body.subject, html: body.html });
    return { ok: true, status: 200, text: async () => "{}" };
  }) as unknown as typeof fetch;
  return {
    sent,
    restore: () => {
      globalThis.fetch = realFetch;
      if (prevKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevKey;
      if (prevAppUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = prevAppUrl;
    },
  };
}

/**
 * Body wrapper for anything that records a gift: `recordGiftForDonor`
 * schedules `notifyGiftRecorded`, and a job left pending doesn't stay inside
 * its own test — it flushes at whatever later await comes along and lands in a
 * LATER test's email capture. Fake timers + `finishAllScheduledFunctions`, the
 * pattern `blasts.test.ts` / `cards.test.ts` established. `at` also pins
 * `Date.now()`, which is what puts a gift's `createdAt` inside a chosen digest
 * window without ever patching the row.
 */
async function atClock(
  t: ChapterSetup["t"],
  at: number,
  body: () => Promise<void>,
): Promise<void> {
  vi.useFakeTimers();
  vi.setSystemTime(at);
  try {
    await body();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  } finally {
    vi.useRealTimers();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

// ── DB setup helpers ────────────────────────────────────────────────────────

async function seatCaller(
  s: ChapterSetup,
  slug: string,
  scope: Id<"chapters"> | "central",
): Promise<Id<"people">> {
  return run(s.t, async (ctx) => {
    const personId = await ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Seated Caller",
      userId: s.userId,
      createdAt: Date.now(),
    });
    const def = await ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!def) throw new Error(`${slug} not seeded`);
    await ctx.db.insert("seatAssignments", {
      seatDefId: def._id,
      scope,
      personId,
      createdAt: Date.now(),
    });
    return personId;
  });
}

/** Caller seated as development director at central — full `giving.manage`
 *  everywhere, the desk's own privileged setup. */
async function devDirectorSetup(): Promise<ChapterSetup> {
  const t = newT();
  await run(t, (ctx) => runSeedSeatDefs(ctx));
  const s = await setupChapter(t);
  await seatCaller(s, "development_director", "central");
  return s;
}

/**
 * A SECOND authenticated caller, seated as chapter director at `chapterId` —
 * chapter-scope `giving.view` and nothing else. Note what that seat does NOT
 * carry: no seat on the chapter chart holds `giving.manage` today (donor-CRM
 * WRITE is central's, by the giving PRD), so this caller reads its own book
 * and writes nothing.
 */
async function seatChapterViewer(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  email = "chapdir@publicworship.life",
): Promise<ChapterSetup["as"]> {
  const userId = await run(s.t, async (ctx) => {
    const userId = await ctx.db.insert("users", { email });
    const personId = await ctx.db.insert("people", {
      chapterId,
      name: "Chapter Director",
      userId,
      createdAt: Date.now(),
    });
    const def = await ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", "chapter_director"))
      .unique();
    if (!def) throw new Error("chapter_director not seeded");
    await ctx.db.insert("seatAssignments", {
      seatDefId: def._id,
      scope: chapterId,
      personId,
      createdAt: Date.now(),
    });
    return userId;
  });
  return s.t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
}

/**
 * A caller holding chapter-scope `giving.manage` at `chapterId`, via a seat
 * def minted here.
 *
 * The seat chart carries no such seat TODAY — and that is exactly why this
 * fixture exists. The gate is written against the capability, not against a
 * seat list, so the day a chapter seat is granted `giving.manage` the
 * behaviour these tests pin down is what that holder will get. Without the
 * fixture the chapter-scope branch of `saveRule`'s gate would be untested
 * dead code that nobody notices is wrong until it goes live.
 */
async function seatChapterGivingManager(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
  email = "chapgiving@publicworship.life",
): Promise<ChapterSetup["as"]> {
  const userId = await run(s.t, async (ctx) => {
    const userId = await ctx.db.insert("users", { email });
    const personId = await ctx.db.insert("people", {
      chapterId,
      name: "Chapter Giving Manager",
      userId,
      createdAt: Date.now(),
    });
    const now = Date.now();
    const slug = `test_chapter_giving_manager_${email}`;
    const seatDefId = await ctx.db.insert("seatDefs", {
      slug,
      title: "Chapter Giving Manager (test)",
      chart: "chapter",
      parentSlug: "chapter_director",
      maxHolders: 1,
      duties: [],
      capabilities: ["giving.manage", "giving.view", "nav.giving"],
      sortOrder: 9999,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("seatAssignments", {
      seatDefId,
      scope: chapterId,
      personId,
      createdAt: now,
    });
    return userId;
  });
  return s.t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
}

async function saveRule(
  as: ChapterSetup["as"],
  over: Record<string, unknown> = {},
): Promise<Id<"givingNotificationRules">> {
  return (await as.mutation(api.givingNotifications.saveRule, {
    name: "Every gift",
    recipients: ["dev@publicworship.life"],
    cadence: "immediate",
    scope: "all",
    ...over,
  } as never)) as Id<"givingNotificationRules">;
}

async function addGift(
  as: ChapterSetup["as"],
  over: Record<string, unknown> = {},
): Promise<{ giftId: Id<"gifts">; donorId: Id<"donors"> }> {
  return (await as.mutation(api.givingPlatform.addGift, {
    scope: "central",
    name: "Ada Donor",
    email: "ada@example.com",
    amountCents: 50_000,
    method: "stripe",
    ...over,
  } as never)) as { giftId: Id<"gifts">; donorId: Id<"donors"> };
}

// ═══════════════════════════════════════════════════════════════════════════
// Pure logic
// ═══════════════════════════════════════════════════════════════════════════

describe("the amount floor is inclusive", () => {
  test("a gift of exactly the threshold sends", () => {
    expect(meetsAmountFloor(50_000, 50_000)).toBe(true);
  });

  test("one cent under the threshold does not", () => {
    expect(meetsAmountFloor(50_000, 49_999)).toBe(false);
  });

  test("a cent over sends", () => {
    expect(meetsAmountFloor(50_000, 50_001)).toBe(true);
  });

  test("no floor at all matches the smallest gift", () => {
    expect(meetsAmountFloor(undefined, 1)).toBe(true);
  });
});

describe("scope matching", () => {
  test("`all` covers central and every chapter", () => {
    expect(ruleCoversScope("all", "central")).toBe(true);
    expect(ruleCoversScope("all", CHAPTER_A)).toBe(true);
  });

  test("`central` covers only central — a chapter gift is not central's", () => {
    expect(ruleCoversScope("central", "central")).toBe(true);
    expect(ruleCoversScope("central", CHAPTER_A)).toBe(false);
  });

  test("a chapter rule covers only that chapter", () => {
    expect(ruleCoversScope(CHAPTER_A, CHAPTER_A)).toBe(true);
    expect(ruleCoversScope(CHAPTER_A, CHAPTER_B)).toBe(false);
    expect(ruleCoversScope(CHAPTER_A, "central")).toBe(false);
  });

  test("an inactive rule matches nothing, however well it fits", () => {
    const r = rule({ isActive: false, scope: "all" });
    expect(ruleMatchesGift(r, giftLike())).toBe(false);
  });

  test("scope and floor are ANDed", () => {
    const r = rule({ scope: CHAPTER_A, minAmountCents: 50_000 });
    expect(ruleMatchesGift(r, giftLike({ scope: CHAPTER_A, amountCents: 50_000 }))).toBe(true);
    expect(ruleMatchesGift(r, giftLike({ scope: CHAPTER_A, amountCents: 49_999 }))).toBe(false);
    expect(ruleMatchesGift(r, giftLike({ scope: CHAPTER_B, amountCents: 90_000 }))).toBe(false);
  });
});

describe("recipient normalization", () => {
  test("trims, lowercases, and de-duplicates, keeping first-seen order", () => {
    const { recipients, invalid } = normalizeRecipients([
      "  Shay@PublicWorship.life ",
      "aj@publicworship.life",
      "SHAY@publicworship.life",
      "",
    ]);
    expect(recipients).toEqual(["shay@publicworship.life", "aj@publicworship.life"]);
    expect(invalid).toEqual([]);
  });

  test("flags what doesn't look like an address instead of silently dropping it", () => {
    const { recipients, invalid } = normalizeRecipients([
      "dev@publicworship.life",
      "not-an-email",
      "also bad@example.com",
    ]);
    expect(recipients).toEqual(["dev@publicworship.life"]);
    expect(invalid).toEqual(["not-an-email", "also bad@example.com"]);
  });
});

describe("the digest clock", () => {
  test("an immediate rule is never 'due' — it fires from the gift, not the clock", () => {
    expect(isDigestDue(rule({ cadence: "immediate" }), MON_8AM_ET)).toBe(false);
  });

  test("a daily rule is due at its local hour, and not before it", () => {
    const daily = rule({ cadence: "daily", sendHourLocal: 8 });
    expect(isDigestDue(daily, MON_8AM_ET)).toBe(true);
    // 09:00 is a CATCH-UP, not a second firing — see the missed-tick test.
    const beforeHour = rule({ cadence: "daily", sendHourLocal: 18 });
    expect(isDigestDue(beforeHour, MON_9AM_ET)).toBe(false);
  });

  test("the local hour is Eastern in January too, not a fixed UTC offset", () => {
    expect(isDigestDue(rule({ cadence: "daily" }), WINTER_MON_8AM_ET)).toBe(true);
  });

  test("a rule already run today is not due again", () => {
    const daily = rule({
      cadence: "daily",
      lastRunDayKey: localParts(MON_8AM_ET).dayKey,
    });
    expect(isDigestDue(daily, MON_8AM_ET)).toBe(false);
    expect(isDigestDue(daily, TUE_8AM_ET)).toBe(true);
  });

  test("a missed tick catches up later the same day instead of losing it", () => {
    // The old exact-hour test meant one dropped cron tick cost a whole day —
    // and a whole WEEK for a weekly rule.
    const daily = rule({ cadence: "daily", sendHourLocal: 8 });
    expect(isDigestDue(daily, MON_9AM_ET)).toBe(true);

    const weekly = rule({ cadence: "weekly", sendHourLocal: 8, sendWeekday: 1 });
    expect(isDigestDue(weekly, MON_9AM_ET)).toBe(true);
    // …but a catch-up never leaks onto the wrong weekday.
    expect(isDigestDue(weekly, TUE_8AM_ET)).toBe(false);
  });

  test("a rule set to 2am still runs on the DST spring-forward day", () => {
    // 2026-03-08 is the US spring-forward Sunday: local 02:00 never happens,
    // so an exact-hour match skipped that rule for the day (and a weekly one
    // for the week). 07:00Z is 02:00 EST — the instant that gets skipped.
    const springForward = Date.parse("2026-03-08T07:00:00Z");
    const daily = rule({ cadence: "daily", sendHourLocal: 2 });
    // Nothing is at local hour 2 that day, so an exact match found nothing;
    // `>=` picks it up on the very next tick.
    const nextTick = Date.parse("2026-03-08T08:00:00Z"); // 04:00 EDT
    expect(localParts(springForward).hour).not.toBe(2);
    expect(isDigestDue(daily, nextTick)).toBe(true);
  });

  test("a weekly rule waits for its weekday", () => {
    const weekly = rule({ cadence: "weekly", sendWeekday: 1 });
    expect(isDigestDue(weekly, MON_8AM_ET)).toBe(true);
    expect(isDigestDue(weekly, SUN_8AM_ET)).toBe(false);
    expect(isDigestDue(weekly, TUE_8AM_ET)).toBe(false);
  });

  test("an inactive rule is never due", () => {
    expect(isDigestDue(rule({ cadence: "daily", isActive: false }), MON_8AM_ET)).toBe(false);
  });

  test("an unrecognized weekday fails CLOSED, never onto Sunday", () => {
    // `?? 0` here would have made every weekly rule "due on Sunday" if
    // `formatToParts` ever yielded something outside the map. A mailer that
    // guesses is worse than one that waits.
    const weekly = rule({ cadence: "weekly", sendWeekday: 0 });
    const sunday = { ...weekly, sendWeekday: -1 };
    expect(isDigestDue(sunday, SUN_8AM_ET)).toBe(false);
    expect(isDigestDue(weekly, SUN_8AM_ET)).toBe(true);
  });

  test("the window starts at the watermark once there is one", () => {
    const r = rule({ cadence: "daily", lastSentAt: MON_8AM_ET, createdAt: 0 });
    expect(digestWindowStart(r, TUE_8AM_ET)).toBe(MON_8AM_ET);
  });

  test("a first run looks back one period, but never past the rule's own birth", () => {
    const old = rule({ cadence: "weekly", createdAt: 0 });
    expect(digestWindowStart(old, MON_8AM_ET)).toBe(MON_8AM_ET - 7 * DAY_MS);

    const fresh = rule({ cadence: "weekly", createdAt: MON_8AM_ET - DAY_MS });
    expect(digestWindowStart(fresh, MON_8AM_ET)).toBe(MON_8AM_ET - DAY_MS);
  });
});

describe("the empty-digest asymmetry", () => {
  test("an empty DAILY digest is not sent", () => {
    expect(shouldSendDigest("daily", 0)).toBe(false);
  });

  test("an empty WEEKLY digest IS sent — 'nothing came in' is the signal", () => {
    expect(shouldSendDigest("weekly", 0)).toBe(true);
  });

  test("both send once there is anything to say", () => {
    expect(shouldSendDigest("daily", 1)).toBe(true);
    expect(shouldSendDigest("weekly", 1)).toBe(true);
  });

  test("a CUT window always sends, even an empty daily — that's the wedge fix", () => {
    // A chapter rule sitting behind a large import's prefix matches nothing,
    // and if that skipped without stamping it would re-read the same prefix
    // every day, forever, in silence.
    expect(shouldSendDigest("daily", 0, true)).toBe(true);
    expect(shouldSendDigest("weekly", 0, true)).toBe(true);
  });
});

describe("subject-line clamping", () => {
  test("a donor name from the public form can't produce a 10,000-char subject", () => {
    const clamped = clampSubjectName("A".repeat(10_000));
    expect(clamped.length).toBe(80);
    expect(clamped.endsWith("…")).toBe(true);
  });

  test("control characters are flattened, not carried into a header", () => {
    expect(clampSubjectName("Ada\r\nBcc: someone@evil.test")).toBe(
      "Ada Bcc: someone@evil.test",
    );
  });

  test("an ordinary name is left exactly as it is", () => {
    expect(clampSubjectName("  Ada Donor ")).toBe("Ada Donor");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Templates — rendered for real, then read
// ═══════════════════════════════════════════════════════════════════════════

describe("the immediate email", () => {
  test("leads with the amount, names the donor and the book, and links into the OS", () => {
    const { subject, html } = renderImmediateGiftEmail({
      ruleName: "Every gift",
      gift: sampleGift(),
    });
    expect(subject).toBe("$500.00 from Ada Donor — New York");
    expect(html).toContain("$500.00");
    expect(html).toContain("Ada Donor");
    expect(html).toContain("New York");
    expect(html).toContain("https://publicworship.life/os/giving/donor/d1");
    expect(html).toContain("First gift");
    expect(html).toContain("Given on an event page");
    expect(html).toMatch(/^<!doctype html>/);
  });

  test("names in-kind as in-kind, so it can't read as cash in the bank", () => {
    const { html } = renderImmediateGiftEmail({
      ruleName: "Every gift",
      gift: sampleGift({
        method: "in_kind",
        provenance: "In-kind — paid on the org's behalf",
      }),
    });
    expect(html).toContain("In-kind");
  });

  test("says a gift rode in on a ticket purchase", () => {
    const { html } = renderImmediateGiftEmail({
      ruleName: "Every gift",
      gift: sampleGift({ provenance: "Added to a ticket purchase" }),
    });
    expect(html).toContain("Added to a ticket purchase");
  });

  test("shows covered fees BESIDE the gift, never folded into it", () => {
    const { subject, html } = renderImmediateGiftEmail({
      ruleName: "Every gift",
      gift: sampleGift({ feeCoverageCents: 1_650 }),
    });
    // The subject is the gift, not the charge.
    expect(subject).toContain("$500.00");
    expect(html).toContain("$16.50");
  });

  test("carries the donor's note and their giving history", () => {
    const { html } = renderImmediateGiftEmail({
      ruleName: "Big gifts",
      gift: sampleGift({
        note: "For the Brooklyn launch",
        donor: {
          ...sampleGift().donor,
          isFirstGift: false,
          giftCount: 9,
          lifetimeCents: 1_234_500,
        },
      }),
    });
    expect(html).toContain("For the Brooklyn launch");
    expect(html).toContain("9 gifts");
    expect(html).toContain("$12,345.00");
    expect(html).toContain("Big gifts");
  });

  test("degrades to plain text rather than a dead link when APP_URL is unset", () => {
    const { html } = renderImmediateGiftEmail({
      ruleName: "Every gift",
      gift: sampleGift({ donor: { ...sampleGift().donor, url: null } }),
    });
    expect(html).toContain("Ada Donor");
    expect(html).not.toContain("href=\"null");
    expect(html).toContain("APP_URL");
  });
});

describe("escaping — donor names come from a public form", () => {
  const XSS = '<img src=x onerror=alert(1)>';

  test("the immediate email escapes the donor name, the note and the event", () => {
    const { html } = renderImmediateGiftEmail({
      ruleName: XSS,
      gift: sampleGift({
        note: XSS,
        eventName: XSS,
        scopeLabel: XSS,
        donor: { ...sampleGift().donor, name: XSS },
      }),
    });
    // The angle brackets are what turn text into an element; escaping them is
    // the whole defence. The literal `onerror=` substring surviving INSIDE
    // escaped text is correct and harmless — it is no longer an attribute.
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  test("the digest email escapes every field it interpolates", () => {
    const nasty = sampleGift({
      scopeLabel: XSS,
      donor: { ...sampleGift().donor, name: XSS },
    });
    const { html } = renderDigestEmail({
      ruleName: XSS,
      cadence: "daily",
      scopeLabel: XSS,
      periodStart: MON_8AM_ET - DAY_MS,
      periodEnd: MON_8AM_ET,
      totalCents: 50_000,
      giftCount: 1,
      largest: nasty,
      byScope: [{ label: XSS, cents: 50_000, count: 1 }],
      byMethod: [{ label: XSS, cents: 50_000, count: 1 }],
      gifts: [nasty],
      omittedCount: 0,
      countTruncated: false,
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  test("a name that closes the href attribute can't escape the link", () => {
    const { html } = renderImmediateGiftEmail({
      ruleName: "Every gift",
      gift: sampleGift({
        donor: {
          ...sampleGift().donor,
          name: '"><script>alert(1)</script>',
        },
      }),
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("the digest email", () => {
  test("an empty weekly digest says so plainly", () => {
    const { subject, html } = renderDigestEmail({
      ruleName: "Weekly roundup",
      cadence: "weekly",
      scopeLabel: "All books",
      periodStart: MON_8AM_ET - 7 * DAY_MS,
      periodEnd: MON_8AM_ET,
      totalCents: 0,
      giftCount: 0,
      largest: null,
      byScope: [],
      byMethod: [],
      gifts: [],
      omittedCount: 0,
      countTruncated: false,
    });
    expect(subject).toBe("No giving this week — All books");
    expect(html).toContain("No gifts came in");
  });

  test("totals, the largest gift, both breakdowns, and a link per donor", () => {
    const big = sampleGift({ giftId: "g1", amountCents: 120_000 });
    const small = sampleGift({
      giftId: "g2",
      amountCents: 2_500,
      method: "cash",
      scopeLabel: "Central",
      donor: {
        donorId: "d2",
        name: "Bo Giver",
        lifetimeCents: 2_500,
        giftCount: 1,
        isFirstGift: true,
        url: "https://publicworship.life/os/giving/donor/d2",
      },
    });
    const { subject, html } = renderDigestEmail({
      ruleName: "Daily roundup",
      cadence: "daily",
      scopeLabel: "All books",
      periodStart: MON_8AM_ET - DAY_MS,
      periodEnd: MON_8AM_ET,
      totalCents: 122_500,
      giftCount: 2,
      largest: big,
      byScope: [
        { label: "New York", cents: 120_000, count: 1 },
        { label: "Central", cents: 2_500, count: 1 },
      ],
      byMethod: [
        { label: "Chapter OS", cents: 120_000, count: 1 },
        { label: "Cash", cents: 2_500, count: 1 },
      ],
      gifts: [big, small],
      omittedCount: 3,
      countTruncated: false,
    });
    expect(subject).toBe("$1,225.00 from 2 gifts this day — All books");
    expect(html).toContain("$1,225.00");
    expect(html).toContain("$1,200.00");
    expect(html).toContain("Bo Giver");
    expect(html).toContain("Chapter OS");
    expect(html).toContain("Cash");
    expect(html).toContain("https://publicworship.life/os/giving/donor/d1");
    expect(html).toContain("https://publicworship.life/os/giving/donor/d2");
    expect(html).toContain("and 3 more");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Rules: CRUD + who may touch them
// ═══════════════════════════════════════════════════════════════════════════

describe("saveRule", () => {
  test("creates a rule and stores normalized recipients", async () => {
    const s = await devDirectorSetup();
    const ruleId = await saveRule(s.as, {
      recipients: ["  Development-Team@PublicWorship.life "],
    });
    const row = await run(s.t, (ctx) => ctx.db.get(ruleId));
    expect(row?.recipients).toEqual(["development-team@publicworship.life"]);
    expect(row?.isActive).toBe(true);
    expect(row?.cadence).toBe("immediate");
  });

  test("edits in place when handed an id", async () => {
    const s = await devDirectorSetup();
    const ruleId = await saveRule(s.as);
    const again = await saveRule(s.as, {
      ruleId,
      name: "Big gifts only",
      minAmountCents: 50_000,
      recipients: ["shay@publicworship.life", "aj@publicworship.life"],
    });
    expect(again).toBe(ruleId);
    const row = await run(s.t, (ctx) => ctx.db.get(ruleId));
    expect(row?.name).toBe("Big gifts only");
    expect(row?.minAmountCents).toBe(50_000);
    expect(row?.recipients).toHaveLength(2);
  });

  test("refuses a rule with nobody to send to", async () => {
    const s = await devDirectorSetup();
    await expect(saveRule(s.as, { recipients: ["   "] })).rejects.toThrow(ConvexError);
  });

  test("refuses an address that isn't one", async () => {
    const s = await devDirectorSetup();
    await expect(saveRule(s.as, { recipients: ["shay"] })).rejects.toThrow(ConvexError);
  });

  test("refuses an out-of-range send hour or weekday", async () => {
    const s = await devDirectorSetup();
    await expect(
      saveRule(s.as, { cadence: "daily", sendHourLocal: 24 }),
    ).rejects.toThrow(ConvexError);
    await expect(
      saveRule(s.as, { cadence: "weekly", sendWeekday: 7 }),
    ).rejects.toThrow(ConvexError);
  });

  test("refuses a fractional or negative amount floor", async () => {
    const s = await devDirectorSetup();
    await expect(saveRule(s.as, { minAmountCents: 12.5 })).rejects.toThrow(ConvexError);
    await expect(saveRule(s.as, { minAmountCents: -1 })).rejects.toThrow(ConvexError);
  });

  test("refuses a chapter that doesn't exist", async () => {
    const s = await devDirectorSetup();
    const ghost = await run(s.t, async (ctx) => {
      const id = await ctx.db.insert("chapters", { name: "Ghost", isActive: true });
      await ctx.db.delete(id);
      return id;
    });
    await expect(saveRule(s.as, { scope: ghost })).rejects.toThrow(ConvexError);
  });
});

describe("who may manage a rule", () => {
  test("central reach writes a rule for any book", async () => {
    const s = await devDirectorSetup();
    const ruleId = await saveRule(s.as, { scope: s.chapterId });
    const row = await run(s.t, (ctx) => ctx.db.get(ruleId));
    expect(row?.scope).toBe(s.chapterId);
  });

  test("a chapter seat that only READS the desk writes nothing", async () => {
    const s = await devDirectorSetup();
    const viewer = await seatChapterViewer(s, s.chapterId);
    await expect(saveRule(viewer, { scope: s.chapterId })).rejects.toThrow(
      ConvexError,
    );
  });

  test("chapter-scope giving.manage writes its own book's rule", async () => {
    const s = await devDirectorSetup();
    const chapMgr = await seatChapterGivingManager(s, s.chapterId);
    const ruleId = await saveRule(chapMgr, { scope: s.chapterId });
    const row = await run(s.t, (ctx) => ctx.db.get(ruleId));
    expect(row?.scope).toBe(s.chapterId);
  });

  test("chapter-scope giving.manage cannot point a rule at every book", async () => {
    const s = await devDirectorSetup();
    const chapMgr = await seatChapterGivingManager(s, s.chapterId);
    await expect(saveRule(chapMgr, { scope: "all" })).rejects.toThrow(ConvexError);
  });

  test("chapter-scope giving.manage cannot write a central rule", async () => {
    const s = await devDirectorSetup();
    const chapMgr = await seatChapterGivingManager(s, s.chapterId);
    await expect(saveRule(chapMgr, { scope: "central" })).rejects.toThrow(
      ConvexError,
    );
  });

  test("moving a rule out of a book needs rights on the book it's leaving", async () => {
    const s = await devDirectorSetup();
    const chapMgr = await seatChapterGivingManager(s, s.chapterId);
    const centralRule = await saveRule(s.as, { scope: "central" });
    // They can manage their own chapter, but not the scope it would leave —
    // otherwise re-pointing someone else's central rule at your own book is a
    // privilege escalation with extra steps.
    await expect(
      saveRule(chapMgr, { ruleId: centralRule, scope: s.chapterId }),
    ).rejects.toThrow(ConvexError);
  });

  test("an unseated caller can write nothing", async () => {
    const t = newT();
    await run(t, (ctx) => runSeedSeatDefs(ctx));
    const s = await setupChapter(t, { email: "nobody@publicworship.life" });
    await expect(saveRule(s.as)).rejects.toThrow(ConvexError);
  });
});

describe("listRules and setRuleActive", () => {
  test("a chapter seat sees only their own book's rules, and can't manage them", async () => {
    const s = await devDirectorSetup();
    const viewer = await seatChapterViewer(s, s.chapterId);
    await saveRule(s.as, { name: "Org-wide", scope: "all" });
    await saveRule(s.as, { name: "Chapter", scope: s.chapterId });

    const all = await s.as.query(api.givingNotifications.listRules, {});
    expect(all.map((r) => r.name).sort()).toEqual(["Chapter", "Org-wide"]);
    expect(all.every((r) => r.canManage)).toBe(true);

    const mine = await viewer.query(api.givingNotifications.listRules, {});
    expect(mine.map((r) => r.name)).toEqual(["Chapter"]);
    expect(mine[0].scopeLabel).toBe("New York");
    expect(mine[0].canManage).toBe(false);
  });

  test("a rule is deactivated, never deleted — and reactivates", async () => {
    const s = await devDirectorSetup();
    const ruleId = await saveRule(s.as);
    await s.as.mutation(api.givingNotifications.setRuleActive, {
      ruleId,
      isActive: false,
    });
    let row = await run(s.t, (ctx) => ctx.db.get(ruleId));
    expect(row).not.toBeNull();
    expect(row?.isActive).toBe(false);

    await s.as.mutation(api.givingNotifications.setRuleActive, {
      ruleId,
      isActive: true,
    });
    row = await run(s.t, (ctx) => ctx.db.get(ruleId));
    expect(row?.isActive).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The immediate path
// ═══════════════════════════════════════════════════════════════════════════

describe("immediate notifications", () => {
  test("a recorded gift mails every recipient of every matching rule", async () => {
    const s = await devDirectorSetup();
    await saveRule(s.as, {
      recipients: ["shay@publicworship.life", "aj@publicworship.life"],
    });
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET, async () => {
        await addGift(s.as, { amountCents: 50_000 });
      });
      expect(cap.sent.map((e) => e.to).sort()).toEqual([
        "aj@publicworship.life",
        "shay@publicworship.life",
      ]);
      expect(cap.sent[0].subject).toContain("$500.00");
      expect(cap.sent[0].html).toContain("/os/giving/donor/");
    } finally {
      cap.restore();
    }
  });

  test("a $500 rule fires on exactly $500 and stays quiet at $499.99", async () => {
    const s = await devDirectorSetup();
    await saveRule(s.as, { minAmountCents: 50_000 });
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET, async () => {
        await addGift(s.as, {
          amountCents: 49_999,
          name: "Under",
          email: "under@example.com",
        });
      });
      expect(cap.sent).toHaveLength(0);

      await atClock(s.t, MON_8AM_ET, async () => {
        await addGift(s.as, {
          amountCents: 50_000,
          name: "Exactly",
          email: "exactly@example.com",
        });
      });
      expect(cap.sent).toHaveLength(1);
      expect(cap.sent[0].subject).toContain("Exactly");
    } finally {
      cap.restore();
    }
  });

  test("a chapter rule ignores a central gift", async () => {
    const s = await devDirectorSetup();
    await saveRule(s.as, { scope: s.chapterId });
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET, async () => {
        await addGift(s.as, { scope: "central" });
      });
      expect(cap.sent).toHaveLength(0);

      await atClock(s.t, MON_8AM_ET, async () => {
        await addGift(s.as, { scope: s.chapterId, name: "Chapter Giver" });
      });
      expect(cap.sent).toHaveLength(1);
    } finally {
      cap.restore();
    }
  });

  test("two overlapping rules send one person ONE email, naming both", async () => {
    const s = await devDirectorSetup();
    await saveRule(s.as, {
      name: "Every gift",
      scope: "all",
      recipients: ["shay@publicworship.life", "team@publicworship.life"],
    });
    await saveRule(s.as, {
      name: "Big gifts",
      scope: "central",
      minAmountCents: 50_000,
      recipients: ["shay@publicworship.life", "aj@publicworship.life"],
    });
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET, async () => {
        await addGift(s.as, { amountCents: 90_000 });
      });
      // Three people, three emails — Shay is on both rules and gets ONE.
      expect(cap.sent.map((e) => e.to).sort()).toEqual([
        "aj@publicworship.life",
        "shay@publicworship.life",
        "team@publicworship.life",
      ]);
      const shay = cap.sent.find((e) => e.to === "shay@publicworship.life")!;
      expect(shay.html).toContain("Every gift, Big gifts");
    } finally {
      cap.restore();
    }
  });

  test("a deactivated rule sends nothing", async () => {
    const s = await devDirectorSetup();
    const ruleId = await saveRule(s.as);
    await s.as.mutation(api.givingNotifications.setRuleActive, {
      ruleId,
      isActive: false,
    });
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET, async () => {
        await addGift(s.as);
      });
      expect(cap.sent).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });

  test("an in-kind gift notifies too, and is labelled as in-kind", async () => {
    const s = await devDirectorSetup();
    await saveRule(s.as);
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET, async () => {
        await addGift(s.as, { method: "in_kind", amountCents: 84_303 });
      });
      expect(cap.sent).toHaveLength(1);
      expect(cap.sent[0].html).toContain("In-kind");
      expect(cap.sent[0].subject).toContain("$843.03");
    } finally {
      cap.restore();
    }
  });

  test("a gift bundled into a TICKET purchase notifies, and says so", async () => {
    const s = await devDirectorSetup();
    await saveRule(s.as);
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET, async () => {
        await run(s.t, async (ctx) => {
          const eventTypeId = await ctx.db.insert("eventTypes", {
            chapterId: s.chapterId,
            name: "Gathering",
            slug: "gathering",
            version: 1,
            createdBy: s.userId,
            updatedAt: Date.now(),
            createdAt: Date.now(),
          });
          const eventId = await ctx.db.insert("events", {
            chapterId: s.chapterId,
            eventTypeId,
            templateVersion: 1,
            name: "Field Day",
            eventDate: Date.now(),
            status: "planning",
            createdBy: s.userId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          const rsvpId = await ctx.db.insert("rsvps", {
            eventId,
            chapterId: s.chapterId,
            name: "Tick Etholder",
            email: "tick@example.com",
            status: "going",
            token: "tok-ticket",
            source: "ticket",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          await ctx.db.insert("ticketOrders", {
            chapterId: s.chapterId,
            eventId,
            name: "Tick Etholder",
            email: "tick@example.com",
            items: [],
            totalCents: 3_000,
            donationCents: 2_000,
            currency: "usd",
            status: "paid",
            rsvpId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          const donationId = await ctx.db.insert("donations", {
            chapterId: s.chapterId,
            eventId,
            name: "Tick Etholder",
            email: "tick@example.com",
            amountCents: 2_000,
            currency: "usd",
            method: "card",
            status: "paid",
            rsvpId,
            createdAt: Date.now(),
          });
          const donation = await ctx.db.get(donationId);
          if (donation) await dualWriteGiftForDonation(ctx, donation);
        });
      });
      expect(cap.sent).toHaveLength(1);
      expect(cap.sent[0].subject).toContain("$20.00");
      expect(cap.sent[0].html).toContain("Added to a ticket purchase");
      expect(cap.sent[0].html).toContain("Field Day");
    } finally {
      cap.restore();
    }
  });

  test("a backdated gift still notifies, but stops claiming money just moved", async () => {
    const s = await devDirectorSetup();
    await saveRule(s.as);
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET, async () => {
        await addGift(s.as, {
          amountCents: 50_000,
          name: "Late Cheque",
          email: "late@example.com",
          // A cheque that arrived a year ago, entered today.
          receivedAt: MON_8AM_ET - 365 * DAY_MS,
        });
      });
      // Sent — a gift the desk just learned about is exactly what someone
      // wants to thank a donor for, however old the cheque is. Suppressing it
      // would be a silence nobody could see.
      expect(cap.sent).toHaveLength(1);
      expect(cap.sent[0].subject).toBe(
        "Backdated gift recorded: $500.00 from Late Cheque — Central",
      );
      expect(cap.sent[0].html).toContain("A backdated gift was recorded");
      expect(cap.sent[0].html).toContain("recorded later, not today");
    } finally {
      cap.restore();
    }
  });

  test("a gift received this week still reads as an arrival", async () => {
    const s = await devDirectorSetup();
    await saveRule(s.as);
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET, async () => {
        await addGift(s.as, {
          amountCents: 50_000,
          name: "Recent Cheque",
          email: "recent@example.com",
          receivedAt: MON_8AM_ET - 2 * DAY_MS,
        });
      });
      expect(cap.sent).toHaveLength(1);
      expect(cap.sent[0].subject).toBe("$500.00 from Recent Cheque — Central");
      expect(cap.sent[0].html).toContain("A gift just came in");
    } finally {
      cap.restore();
    }
  });

  test("a failing email cannot cost the gift", async () => {
    const s = await devDirectorSetup();
    await saveRule(s.as);
    const realFetch = globalThis.fetch;
    const prevKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "resend_test_key";
    globalThis.fetch = (async () => {
      throw new Error("Resend is down");
    }) as unknown as typeof fetch;
    try {
      let giftId: Id<"gifts"> | null = null;
      await atClock(s.t, MON_8AM_ET, async () => {
        const res = await addGift(s.as, { amountCents: 50_000 });
        giftId = res.giftId;
      });
      // The gift, the donor rollups and the scope aggregate all survived the
      // outage — the notification is downstream of the money, never in it.
      const gift = await run(s.t, (ctx) => ctx.db.get(giftId as Id<"gifts">));
      expect(gift?.amountCents).toBe(50_000);
      const donor = await run(s.t, (ctx) => ctx.db.get(gift!.donorId));
      expect(donor?.lifetimeCents).toBe(50_000);
      expect(donor?.giftCount).toBe(1);
      const rollup = await run(s.t, (ctx) =>
        ctx.db
          .query("givingScopeRollups")
          .withIndex("by_scope", (q) => q.eq("scope", "central"))
          .unique(),
      );
      expect(rollup?.lifetimeCents).toBe(50_000);
    } finally {
      globalThis.fetch = realFetch;
      if (prevKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevKey;
    }
  });

  test("degrades to a no-op without RESEND_API_KEY", async () => {
    const s = await devDirectorSetup();
    await saveRule(s.as);
    const prev = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      let giftId: Id<"gifts"> | null = null;
      await atClock(s.t, MON_8AM_ET, async () => {
        const res = await addGift(s.as);
        giftId = res.giftId;
      });
      // Zero DELIVERED, not zero attempted — `sendEmailReporting` reports the
      // real outcome, so a keyless deployment can't look like it mailed anyone.
      await expect(
        s.t.action(internal.givingNotifications.notifyGiftRecorded, {
          giftId: giftId as unknown as Id<"gifts">,
        }),
      ).resolves.toEqual({ emailsSent: 0 });
    } finally {
      if (prev === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prev;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bulk writes are demoted to the digest, never silenced
// ═══════════════════════════════════════════════════════════════════════════

describe("bulk writes do not blast the inbox", () => {
  test("a 25-row CSV import sends ZERO immediate emails, while one desk gift still sends one", async () => {
    const s = await devDirectorSetup();
    await atClock(s.t, SETUP_AT, async () => {
      await saveRule(s.as, { recipients: ["development-team@publicworship.life"] });
    });
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET - 60_000, async () => {
        await s.as.mutation(api.givingImport.importCanonical, {
          scope: "central",
          rows: Array.from({ length: 25 }, (_, i) => ({
            rowType: "gift" as const,
            name: `Historical Donor ${i}`,
            email: `historical${i}@example.com`,
            amountCents: 10_000 + i,
            receivedAt: MON_8AM_ET - (400 + i) * DAY_MS,
            externalRef: `gb_hist_${i}`,
          })),
        });
      });
      // The whole point: an import is one operation, not 25 notifications.
      expect(cap.sent).toHaveLength(0);

      // …and the default is still SAFE — a single gift down the ordinary desk
      // path notifies without anyone having to remember a flag.
      await atClock(s.t, MON_8AM_ET - 30_000, async () => {
        await addGift(s.as, {
          amountCents: 50_000,
          name: "Live Giver",
          email: "live@example.com",
        });
      });
      expect(cap.sent).toHaveLength(1);
      expect(cap.sent[0].subject).toContain("Live Giver");
    } finally {
      cap.restore();
    }
  });

  test("the imported gifts are DEMOTED, not silenced — the digest still counts every one", async () => {
    const s = await devDirectorSetup();
    await atClock(s.t, SETUP_AT, async () => {
      await saveRule(s.as, { cadence: "daily", sendHourLocal: 8 });
    });
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET - 60_000, async () => {
        await s.as.mutation(api.givingImport.importCanonical, {
          scope: "central",
          rows: Array.from({ length: 4 }, (_, i) => ({
            rowType: "gift" as const,
            name: `Historical Donor ${i}`,
            email: `hist${i}@example.com`,
            amountCents: 10_000,
            receivedAt: MON_8AM_ET - (400 + i) * DAY_MS,
            externalRef: `gb_d_${i}`,
          })),
        });
      });
      expect(cap.sent).toHaveLength(0);

      await atClock(s.t, MON_8AM_ET, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      expect(cap.sent).toHaveLength(1);
      // One correctly-totalled email instead of four — and nothing lost.
      expect(cap.sent[0].subject).toBe(
        "$400.00 from 4 gifts this day — All books",
      );
      expect(cap.sent[0].html).toContain("Historical Donor 0");
    } finally {
      cap.restore();
    }
  });

  test("splitting a gift re-announces nothing — the money already arrived once", async () => {
    const s = await devDirectorSetup();
    await saveRule(s.as);
    const cap = captureEmails();
    try {
      let giftId!: Id<"gifts">;
      await atClock(s.t, MON_8AM_ET, async () => {
        const res = await addGift(s.as, {
          amountCents: 100_000,
          name: "Split Source",
          email: "split@example.com",
        });
        giftId = res.giftId;
      });
      expect(cap.sent).toHaveLength(1); // the original arrival, announced once
      cap.sent.length = 0;

      await atClock(s.t, MON_8AM_ET, async () => {
        await s.as.mutation(api.givingPlatform.splitGift, {
          giftId,
          parts: [
            { scope: "central", amountCents: 60_000 },
            { scope: "central", amountCents: 40_000 },
          ],
          why: "Two designations bundled in one wire.",
        });
      });
      expect(cap.sent).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The cut-window machinery
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Raw `gifts` inserts, on purpose. Everywhere else these tests go through
 * `recordGiftForDonor` because the rollups matter; here they don't — the window
 * reader touches `gifts` and (for the display list) `donors`, and nothing else.
 * Going through the real helper for a thousand rows would test the rollup
 * machinery at length and the thing under test not at all.
 */
async function seedRawGifts(
  s: ChapterSetup,
  donorId: Id<"donors">,
  specs: Array<{ createdAt: number; amountCents?: number; scope?: unknown }>,
): Promise<void> {
  await run(s.t, async (ctx) => {
    for (const spec of specs) {
      await ctx.db.insert("gifts", {
        donorId,
        scope: (spec.scope ?? "central") as "central",
        amountCents: spec.amountCents ?? 1_000,
        currency: "usd",
        receivedAt: spec.createdAt,
        method: "stripe",
        createdAt: spec.createdAt,
      });
    }
  });
}

async function seedDonor(s: ChapterSetup, name = "Bulk Donor"): Promise<Id<"donors">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("donors", {
      scope: "central",
      kind: "individual",
      name,
      status: "prospect",
      lifetimeCents: 0,
      giftCount: 0,
      createdAt: Date.now(),
    }),
  );
}

/** The rule shape `collectWindowGifts` actually reads. */
const ALL_SCOPE_RULE = { isActive: true, scope: "all" as const };

describe("collectWindowGifts — the cap, the drain, and where the window closes", () => {
  test("stops at the match cap and closes the window on the last gift it read", async () => {
    const s = await devDirectorSetup();
    const donorId = await seedDonor(s);
    // Ten gifts, one per millisecond, so there is no tie to drain.
    await seedRawGifts(
      s,
      donorId,
      Array.from({ length: 10 }, (_, i) => ({ createdAt: 1_000 + i })),
    );

    const out = await run(s.t, (ctx) =>
      collectWindowGifts(ctx, ALL_SCOPE_RULE, 0, 2_000, {
        maxMatches: 3,
        maxScan: 999,
      }),
    );
    expect(out.gifts).toHaveLength(3);
    expect(out.truncated).toBe(true);
    // The window closes ON the third gift (createdAt 1002), never past it —
    // the next window opens strictly after, so nothing between is skipped.
    expect(out.until).toBe(1_002);
  });

  test("drains the whole millisecond it stopped in, stragglers included", async () => {
    const s = await devDirectorSetup();
    const donorId = await seedDonor(s);
    // Three gifts share ms 1002 — an import writes many per millisecond. The
    // cap falls on the FIRST of them; the other two must still come back, or
    // the next window (which opens strictly after 1002) would skip them.
    await seedRawGifts(s, donorId, [
      { createdAt: 1_000 },
      { createdAt: 1_001 },
      { createdAt: 1_002, amountCents: 111 },
      { createdAt: 1_002, amountCents: 222 },
      { createdAt: 1_002, amountCents: 333 },
      { createdAt: 1_003 },
      { createdAt: 1_004 },
    ]);

    const out = await run(s.t, (ctx) =>
      collectWindowGifts(ctx, ALL_SCOPE_RULE, 0, 2_000, {
        maxMatches: 3,
        maxScan: 999,
      }),
    );
    expect(out.until).toBe(1_002);
    expect(out.truncated).toBe(true);
    // 5 = the two before the boundary + all three sharing it. Not 3.
    expect(out.gifts).toHaveLength(5);
    expect(out.gifts.filter((g) => g.createdAt === 1_002)).toHaveLength(3);
  });

  test("hitting the cap on the very LAST row is not a truncation", async () => {
    const s = await devDirectorSetup();
    const donorId = await seedDonor(s);
    await seedRawGifts(s, donorId, [
      { createdAt: 1_000 },
      { createdAt: 1_001 },
      { createdAt: 1_002 },
    ]);

    // The cap is exactly the number of rows in the range: the read finished.
    const out = await run(s.t, (ctx) =>
      collectWindowGifts(ctx, ALL_SCOPE_RULE, 0, 2_000, {
        maxMatches: 3,
        maxScan: 999,
      }),
    );
    expect(out.gifts).toHaveLength(3);
    expect(out.truncated).toBe(false);
    // …and the window closes where it was ASKED to, not on the last row.
    expect(out.until).toBe(2_000);
  });

  test("the scan cap bounds a rule that matches almost nothing", async () => {
    const s = await devDirectorSetup();
    const donorId = await seedDonor(s);
    await seedRawGifts(
      s,
      donorId,
      Array.from({ length: 20 }, (_, i) => ({ createdAt: 1_000 + i, amountCents: 100 })),
    );

    // A $500 floor nothing meets — the read still has to stop.
    const out = await run(s.t, (ctx) =>
      collectWindowGifts(
        ctx,
        { isActive: true, scope: "all", minAmountCents: 50_000 },
        0,
        2_000,
        { maxMatches: 999, maxScan: 5 },
      ),
    );
    expect(out.gifts).toHaveLength(0);
    expect(out.truncated).toBe(true);
    expect(out.until).toBe(1_004); // the 5th row
  });

  test("a scoped rule reads its OWN book, so another book's volume can't cut it short", async () => {
    const s = await devDirectorSetup();
    const donorId = await seedDonor(s);
    // 30 central gifts, then 2 for the chapter. On the global index a
    // chapter rule with a small scan cap would stop inside the central prefix
    // and cry "cut short" about a book that had two quiet gifts.
    await seedRawGifts(
      s,
      donorId,
      Array.from({ length: 30 }, (_, i) => ({ createdAt: 1_000 + i })),
    );
    await seedRawGifts(s, donorId, [
      { createdAt: 1_100, scope: s.chapterId },
      { createdAt: 1_101, scope: s.chapterId },
    ]);

    const out = await run(s.t, (ctx) =>
      collectWindowGifts(
        ctx,
        { isActive: true, scope: s.chapterId },
        0,
        2_000,
        { maxMatches: 999, maxScan: 5 },
      ),
    );
    expect(out.gifts).toHaveLength(2);
    expect(out.truncated).toBe(false);
  });
});

describe("a real over-cap window, end to end", () => {
  test("cuts short, says so, and the NEXT run resumes exactly where it stopped", async () => {
    const s = await devDirectorSetup();
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, SETUP_AT, async () => {
      ruleId = await saveRule(s.as, { cadence: "daily", sendHourLocal: 8 });
    });
    const donorId = await seedDonor(s, "Imported Donor");

    // Genuinely past the production cap — no injected limits here.
    const total = MAX_DIGEST_MATCHES + 40;
    const base = MON_8AM_ET - 6 * 60 * 60 * 1000;
    await seedRawGifts(
      s,
      donorId,
      Array.from({ length: total }, (_, i) => ({
        createdAt: base + i,
        amountCents: 1_000,
      })),
    );

    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET, async () => {
        const out = await s.t.action(
          internal.givingNotificationDigests.sendGivingDigests,
          {},
        );
        expect(out).toMatchObject({ digestsSent: 1, emailsSent: 1 });
      });
      expect(cap.sent).toHaveLength(1);
      // The first pass reports exactly the cap, and says the total is a floor.
      expect(cap.sent[0].subject).toContain(
        `from ${MAX_DIGEST_MATCHES} gifts this day`,
      );
      expect(cap.sent[0].html).toContain("FLOOR");
      expect(cap.sent[0].html).toContain(
        "carries on from exactly where this one stopped",
      );

      const afterFirst = await run(s.t, (ctx) => ctx.db.get(ruleId));
      // Closed ON the last gift read, not at `now` — the remainder is still
      // ahead of the watermark rather than behind it.
      expect(afterFirst?.lastSentAt).toBe(base + MAX_DIGEST_MATCHES - 1);
      // …and the run mark is CLEARED, so the drain continues within the day
      // instead of waiting until tomorrow.
      expect(afterFirst?.lastRunDayKey).toBeUndefined();
      cap.sent.length = 0;

      // An hour later the sweep picks up exactly the 40 it left behind.
      await atClock(s.t, MON_8AM_ET + 60 * 60 * 1000, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      expect(cap.sent).toHaveLength(1);
      expect(cap.sent[0].subject).toContain("from 40 gifts this day");
      expect(cap.sent[0].html).not.toContain("FLOOR");

      const afterSecond = await run(s.t, (ctx) => ctx.db.get(ruleId));
      // Caught up: the window is complete, so the rule marks itself done today.
      expect(afterSecond?.lastRunDayKey).toBe(localParts(MON_8AM_ET).dayKey);
    } finally {
      cap.restore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Digests
// ═══════════════════════════════════════════════════════════════════════════

describe("digests", () => {
  test("an empty DAILY digest sends nothing and leaves the watermark alone", async () => {
    const s = await devDirectorSetup();
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, SETUP_AT, async () => {
      ruleId = await saveRule(s.as, { cadence: "daily", sendHourLocal: 8 });
    });
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET, async () => {
        const out = await s.t.action(
          internal.givingNotificationDigests.sendGivingDigests,
          {},
        );
        expect(out).toMatchObject({ digestsSent: 0, emailsSent: 0 });
      });
      expect(cap.sent).toHaveLength(0);
      const row = await run(s.t, (ctx) => ctx.db.get(ruleId));
      // The WATERMARK stays put so the window carries forward…
      expect(row?.lastSentAt).toBeUndefined();
      // …but the rule is marked RUN, so `>=`-hour matching doesn't re-scan it
      // on every remaining hour of the day.
      expect(row?.lastRunDayKey).toBe(localParts(MON_8AM_ET).dayKey);
    } finally {
      cap.restore();
    }
  });

  test("an empty WEEKLY digest is sent anyway, and stamps", async () => {
    const s = await devDirectorSetup();
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, SETUP_AT, async () => {
      ruleId = await saveRule(s.as, {
        name: "Weekly roundup",
        cadence: "weekly",
        sendHourLocal: 8,
        sendWeekday: 1,
      });
    });
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      expect(cap.sent).toHaveLength(1);
      expect(cap.sent[0].subject).toContain("No giving this week");
      const row = await run(s.t, (ctx) => ctx.db.get(ruleId));
      // A minute behind `now` — the window closes early so a gift committing
      // mid-run lands in the NEXT window rather than behind the watermark.
      expect(row?.lastSentAt).toBe(MON_8AM_ET - 60_000);
    } finally {
      cap.restore();
    }
  });

  test("a daily digest totals the window, calls out the largest gift, and breaks it down", async () => {
    const s = await devDirectorSetup();
    await atClock(s.t, SETUP_AT, async () => {
      await saveRule(s.as, {
        name: "Daily roundup",
        cadence: "daily",
        sendHourLocal: 8,
        recipients: ["dev@publicworship.life"],
      });
    });
    const cap = captureEmails();
    try {
      // Gifts land the day before, inside the window the 8am run will read.
      await atClock(s.t, MON_8AM_ET - 6 * 60 * 60 * 1000, async () => {
        await addGift(s.as, { amountCents: 120_000, name: "Big Giver" });
        await addGift(s.as, {
          amountCents: 2_500,
          name: "Small Giver",
          email: "small@example.com",
          method: "cash",
          scope: s.chapterId,
        });
      });
      cap.sent.length = 0; // drop the immediate-path noise, if any

      await atClock(s.t, MON_8AM_ET, async () => {
        const out = await s.t.action(
          internal.givingNotificationDigests.sendGivingDigests,
          {},
        );
        expect(out).toMatchObject({ digestsSent: 1, emailsSent: 1 });
      });
      const mail = cap.sent[0];
      expect(mail.subject).toBe("$1,225.00 from 2 gifts this day — All books");
      expect(mail.html).toContain("Big Giver");
      expect(mail.html).toContain("Small Giver");
      expect(mail.html).toContain("New York");
      expect(mail.html).toContain("Central");
      expect(mail.html).toContain("Cash");
    } finally {
      cap.restore();
    }
  });

  test("running the sweep twice in the same hour sends once", async () => {
    const s = await devDirectorSetup();
    await atClock(s.t, SETUP_AT, async () => {
      await saveRule(s.as, { cadence: "weekly", sendHourLocal: 8, sendWeekday: 1 });
    });
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      expect(cap.sent).toHaveLength(1);
    } finally {
      cap.restore();
    }
  });

  test("a gift already reported is not reported again the next day", async () => {
    const s = await devDirectorSetup();
    await atClock(s.t, SETUP_AT, async () => {
      await saveRule(s.as, { cadence: "daily", sendHourLocal: 8 });
    });
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET - 60_000, async () => {
        await addGift(s.as, { amountCents: 10_000, name: "Monday Giver" });
      });
      cap.sent.length = 0;

      await atClock(s.t, MON_8AM_ET, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      expect(cap.sent).toHaveLength(1);
      expect(cap.sent[0].html).toContain("Monday Giver");
      cap.sent.length = 0;

      // Tuesday: the window opens at Monday's watermark, so Monday's gift is
      // behind it — and with nothing new, an empty daily is skipped entirely.
      await atClock(s.t, TUE_8AM_ET, async () => {
        const out = await s.t.action(
          internal.givingNotificationDigests.sendGivingDigests,
          {},
        );
        expect(out).toMatchObject({ digestsSent: 0, emailsSent: 0 });
      });
      expect(cap.sent).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });

  test("a chapter-scoped digest counts only that chapter's giving", async () => {
    const s = await devDirectorSetup();
    await atClock(s.t, SETUP_AT, async () => {
      await saveRule(s.as, {
        name: "New York daily",
        cadence: "daily",
        sendHourLocal: 8,
        scope: s.chapterId,
      });
    });
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET - 60_000, async () => {
        await addGift(s.as, { amountCents: 90_000, name: "Central Giver" });
        await addGift(s.as, {
          amountCents: 4_000,
          name: "NY Giver",
          email: "ny@example.com",
          scope: s.chapterId,
        });
      });
      cap.sent.length = 0;

      await atClock(s.t, MON_8AM_ET, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      expect(cap.sent).toHaveLength(1);
      expect(cap.sent[0].subject).toBe("$40.00 from 1 gift this day — New York");
      expect(cap.sent[0].html).toContain("NY Giver");
      expect(cap.sent[0].html).not.toContain("Central Giver");
    } finally {
      cap.restore();
    }
  });

  test("a complete window is never reported as cut, and stamps normally", async () => {
    const s = await devDirectorSetup();
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, SETUP_AT, async () => {
      ruleId = await saveRule(s.as, { cadence: "daily", sendHourLocal: 8 });
    });
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET - 60_000, async () => {
        await addGift(s.as, { amountCents: 10_000, name: "In Window" });
      });
      cap.sent.length = 0;

      await atClock(s.t, MON_8AM_ET, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      expect(cap.sent).toHaveLength(1);
      expect(cap.sent[0].html).not.toContain("cut short");
      const row = await run(s.t, (ctx) => ctx.db.get(ruleId));
      // The watermark lands where the window CLOSED, which is a minute behind
      // `now` (the commit-race lag), never ahead of what was actually read.
      expect(row?.lastSentAt).toBeLessThanOrEqual(MON_8AM_ET);
      expect(row?.lastSentAt).toBeGreaterThan(MON_8AM_ET - 2 * 60_000);
      expect(row?.lastRunDayKey).toBe(localParts(MON_8AM_ET).dayKey);
    } finally {
      cap.restore();
    }
  });

  test("a truncated digest says its total is a floor and promises the rest", () => {
    const { subject, html } = renderDigestEmail({
      ruleName: "Daily roundup",
      cadence: "daily",
      scopeLabel: "All books",
      periodStart: MON_8AM_ET - DAY_MS,
      periodEnd: MON_8AM_ET,
      totalCents: 0,
      giftCount: 0,
      largest: null,
      byScope: [],
      byMethod: [],
      gifts: [],
      omittedCount: 0,
      countTruncated: true,
    });
    // Critically it must NOT claim "no giving" — the read stopped short.
    expect(subject).toBe("Giving digest cut short — All books");
    expect(html).not.toContain("No gifts came in");
    expect(html).toContain("carries on from where this one stopped");
  });

  test("one rule blowing up doesn't cost the other rules their digest", async () => {
    const s = await devDirectorSetup();
    await atClock(s.t, SETUP_AT, async () => {
      await saveRule(s.as, {
        name: "Weekly A",
        cadence: "weekly",
        sendHourLocal: 8,
        sendWeekday: 1,
        recipients: ["a@publicworship.life"],
      });
      await saveRule(s.as, {
        name: "Weekly B",
        cadence: "weekly",
        sendHourLocal: 8,
        sendWeekday: 1,
        recipients: ["b@publicworship.life"],
      });
      await saveRule(s.as, {
        name: "Weekly C",
        cadence: "weekly",
        sendHourLocal: 8,
        sendWeekday: 1,
        recipients: ["c@publicworship.life"],
      });
    });

    // Blow up on the FIRST send. Without a per-rule try the whole action dies
    // here, and B and C would be stamped-but-never-mailed — permanently, since
    // Convex does not retry a failed scheduled action.
    const realFetch = globalThis.fetch;
    const prevKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "resend_test_key";
    const sent: string[] = [];
    let calls = 0;
    globalThis.fetch = (async (_u: string, init?: { body?: string }) => {
      calls++;
      const body = init?.body ? JSON.parse(init.body) : {};
      if (calls === 1) throw new Error("Resend blew up on the first send");
      sent.push(body.to);
      return { ok: true, status: 200, text: async () => "{}" };
    }) as unknown as typeof fetch;

    try {
      let out!: {
        digestsSent: number;
        emailsSent: number;
        failedRules: number;
      };
      await atClock(s.t, MON_8AM_ET, async () => {
        out = await s.t.action(
          internal.givingNotificationDigests.sendGivingDigests,
          {},
        );
      });
      // Two of the three landed; only the one that threw was affected.
      expect(out.digestsSent).toBe(2);
      expect(out.failedRules).toBe(1);
      expect(sent.sort()).toEqual(["b@publicworship.life", "c@publicworship.life"]);

      // And the one that reached NOBODY gave its window back — an outage must
      // not consume a period that was never actually reported.
      const rules = await run(s.t, (ctx) =>
        ctx.db.query("givingNotificationRules").collect(),
      );
      const failed = rules.find((r) => r.recipients[0] === "a@publicworship.life");
      expect(failed?.lastSentAt).toBeUndefined();
      expect(failed?.lastRunDayKey).toBeUndefined();
      // …while the two that did land kept theirs.
      const landed = rules.find((r) => r.recipients[0] === "b@publicworship.life");
      expect(landed?.lastSentAt).toBe(MON_8AM_ET - 60_000);
    } finally {
      globalThis.fetch = realFetch;
      if (prevKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevKey;
    }
  });

  test("reactivating a dormant rule does not replay the dormant period", async () => {
    const s = await devDirectorSetup();
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, SETUP_AT, async () => {
      ruleId = await saveRule(s.as, { cadence: "daily", sendHourLocal: 8 });
    });

    const cap = captureEmails();
    try {
      // Switched off, then months of giving happens behind its back.
      await atClock(s.t, MON_8AM_ET - 90 * DAY_MS, async () => {
        await s.as.mutation(api.givingNotifications.setRuleActive, {
          ruleId,
          isActive: false,
        });
      });
      await atClock(s.t, MON_8AM_ET - 60 * DAY_MS, async () => {
        await addGift(s.as, { amountCents: 900_000, name: "Dormant Era" });
      });

      // Switched back on the day before the next digest.
      await atClock(s.t, MON_8AM_ET - DAY_MS, async () => {
        await s.as.mutation(api.givingNotifications.setRuleActive, {
          ruleId,
          isActive: true,
        });
      });
      const row = await run(s.t, (ctx) => ctx.db.get(ruleId));
      expect(row?.lastSentAt).toBe(MON_8AM_ET - DAY_MS);
      cap.sent.length = 0;

      await atClock(s.t, MON_8AM_ET, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      // Nothing arrived since it came back, so an empty daily is skipped — and
      // crucially the 90 days of donor records it was switched off for are NOT
      // mailed out in one go.
      expect(cap.sent).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });

  test("with no Resend key the sweep claims NOTHING — the backlog survives", async () => {
    const s = await devDirectorSetup();
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, SETUP_AT, async () => {
      ruleId = await saveRule(s.as, { cadence: "daily", sendHourLocal: 8 });
    });
    // A gift lands, then the sweep runs on a deployment nobody configured.
    await atClock(s.t, MON_8AM_ET - 60_000, async () => {
      await addGift(s.as, { amountCents: 70_000, name: "Unmailed Era" });
    });

    const prev = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      await atClock(s.t, MON_8AM_ET, async () => {
        const out = await s.t.action(
          internal.givingNotificationDigests.sendGivingDigests,
          {},
        );
        expect(out).toMatchObject({
          digestsSent: 0,
          emailsSent: 0,
          skippedNoMailer: true,
        });
      });
      // NOTHING moved. `sendEmailReporting` returns false rather than throwing
      // when no key resolves, so advancing here would have quietly consumed
      // every window daily — and the day a key was finally configured, every
      // gift behind those watermarks would have been un-digested forever.
      // (`lastRunDayKey` still holds the rule's CREATE-day suppression mark,
      // which the sweep must not have touched either.)
      const row = await run(s.t, (ctx) => ctx.db.get(ruleId));
      expect(row?.lastSentAt).toBeUndefined();
      expect(row?.lastRunDayKey).toBe(localParts(SETUP_AT).dayKey);
    } finally {
      if (prev === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prev;
    }

    // Configure the key and the backlog is still there to send.
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET + 60 * 60 * 1000, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      expect(cap.sent).toHaveLength(1);
      expect(cap.sent[0].html).toContain("Unmailed Era");
    } finally {
      cap.restore();
    }
  });

  test("a weekly rule created after its send hour doesn't open with a false 'no giving'", async () => {
    const s = await devDirectorSetup();
    const cap = captureEmails();
    try {
      // Written at 9am Monday, wanting Mondays at 8am — its send moment has
      // already gone, and its window could only ever open at its own birth.
      await atClock(s.t, MON_9AM_ET, async () => {
        await saveRule(s.as, {
          name: "Weekly roundup",
          cadence: "weekly",
          sendHourLocal: 8,
          sendWeekday: 1,
        });
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      // Silence, not a confident report about a week nobody was watching.
      expect(cap.sent).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });

  test("a daily rule created BEFORE its send hour still fires that day", async () => {
    const s = await devDirectorSetup();
    const cap = captureEmails();
    try {
      const sixAm = MON_8AM_ET - 2 * 60 * 60 * 1000;
      await atClock(s.t, sixAm, async () => {
        await saveRule(s.as, { cadence: "daily", sendHourLocal: 8 });
      });
      // …and a gift arrives after it, which is the only way round: the window
      // opens strictly AFTER the rule's own birth instant.
      await atClock(s.t, sixAm + 30 * 60 * 1000, async () => {
        await addGift(s.as, { amountCents: 25_000, name: "Early Bird" });
      });
      cap.sent.length = 0;
      await atClock(s.t, MON_8AM_ET, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      // That window is genuine, so suppression must NOT have applied.
      expect(cap.sent).toHaveLength(1);
      expect(cap.sent[0].html).toContain("Early Bird");
    } finally {
      cap.restore();
    }
  });

  test("a cadence round-trip doesn't replay the dormant stretch", async () => {
    const s = await devDirectorSetup();
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, SETUP_AT, async () => {
      ruleId = await saveRule(s.as, { cadence: "daily", sendHourLocal: 8 });
    });
    const cap = captureEmails();
    try {
      // daily → immediate → daily, with months of giving in between. Without
      // resetting the marks on a cadence change this reached the same replay
      // `setRuleActive` was fixed for, by another door.
      await atClock(s.t, MON_8AM_ET - 90 * DAY_MS, async () => {
        await saveRule(s.as, { ruleId, cadence: "immediate" });
      });
      await atClock(s.t, MON_8AM_ET - 60 * DAY_MS, async () => {
        await addGift(s.as, { amountCents: 900_000, name: "Dormant Era" });
      });
      await atClock(s.t, MON_8AM_ET - DAY_MS, async () => {
        await saveRule(s.as, { ruleId, cadence: "daily", sendHourLocal: 8 });
      });
      const row = await run(s.t, (ctx) => ctx.db.get(ruleId));
      expect(row?.lastSentAt).toBe(MON_8AM_ET - DAY_MS);
      cap.sent.length = 0;

      await atClock(s.t, MON_8AM_ET, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      expect(cap.sent).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });

  test("a digest whose hour hasn't come round does nothing", async () => {
    const s = await devDirectorSetup();
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, SETUP_AT, async () => {
      // 18:00 local is genuinely still ahead at 09:00 — unlike 08:00, which a
      // `>=` match would (correctly) treat as a catch-up.
      ruleId = await saveRule(s.as, { cadence: "weekly", sendHourLocal: 18, sendWeekday: 1 });
    });
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_9AM_ET, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      expect(cap.sent).toHaveLength(0);
      const row = await run(s.t, (ctx) => ctx.db.get(ruleId));
      expect(row?.lastSentAt).toBeUndefined();
    } finally {
      cap.restore();
    }
  });
});
