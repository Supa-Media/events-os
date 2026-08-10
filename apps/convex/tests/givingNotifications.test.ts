import { afterEach, describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runSeedSeatDefs } from "../migrations/0022_seed_seat_defs";
import type { Doc, Id } from "../_generated/dataModel";
import { dualWriteGiftForDonation } from "../lib/givingDonors";
import {
  digestWindowStart,
  isDigestDue,
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

  test("a daily rule is due at its local hour and not an hour later", () => {
    const daily = rule({ cadence: "daily" });
    expect(isDigestDue(daily, MON_8AM_ET)).toBe(true);
    expect(isDigestDue(daily, MON_9AM_ET)).toBe(false);
  });

  test("the local hour is Eastern in January too, not a fixed UTC offset", () => {
    expect(isDigestDue(rule({ cadence: "daily" }), WINTER_MON_8AM_ET)).toBe(true);
  });

  test("a rule already stamped today is not due again", () => {
    const daily = rule({ cadence: "daily", lastSentAt: MON_8AM_ET });
    expect(isDigestDue(daily, MON_8AM_ET)).toBe(false);
    expect(isDigestDue(daily, TUE_8AM_ET)).toBe(true);
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
      await expect(
        s.t.action(internal.givingNotifications.notifyGiftRecorded, {
          giftId: giftId as unknown as Id<"gifts">,
        }),
      ).resolves.toEqual({ emailsSent: 1 });
    } finally {
      if (prev === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prev;
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
        expect(out).toEqual({ digestsSent: 0, emailsSent: 0 });
      });
      expect(cap.sent).toHaveLength(0);
      const row = await run(s.t, (ctx) => ctx.db.get(ruleId));
      expect(row?.lastSentAt).toBeUndefined();
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
      expect(row?.lastSentAt).toBe(MON_8AM_ET);
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
        expect(out).toEqual({ digestsSent: 1, emailsSent: 1 });
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
        expect(out).toEqual({ digestsSent: 0, emailsSent: 0 });
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

  test("a digest whose hour hasn't come round does nothing", async () => {
    const s = await devDirectorSetup();
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, SETUP_AT, async () => {
      ruleId = await saveRule(s.as, { cadence: "weekly", sendHourLocal: 8, sendWeekday: 1 });
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
