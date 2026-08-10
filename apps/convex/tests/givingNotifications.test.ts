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
  SEND_NOW_MAX_PER_RULE,
  collectWindowGifts,
} from "../givingNotificationDigests";
import { GIFT_TYPE_LABELS, giftType } from "../lib/giftLabels";

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

/**
 * Well before any digest window under test.
 *
 * `createdAt` is NOT a window bound — `digestWindowStart` gives a rule that has
 * never reported exactly one trailing period regardless of when it was written
 * (see the pure tests). What this distance buys is the SCHEDULING half: a rule
 * created three days before its run is past `firstRunDayKey`'s same-day
 * suppression, so it is genuinely due on the day the test fires it.
 */
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

  test("a rule running on schedule opens exactly at its watermark", () => {
    const r = rule({
      cadence: "daily",
      lastSentAt: MON_8AM_ET,
      watermarkFromRun: true,
      createdAt: 0,
    });
    expect(digestWindowStart(r, TUE_8AM_ET)).toBe(MON_8AM_ET);
  });

  test("a WEEKLY digest covers seven days on its very first run", () => {
    // The bug the owner saw: a rule created that morning mailed
    // `Aug 10 – Aug 10 · No gifts came in` while there had been giving all
    // week. "Weekly digest" means the trailing seven days to a reader, on the
    // first outing as much as the fiftieth.
    const bornAnHourAgo = rule({
      cadence: "weekly",
      createdAt: MON_8AM_ET - 60 * 60 * 1000,
    });
    expect(digestWindowStart(bornAnHourAgo, MON_8AM_ET)).toBe(
      MON_8AM_ET - 7 * DAY_MS,
    );

    const daily = rule({ cadence: "daily", createdAt: MON_8AM_ET - 1_000 });
    expect(digestWindowStart(daily, MON_8AM_ET)).toBe(MON_8AM_ET - DAY_MS);
  });

  test("a rule that has NEVER reported gets one period — never its whole life", () => {
    // THE GUARD THAT WAS DELETED AND SHOULD NOT HAVE BEEN. `createdAt` is not
    // a floor in either direction: not `max` (that produced Aug 10 – Aug 10),
    // and emphatically not `min`, which reaches back to whenever the rule was
    // made. Before the first send there is nothing else to clamp to, so a rule
    // born at the epoch would report from the epoch.
    const ancient = rule({ cadence: "weekly", createdAt: 0 });
    expect(digestWindowStart(ancient, MON_8AM_ET)).toBe(MON_8AM_ET - 7 * DAY_MS);

    // And it is REACHABLE, not theoretical: an empty daily deliberately never
    // stamps `lastSentAt`, so a quiet chapter's rule — or one with a $1,000
    // floor — sits watermark-less for months. Widen its scope and this is the
    // difference between a one-day digest and the org's entire ledger.
    const sixMonthsQuiet = rule({
      cadence: "daily",
      createdAt: MON_8AM_ET - 180 * DAY_MS,
      lastRunDayKey: localParts(MON_8AM_ET - DAY_MS).dayKey,
    });
    expect(digestWindowStart(sixMonthsQuiet, MON_8AM_ET)).toBe(
      MON_8AM_ET - DAY_MS,
    );
  });

  test("a missed run EXTENDS the window back, so nothing is silently skipped", () => {
    // Cron dropped ticks for a fortnight. The watermark is older than a period,
    // so the un-reported tail is reported rather than lost — whichever kind of
    // mark it is.
    const stalled = rule({
      cadence: "weekly",
      lastSentAt: MON_8AM_ET - 21 * DAY_MS,
      watermarkFromRun: true,
      createdAt: 0,
    });
    expect(digestWindowStart(stalled, MON_8AM_ET)).toBe(
      MON_8AM_ET - 21 * DAY_MS,
    );
    expect(
      digestWindowStart({ ...stalled, watermarkFromRun: undefined }, MON_8AM_ET),
    ).toBe(MON_8AM_ET - 21 * DAY_MS);
  });

  test("a rule dormant for three months comes back reporting a WEEK, not a quarter", () => {
    // Resuming stamps `lastSentAt = now` AND clears the flag, and it takes both
    // to get this right. The stamp bounds how far back it may look; the cleared
    // flag is what lets it look a full period back at all. Both properties in
    // one fixture — it covers the trailing week, and no more than that.
    const resumedYesterday = rule({
      cadence: "weekly",
      lastSentAt: MON_8AM_ET - DAY_MS, // stamped on resume, after 90 dark days
      watermarkFromRun: undefined, // …and cleared, because nothing was reported
      createdAt: MON_8AM_ET - 200 * DAY_MS,
    });
    expect(digestWindowStart(resumedYesterday, MON_8AM_ET)).toBe(
      MON_8AM_ET - 7 * DAY_MS,
    );
    expect(digestWindowStart(resumedYesterday, MON_8AM_ET)).toBeGreaterThan(
      MON_8AM_ET - 90 * DAY_MS,
    );
  });

  test("a rule back longer than a period reports from where it resumed", () => {
    // The `min` still picks the stamp up once it is the older of the two, so
    // the stretch since resuming is never skipped.
    const resumedTenDaysAgo = rule({
      cadence: "weekly",
      lastSentAt: MON_8AM_ET - 10 * DAY_MS,
      createdAt: 0,
    });
    expect(digestWindowStart(resumedTenDaysAgo, MON_8AM_ET)).toBe(
      MON_8AM_ET - 10 * DAY_MS,
    );
  });

  test("RUN-HOUR JITTER does not re-report last week's gifts", () => {
    // The normal case, not an edge one: the hour test is `>=`, so a dropped
    // 08:00 tick catches up at 14:00 and parks the watermark six hours late.
    // A trailing-period floor on a RUN's mark would then reach back over six
    // hours of gifts that were already mailed and inflate this week's total.
    const ranLate = rule({
      cadence: "weekly",
      lastSentAt: MON_8AM_ET - 7 * DAY_MS + 6 * 60 * 60 * 1000,
      watermarkFromRun: true,
      createdAt: 0,
    });
    const start = digestWindowStart(ranLate, MON_8AM_ET);
    expect(start).toBe(MON_8AM_ET - 7 * DAY_MS + 6 * 60 * 60 * 1000);
    // Shorter than seven days, and that is the CORRECT answer — the missing
    // six hours are last digest's, not this one's.
    expect(MON_8AM_ET - start).toBeLessThan(7 * DAY_MS);
  });

  test("DST does not re-report an hour, twice a year", () => {
    // A rule at 08:00 local shifts an hour in UTC across a boundary, so
    // `now − 7d` lands an hour BEFORE the previous watermark.
    const springForwardMonday = Date.parse("2026-03-09T12:00:00Z"); // 08:00 EDT
    const weekBefore = Date.parse("2026-03-02T13:00:00Z"); // 08:00 EST
    const r = rule({
      cadence: "weekly",
      lastSentAt: weekBefore,
      watermarkFromRun: true,
      createdAt: 0,
    });
    expect(springForwardMonday - 7 * DAY_MS).toBeLessThan(weekBefore);
    expect(digestWindowStart(r, springForwardMonday)).toBe(weekBefore);
  });

  test("a CUT window resumes from its bookmark — a run's mark is a run's mark", () => {
    // Mid-drain the watermark sits inside a period. A floor there would re-read
    // the gifts that cut it, cut at the same instant, and re-mail the same 750
    // gifts on every hourly tick for a week. Cut or complete makes no
    // difference: both were reported, so both resume exactly.
    const midDrain = rule({
      cadence: "daily",
      lastSentAt: MON_8AM_ET - 6 * 60 * 60 * 1000,
      watermarkFromRun: true,
      createdAt: 0,
    });
    expect(digestWindowStart(midDrain, MON_8AM_ET)).toBe(
      MON_8AM_ET - 6 * 60 * 60 * 1000,
    );
  });

  test("an unflagged watermark reads as synthetic — which is why 0061 exists", () => {
    // Pre-existing prod rows have a RUN's watermark and no flag, so they read
    // as case 3 until a claim re-stamps them. That fallback is the right
    // default for a field that has to mean something on day one, but it is not
    // free: for a rule caught mid-drain it is a full duplicate digest, not the
    // few hours of overlap first claimed. Hence
    // `0061_stamp_digest_watermark_provenance`.
    const legacy = rule({
      cadence: "weekly",
      lastSentAt: MON_8AM_ET - 7 * DAY_MS + 6 * 60 * 60 * 1000,
      createdAt: 0,
    });
    expect(digestWindowStart(legacy, MON_8AM_ET)).toBe(MON_8AM_ET - 7 * DAY_MS);
    // What the migration turns it into: exact, from the first tick.
    expect(
      digestWindowStart({ ...legacy, watermarkFromRun: true }, MON_8AM_ET),
    ).toBe(MON_8AM_ET - 7 * DAY_MS + 6 * 60 * 60 * 1000);

    // The mid-drain shape, which is the one that re-mails. Unflagged, a
    // bookmark six hours into a daily period gets the floor and reaches back a
    // whole day past itself — over every gift the cut digest just reported.
    const midDrain = rule({
      cadence: "daily",
      lastSentAt: MON_8AM_ET - 6 * 60 * 60 * 1000,
      createdAt: 0,
    });
    expect(digestWindowStart(midDrain, MON_8AM_ET)).toBe(MON_8AM_ET - DAY_MS);
    expect(
      digestWindowStart({ ...midDrain, watermarkFromRun: true }, MON_8AM_ET),
    ).toBe(MON_8AM_ET - 6 * 60 * 60 * 1000);
  });
});

describe("what KIND of giving a gift is", () => {
  const ids = {
    pledgeId: "p1" as Id<"pledges">,
    sponsorshipId: "s1" as Id<"sponsorships">,
    eventId: "e1" as Id<"events">,
    donationId: "dn1" as Id<"donations">,
  };

  test("the four shapes, each on its own", () => {
    expect(giftType({ pledgeId: ids.pledgeId })).toBe("recurring");
    expect(giftType({ sponsorshipId: ids.sponsorshipId })).toBe("sponsorship");
    expect(giftType({ eventId: ids.eventId })).toBe("event");
    // A ticket-bundled add-on arrives as a `donations` row that dual-writes its
    // gift, and doesn't always carry the `eventId` itself.
    expect(giftType({ donationId: ids.donationId })).toBe("event");
    expect(giftType({})).toBe("one_time");
  });

  test("a recurring cycle attached to an event is still RECURRING", () => {
    // The reachable overlap: the fundraiser attribution feature can hang an
    // `eventId` on any gift, including a backer's monthly cycle. Counting it as
    // event money would inflate what the gala raised with money that recurs
    // regardless, AND under-report the committed base a team budgets from.
    expect(giftType({ pledgeId: ids.pledgeId, eventId: ids.eventId })).toBe(
      "recurring",
    );
    expect(
      giftType({ pledgeId: ids.pledgeId, sponsorshipId: ids.sponsorshipId }),
    ).toBe("recurring");
  });

  test("a sponsorship payment against an event is a SPONSORSHIP", () => {
    // Sponsorship money is sold, invoiced and chased by different people than
    // gifts are, so it gets its own line rather than being folded into Events
    // — and above all it must not land silently in One-time.
    expect(
      giftType({ sponsorshipId: ids.sponsorshipId, eventId: ids.eventId }),
    ).toBe("sponsorship");
  });

  test("every combination of links resolves to ONE named bucket", () => {
    // Was `toBeTypeOf("string")`, which a total function passes for every
    // input — a test that named a property it could not fail on. Each case now
    // asserts the bucket it must land in, so a precedence change has to come
    // here and be argued for.
    const cases: Array<[Parameters<typeof giftType>[0], string]> = [
      [{}, "One-time"],
      [{ pledgeId: ids.pledgeId }, "Recurring"],
      [{ sponsorshipId: ids.sponsorshipId }, "Sponsorships"],
      [{ eventId: ids.eventId }, "Events"],
      [{ donationId: ids.donationId }, "Events"],
      [{ eventId: ids.eventId, donationId: ids.donationId }, "Events"],
      [{ sponsorshipId: ids.sponsorshipId, donationId: ids.donationId }, "Sponsorships"],
      [
        { pledgeId: ids.pledgeId, eventId: ids.eventId, donationId: ids.donationId },
        "Recurring",
      ],
      // All four markers at once — the top of the order wins.
      [{ ...ids }, "Recurring"],
    ];
    for (const [gift, label] of cases) {
      expect(GIFT_TYPE_LABELS[giftType(gift)]).toBe(label);
    }
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
      // Type labels are ours, not a donor's — but the section renders through
      // the same builder, so an unescaped label there would be a hole all the
      // same. Pinned with the same payload.
      byType: [{ label: XSS, cents: 50_000, count: 1 }],
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
      byType: [],
      gifts: [],
      omittedCount: 0,
      countTruncated: false,
    });
    expect(subject).toBe("No giving this week — All books");
    expect(html).toContain("No gifts came in");
  });

  test("totals, the largest gift, ALL THREE breakdowns, and a link per donor", () => {
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
      byType: [
        { label: "Recurring", cents: 120_000, count: 1 },
        { label: "One-time", cents: 2_500, count: 1 },
      ],
      gifts: [big, small],
      omittedCount: 3,
      countTruncated: false,
    });
    expect(subject).toBe("$1,225.00 from 2 gifts this day — All books");
    expect(html).toContain("$1,225.00");
    expect(html).toContain("$1,200.00");
    expect(html).toContain("Bo Giver");
    // All three cuts are titled and present — the type one is what the owner
    // asked for and the one the digest didn't have.
    expect(html).toContain("By giving type");
    expect(html).toContain("By chapter");
    expect(html).toContain("How it arrived");
    expect(html).toContain("Recurring");
    expect(html).toContain("One-time");
    expect(html).toContain("New York");
    expect(html).toContain("Chapter OS");
    expect(html).toContain("Cash");
    expect(html).toContain("https://publicworship.life/os/giving/donor/d1");
    expect(html).toContain("https://publicworship.life/os/giving/donor/d2");
    expect(html).toContain("and 3 more");
  });

  test("a window that ran long stops calling itself 'this week'", () => {
    // A missed fortnight of runs is reported rather than skipped, so a weekly
    // window can genuinely be 21 days. "$X this week" over 21 days is a lie in
    // the one line most recipients read, and it invites a false comparison with
    // last week's figure.
    const long = renderDigestEmail({
      ruleName: "Weekly roundup",
      cadence: "weekly",
      scopeLabel: "All books",
      periodStart: MON_8AM_ET - 21 * DAY_MS,
      periodEnd: MON_8AM_ET,
      totalCents: 33_000,
      giftCount: 1,
      largest: sampleGift({ amountCents: 33_000 }),
      byScope: [{ label: "Central", cents: 33_000, count: 1 }],
      byMethod: [{ label: "Chapter OS", cents: 33_000, count: 1 }],
      byType: [{ label: "One-time", cents: 33_000, count: 1 }],
      gifts: [sampleGift({ amountCents: 33_000 })],
      omittedCount: 0,
      countTruncated: false,
    });
    expect(long.subject).toBe("$330.00 from 1 gift since Jul 20, 2026 — All books");
    expect(long.subject).not.toContain("this week");
    expect(long.html).toContain("covers a longer stretch than one week");

    // An empty one says it too, rather than "no giving this week".
    const emptyLong = renderDigestEmail({
      ruleName: "Weekly roundup",
      cadence: "weekly",
      scopeLabel: "All books",
      periodStart: MON_8AM_ET - 21 * DAY_MS,
      periodEnd: MON_8AM_ET,
      totalCents: 0,
      giftCount: 0,
      largest: null,
      byScope: [],
      byMethod: [],
      byType: [],
      gifts: [],
      omittedCount: 0,
      countTruncated: false,
    });
    expect(emptyLong.subject).toBe("No giving since Jul 20, 2026 — All books");
  });

  test("ordinary jitter does NOT trip the long-window wording", () => {
    // Run-hour drift and DST move a window by hours in both directions. A
    // subject that flipped its wording over an hour's drift would be noise, so
    // the tolerance sits past anything the clock does on its own.
    const { subject } = renderDigestEmail({
      ruleName: "Weekly roundup",
      cadence: "weekly",
      scopeLabel: "All books",
      periodStart: MON_8AM_ET - 7 * DAY_MS - 6 * 60 * 60 * 1000,
      periodEnd: MON_8AM_ET,
      totalCents: 1_000,
      giftCount: 1,
      largest: sampleGift({ amountCents: 1_000 }),
      byScope: [{ label: "Central", cents: 1_000, count: 1 }],
      byMethod: [{ label: "Cash", cents: 1_000, count: 1 }],
      byType: [{ label: "One-time", cents: 1_000, count: 1 }],
      gifts: [sampleGift({ amountCents: 1_000 })],
      omittedCount: 0,
      countTruncated: false,
    });
    expect(subject).toContain("this week");
  });

  test("every breakdown prints a total, and all three equal the headline", () => {
    // A breakdown whose parts don't sum to the total is worse than no
    // breakdown, because it's the one people quote in a meeting. Each section
    // sums the rows it RENDERS (not the headline), so a cut that ever stopped
    // covering every gift would disagree out loud instead of restating the
    // total and hiding the gap.
    const { html } = renderDigestEmail({
      ruleName: "Weekly roundup",
      cadence: "weekly",
      scopeLabel: "All books",
      periodStart: MON_8AM_ET - 7 * DAY_MS,
      periodEnd: MON_8AM_ET,
      totalCents: 13_500,
      giftCount: 3,
      largest: sampleGift({ amountCents: 11_500 }),
      byScope: [
        { label: "New York", cents: 11_500, count: 1 },
        { label: "Central", cents: 2_000, count: 2 },
      ],
      byMethod: [
        { label: "Chapter OS", cents: 11_500, count: 1 },
        { label: "Cash", cents: 2_000, count: 2 },
      ],
      byType: [
        { label: "Events", cents: 11_500, count: 1 },
        { label: "One-time", cents: 1_500, count: 1 },
        { label: "Recurring", cents: 500, count: 1 },
      ],
      gifts: [],
      omittedCount: 0,
      countTruncated: false,
    });
    // Four `Total:` lines reading the same figure — the headline panel's, and
    // one under each of the three cuts. Anything less than four is a section
    // that doesn't add up.
    const totals = html.match(/Total:<\/span>\s*<span[^>]*>\$135\.00/g) ?? [];
    expect(totals).toHaveLength(4);
    // …and each of the three sections counts all three gifts (the headline
    // panel states its count separately, as "Gifts").
    expect(html.match(/\$135\.00 <span[^>]*>\(3\)/g) ?? []).toHaveLength(3);
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

/**
 * A rule is gated on giving VIEW of its own book, not giving MANAGE — the
 * owner's call on 2026-08-10 ("You should allow anybody with access to giving
 * to do the notifications"), because no chapter seat carries `giving.manage`
 * and the manage gate therefore meant "central only" in the shipped seat chart.
 *
 * What widened is WHICH CAPABILITY opens a book. WHICH BOOKS a capability opens
 * did not move an inch, and the second half of this suite is the proof.
 */
describe("who may manage a rule", () => {
  test("central reach writes a rule for any book", async () => {
    const s = await devDirectorSetup();
    const ruleId = await saveRule(s.as, { scope: s.chapterId });
    const row = await run(s.t, (ctx) => ctx.db.get(ruleId));
    expect(row?.scope).toBe(s.chapterId);
  });

  test("a chapter seat that only READS the desk writes its own book's rule", async () => {
    // THE CHANGE, stated once: `chapter_director` is `giving.view` and nothing
    // more, and it can now aim a mailer at the book it already reads.
    const s = await devDirectorSetup();
    const viewer = await seatChapterViewer(s, s.chapterId);
    const ruleId = await saveRule(viewer, { scope: s.chapterId });
    const row = await run(s.t, (ctx) => ctx.db.get(ruleId));
    expect(row?.scope).toBe(s.chapterId);
  });

  test("a view-only seat edits and pauses the rule it made", async () => {
    const s = await devDirectorSetup();
    const viewer = await seatChapterViewer(s, s.chapterId);
    const ruleId = await saveRule(viewer, {
      name: "New York gifts",
      scope: s.chapterId,
    });

    await saveRule(viewer, {
      ruleId,
      name: "New York gifts over $500",
      minAmountCents: 50_000,
      scope: s.chapterId,
    });
    await viewer.mutation(api.givingNotifications.setRuleActive, {
      ruleId,
      isActive: false,
    });

    const row = await run(s.t, (ctx) => ctx.db.get(ruleId));
    expect(row?.name).toBe("New York gifts over $500");
    expect(row?.minAmountCents).toBe(50_000);
    expect(row?.isActive).toBe(false);
  });

  test("a view-only seat works a rule CENTRAL wrote for its book", async () => {
    // Authorship confers nothing either way — the gate is the rule's scope.
    const s = await devDirectorSetup();
    const viewer = await seatChapterViewer(s, s.chapterId);
    const ruleId = await saveRule(s.as, { name: "Ours", scope: s.chapterId });
    await viewer.mutation(api.givingNotifications.setRuleActive, {
      ruleId,
      isActive: false,
    });
    expect((await run(s.t, (ctx) => ctx.db.get(ruleId)))?.isActive).toBe(false);
  });

  test("a view-only seat cannot point a rule at every book", async () => {
    // Containment, direction one: `ruleGateScope` routes `"all"` through
    // `"central"`, so an org-wide firehose still needs central reach. Widening
    // the capability must never widen the REACH.
    const s = await devDirectorSetup();
    const viewer = await seatChapterViewer(s, s.chapterId);
    await expect(saveRule(viewer, { scope: "all" })).rejects.toThrow(ConvexError);
  });

  test("a view-only seat cannot write a central rule", async () => {
    const s = await devDirectorSetup();
    const viewer = await seatChapterViewer(s, s.chapterId);
    await expect(saveRule(viewer, { scope: "central" })).rejects.toThrow(
      ConvexError,
    );
  });

  test("a view-only seat cannot write ANOTHER chapter's rule", async () => {
    // Containment, direction two: view of New York is view of New York. A
    // sibling book is as far out of reach as central is.
    const s = await devDirectorSetup();
    const other = await run(s.t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "Los Angeles",
        slug: "los-angeles",
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    const viewer = await seatChapterViewer(s, s.chapterId);
    await expect(saveRule(viewer, { scope: other })).rejects.toThrow(
      ConvexError,
    );
  });

  test("a view-only seat cannot pause another chapter's rule", async () => {
    const s = await devDirectorSetup();
    const other = await run(s.t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "Los Angeles",
        slug: "los-angeles",
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    const ruleId = await saveRule(s.as, { name: "Theirs", scope: other });
    const viewer = await seatChapterViewer(s, s.chapterId);
    await expect(
      viewer.mutation(api.givingNotifications.setRuleActive, {
        ruleId,
        isActive: false,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("a view-only seat cannot walk its own rule out to every book", async () => {
    // The escalation the scope-change check exists to stop, now from the seat
    // that can actually reach this mutation: create where you may, then edit
    // the scope to somewhere you may not.
    const s = await devDirectorSetup();
    const viewer = await seatChapterViewer(s, s.chapterId);
    const ruleId = await saveRule(viewer, { scope: s.chapterId });
    await expect(
      saveRule(viewer, { ruleId, scope: "all" }),
    ).rejects.toThrow(ConvexError);
    expect((await run(s.t, (ctx) => ctx.db.get(ruleId)))?.scope).toBe(
      s.chapterId,
    );
  });

  test("a view-only seat cannot pull a central rule into its own book", async () => {
    // The other half of the scope-change check: rights on the book it LEAVES.
    const s = await devDirectorSetup();
    const viewer = await seatChapterViewer(s, s.chapterId);
    const centralRule = await saveRule(s.as, { scope: "central" });
    await expect(
      saveRule(viewer, { ruleId: centralRule, scope: s.chapterId }),
    ).rejects.toThrow(ConvexError);
    expect((await run(s.t, (ctx) => ctx.db.get(centralRule)))?.scope).toBe(
      "central",
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
  test("a chapter seat sees only their own book's rules — and now manages them", async () => {
    const s = await devDirectorSetup();
    const viewer = await seatChapterViewer(s, s.chapterId);
    await saveRule(s.as, { name: "Org-wide", scope: "all" });
    await saveRule(s.as, { name: "Chapter", scope: s.chapterId });

    const all = await s.as.query(api.givingNotifications.listRules, {});
    expect(all.map((r) => r.name).sort()).toEqual(["Chapter", "Org-wide"]);
    expect(all.every((r) => r.canManage)).toBe(true);

    // The org-wide rule is still invisible to them — the widened gate did not
    // widen the LIST either, because both halves ask the same question.
    const mine = await viewer.query(api.givingNotifications.listRules, {});
    expect(mine.map((r) => r.name)).toEqual(["Chapter"]);
    expect(mine[0].scopeLabel).toBe("New York");
    // True since 2026-08-10: seeing a rule and working it are the same right.
    expect(mine[0].canManage).toBe(true);
  });

  test("every row anyone is shown comes back manageable", async () => {
    // The invariant that falls out of one predicate serving both the filter and
    // the flag. If this ever fails, `listRules` has grown two opinions.
    const s = await devDirectorSetup();
    const viewer = await seatChapterViewer(s, s.chapterId);
    const chapMgr = await seatChapterGivingManager(s, s.chapterId);
    await saveRule(s.as, { name: "Org-wide", scope: "all" });
    await saveRule(s.as, { name: "Central", scope: "central" });
    await saveRule(s.as, { name: "Chapter", scope: s.chapterId });

    for (const caller of [s.as, viewer, chapMgr]) {
      const rows = await caller.query(api.givingNotifications.listRules, {});
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.canManage)).toBe(true);
    }
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

  test("a rule authored by a VIEW-only chapter seat still can't reach central's gifts", async () => {
    // Every other send-path containment test here was written when only central
    // could author a rule. Now that a chapter `giving.view` seat can, the
    // property has to be re-proved from THAT seat: the send path bounds gifts by
    // the RULE's scope, so authorship buys no extra reach at send time either.
    // Belt and braces with the mutation gate — that stops the rule being
    // written; this stops it mattering if one ever were.
    const s = await devDirectorSetup();
    const viewer = await seatChapterViewer(s, s.chapterId);
    await saveRule(viewer, {
      name: "New York, mine",
      scope: s.chapterId,
      recipients: ["chapdir@publicworship.life"],
    });
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET, async () => {
        await addGift(s.as, { scope: "central", name: "Central Giver" });
      });
      // A central donor's name and amount never reach a chapter seat's inbox.
      expect(cap.sent).toHaveLength(0);

      await atClock(s.t, MON_8AM_ET, async () => {
        await addGift(s.as, { scope: s.chapterId, name: "Chapter Giver" });
      });
      expect(cap.sent.map((e) => e.to)).toEqual(["chapdir@publicworship.life"]);
      expect(cap.sent[0].html).toContain("Chapter Giver");
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

  test("an import of last year's giving is not today's giving — the digest says nothing about it", async () => {
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
      // NOT ONE EMAIL. Every one of those gifts arrived over a year ago; today
      // took nothing, and an empty daily is not sent. This test used to assert
      // `$400.00 from 4 gifts this day`, which is the production bug in
      // miniature — the same shape that reported $9,224.03 for a $261.00 week.
      // Historical giving is read in the ledger, not mailed as this morning's.
      expect(cap.sent).toHaveLength(0);
      // …and the day's window is genuinely empty, so nothing was reported and
      // the watermark stays put.
      const row = await run(s.t, (ctx) =>
        ctx.db
          .query("givingNotificationRules")
          .first(),
      );
      expect(row?.lastSentAt).toBeUndefined();
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
  specs: Array<{
    /** When the money ARRIVED — the field every window ranges on. */
    receivedAt: number;
    /**
     * When the row was WRITTEN. Defaults to `receivedAt` (a gift recorded as it
     * lands, which is most of them). Set it apart to write a BACKDATED row: an
     * import of last year's giving, or a cheque keyed a week after it arrived.
     * Nothing a digest reports may depend on it.
     */
    createdAt?: number;
    amountCents?: number;
    scope?: unknown;
    method?: Doc<"gifts">["method"];
  }>,
): Promise<void> {
  await run(s.t, async (ctx) => {
    for (const spec of specs) {
      await ctx.db.insert("gifts", {
        donorId,
        scope: (spec.scope ?? "central") as "central",
        amountCents: spec.amountCents ?? 1_000,
        currency: "usd",
        receivedAt: spec.receivedAt,
        method: spec.method ?? "stripe",
        createdAt: spec.createdAt ?? spec.receivedAt,
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

/**
 * `createdAt` for a row whose `receivedAt` is `t` — deliberately DESCENDING and
 * far outside every window under test.
 *
 * The window ranges on `receivedAt`, and these tests are the ones that would
 * still pass under the old `createdAt` read if the two fields agreed. Pulling
 * them apart makes that impossible: on a `createdAt` range these rows are not in
 * the window at all, and on a `createdAt` ORDER they come back backwards.
 */
function writtenLater(receivedAt: number): number {
  return 900_000 - receivedAt;
}

describe("collectWindowGifts — the cap, the drain, and where the window closes", () => {
  test("stops at the match cap and closes the window on the last gift it read", async () => {
    const s = await devDirectorSetup();
    const donorId = await seedDonor(s);
    // Ten gifts, one per millisecond, so there is no tie to drain.
    await seedRawGifts(
      s,
      donorId,
      Array.from({ length: 10 }, (_, i) => ({
        receivedAt: 1_000 + i,
        createdAt: writtenLater(1_000 + i),
      })),
    );

    const out = await run(s.t, (ctx) =>
      collectWindowGifts(ctx, ALL_SCOPE_RULE, 0, 2_000, {
        maxMatches: 3,
        maxScan: 999,
      }),
    );
    expect(out.gifts).toHaveLength(3);
    expect(out.truncated).toBe(true);
    // The window closes ON the third gift (received 1002), never past it —
    // the next window opens strictly after, so nothing between is skipped.
    expect(out.until).toBe(1_002);
    // …and it is the three OLDEST-RECEIVED, not the three most recently keyed.
    expect(out.gifts.map((g) => g.receivedAt)).toEqual([1_000, 1_001, 1_002]);
  });

  test("drains the whole millisecond it stopped in, stragglers included", async () => {
    const s = await devDirectorSetup();
    const donorId = await seedDonor(s);
    // Three gifts share ms 1002 — a batch imported under one date, a payout
    // minute. The cap falls on the FIRST of them; the other two must still come
    // back, or the next window (which opens strictly after 1002) would skip
    // them. Their `createdAt`s are all different, so only a tie on `receivedAt`
    // can produce this.
    await seedRawGifts(s, donorId, [
      { receivedAt: 1_000, createdAt: writtenLater(1_000) },
      { receivedAt: 1_001, createdAt: writtenLater(1_001) },
      { receivedAt: 1_002, createdAt: 500_001, amountCents: 111 },
      { receivedAt: 1_002, createdAt: 500_002, amountCents: 222 },
      { receivedAt: 1_002, createdAt: 500_003, amountCents: 333 },
      { receivedAt: 1_003, createdAt: writtenLater(1_003) },
      { receivedAt: 1_004, createdAt: writtenLater(1_004) },
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
    expect(out.gifts.filter((g) => g.receivedAt === 1_002)).toHaveLength(3);
  });

  test("hitting the cap on the very LAST row is not a truncation", async () => {
    const s = await devDirectorSetup();
    const donorId = await seedDonor(s);
    await seedRawGifts(s, donorId, [
      { receivedAt: 1_000, createdAt: writtenLater(1_000) },
      { receivedAt: 1_001, createdAt: writtenLater(1_001) },
      { receivedAt: 1_002, createdAt: writtenLater(1_002) },
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
      Array.from({ length: 20 }, (_, i) => ({
        receivedAt: 1_000 + i,
        createdAt: writtenLater(1_000 + i),
        amountCents: 100,
      })),
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
      Array.from({ length: 30 }, (_, i) => ({
        receivedAt: 1_000 + i,
        createdAt: writtenLater(1_000 + i),
      })),
    );
    await seedRawGifts(s, donorId, [
      { receivedAt: 1_100, createdAt: writtenLater(1_100), scope: s.chapterId },
      { receivedAt: 1_101, createdAt: writtenLater(1_101), scope: s.chapterId },
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

    // Genuinely past the production cap — no injected limits here. A busy day:
    // 790 gifts a millisecond apart, every one of them WRITTEN in reverse order
    // of arrival, so the drain can only come out right if it is ordered by when
    // the money arrived.
    const total = MAX_DIGEST_MATCHES + 40;
    const base = MON_8AM_ET - 6 * 60 * 60 * 1000;
    await seedRawGifts(
      s,
      donorId,
      Array.from({ length: total }, (_, i) => ({
        receivedAt: base + i,
        createdAt: base + total - i,
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
      // The first pass reports exactly the cap, and says the total is a floor —
      // in the SUBJECT as well as the body. A cut window is a SLICE of the
      // period, not the period, so it doesn't get to claim the day.
      expect(cap.sent[0].subject).toContain(
        `from ${MAX_DIGEST_MATCHES} gifts so far`,
      );
      expect(cap.sent[0].subject).not.toContain("this day");
      expect(cap.sent[0].html).toContain("FLOOR");
      expect(cap.sent[0].html).toContain(
        "carries on from exactly where this one stopped",
      );

      const afterFirst = await run(s.t, (ctx) => ctx.db.get(ruleId));
      // Closed ON the last gift read — the 750th by ARRIVAL — not at `now` and
      // not on a `createdAt`. The remainder is still ahead of the watermark
      // rather than behind it.
      expect(afterFirst?.lastSentAt).toBe(base + MAX_DIGEST_MATCHES - 1);
      // …and the run mark is CLEARED, so the drain continues within the day
      // instead of waiting until tomorrow.
      expect(afterFirst?.lastRunDayKey).toBeUndefined();
      // The mark is flagged as a RUN's. Without it the next window's
      // trailing-period floor would reach back past the cut, re-read the gifts
      // that caused it, cut at the same instant, and re-mail the same 750 gifts
      // every hour until the import aged out of the period.
      expect(afterFirst?.watermarkFromRun).toBe(true);
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
      // The flag STAYS — cut or complete, this watermark is still a report, and
      // the next window must not reach back over it.
      expect(afterSecond?.lastRunDayKey).toBe(localParts(MON_8AM_ET).dayKey);
      expect(afterSecond?.watermarkFromRun).toBe(true);
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
      byType: [],
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
      // ALL THREE marks come back, not two. `claimDigest` set
      // `watermarkFromRun: true` on the way in, so this assertion is genuinely
      // reachable: drop the restore from `releaseDigest` and the rule keeps a
      // `true` describing a watermark that no longer exists — and the next run
      // would resume from a mark that was rolled back, losing the floor that
      // rule is entitled to.
      expect(failed?.watermarkFromRun).toBeUndefined();
      // …while the two that did land kept theirs, flag included.
      const landed = rules.find((r) => r.recipients[0] === "b@publicworship.life");
      expect(landed?.lastSentAt).toBe(MON_8AM_ET - 60_000);
      expect(landed?.watermarkFromRun).toBe(true);
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

// ═══════════════════════════════════════════════════════════════════════════
// A weekly digest covers a week — end to end, against the real window
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The first weekly digest this feature ever mailed read:
 *
 *   WEEKLY GIVING DIGEST — No gifts came in
 *   Aug 10, 2026 – Aug 10, 2026 · All books
 *
 * It was created that morning, so its window opened at its own birth and could
 * only ever be empty — while there had been giving all week. These hold the two
 * halves of the fix down together, because they pull in opposite directions:
 * ALWAYS AT LEAST THE TRAILING PERIOD, and NEVER a dormant rule's backlog.
 */
describe("the window a digest reports", () => {
  test("a brand-new weekly rule's first digest covers the trailing SEVEN DAYS", async () => {
    const s = await devDirectorSetup();
    const cap = captureEmails();
    try {
      // The real ledger's week: $20 on the Sunday, $115 on the Monday morning.
      await atClock(s.t, MON_8AM_ET - DAY_MS, async () => {
        await addGift(s.as, {
          amountCents: 2_000,
          name: "Sunday Giver",
          email: "sun@example.com",
        });
      });
      await atClock(s.t, MON_8AM_ET - 2 * 60 * 60 * 1000, async () => {
        await addGift(s.as, {
          amountCents: 11_500,
          name: "Monday Giver",
          email: "mon@example.com",
        });
      });

      // The rule is written an hour before its send moment — so it IS due at
      // 8am, and under the old `max(createdAt, …)` clamp its window would have
      // been one hour long.
      await atClock(s.t, MON_8AM_ET - 60 * 60 * 1000, async () => {
        await saveRule(s.as, {
          name: "Weekly roundup",
          cadence: "weekly",
          sendHourLocal: 8,
          sendWeekday: 1,
        });
      });
      cap.sent.length = 0;

      await atClock(s.t, MON_8AM_ET, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });

      expect(cap.sent).toHaveLength(1);
      // Both gifts, including the one that predates the rule by six days.
      expect(cap.sent[0].subject).toBe(
        "$135.00 from 2 gifts this week — All books",
      );
      expect(cap.sent[0].html).toContain("Sunday Giver");
      expect(cap.sent[0].html).toContain("Monday Giver");
      // And the header names the window it actually queried — a week, not a day.
      expect(cap.sent[0].html).toContain("Aug 3, 2026 – Aug 10, 2026");
    } finally {
      cap.restore();
    }
  });

  test("a rule watermark-less for six months reports a DAY, not six months", async () => {
    // The empty-daily branch deliberately never stamps `lastSentAt`, so a quiet
    // chapter's rule can sit without a watermark indefinitely. Clamping the
    // first window to `createdAt` — in either direction — is therefore not a
    // first-run nicety but the ONLY lower bound such a rule has, and `min`
    // against it would mail the org's entire ledger as a "daily" digest.
    const s = await devDirectorSetup();
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, MON_8AM_ET - 180 * DAY_MS, async () => {
      ruleId = await saveRule(s.as, {
        name: "Quiet daily",
        cadence: "daily",
        sendHourLocal: 8,
      });
    });

    const cap = captureEmails();
    try {
      // A run with nothing in the window: skipped, and NO watermark forms.
      await atClock(s.t, MON_8AM_ET - 179 * DAY_MS, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      const quiet = await run(s.t, (ctx) => ctx.db.get(ruleId));
      expect(quiet?.lastSentAt).toBeUndefined();
      expect(quiet?.watermarkFromRun).toBeUndefined();

      // Months of giving it was never told about, plus one gift today.
      await atClock(s.t, MON_8AM_ET - 90 * DAY_MS, async () => {
        await addGift(s.as, { amountCents: 900_000, name: "Ancient History" });
      });
      await atClock(s.t, MON_8AM_ET - 2 * 60 * 60 * 1000, async () => {
        await addGift(s.as, {
          amountCents: 6_000,
          name: "Today Only",
          email: "today@example.com",
        });
      });
      cap.sent.length = 0;

      await atClock(s.t, MON_8AM_ET, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      expect(cap.sent).toHaveLength(1);
      expect(cap.sent[0].html).toContain("Today Only");
      expect(cap.sent[0].html).not.toContain("Ancient History");
      expect(cap.sent[0].subject).toBe("$60.00 from 1 gift this day — All books");
    } finally {
      cap.restore();
    }
  });

  test("setRuleActive clears the provenance flag a real run had set", async () => {
    // The flag has to be genuinely `true` before the resume, or this asserts
    // nothing: on a rule that never ran the field is already absent, and
    // deleting `setRuleActive`'s clear leaves the suite green. So the rule
    // sends a real digest first, and the `true` is checked before it matters.
    const s = await devDirectorSetup();
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, MON_8AM_ET - 40 * DAY_MS, async () => {
      ruleId = await saveRule(s.as, { cadence: "daily", sendHourLocal: 8 });
    });
    const cap = captureEmails();
    try {
      // Two hours before the run, not a whole day: the window is
      // `(since, until]`, so a gift landing exactly ON `since` is excluded and
      // the digest would skip as an empty daily without ever stamping.
      await atClock(s.t, MON_8AM_ET - 30 * DAY_MS - 2 * 60 * 60 * 1000, async () => {
        await addGift(s.as, { amountCents: 15_000, name: "Pre Pause" });
      });
      await atClock(s.t, MON_8AM_ET - 30 * DAY_MS, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      const ran = await run(s.t, (ctx) => ctx.db.get(ruleId));
      expect(ran?.watermarkFromRun).toBe(true);
      expect(ran?.lastSentAt).toBe(MON_8AM_ET - 30 * DAY_MS - 60_000);

      await atClock(s.t, MON_8AM_ET - 20 * DAY_MS, async () => {
        await s.as.mutation(api.givingNotifications.setRuleActive, {
          ruleId,
          isActive: false,
        });
      });
      await atClock(s.t, MON_8AM_ET - 3 * DAY_MS, async () => {
        await s.as.mutation(api.givingNotifications.setRuleActive, {
          ruleId,
          isActive: true,
        });
      });

      const resumed = await run(s.t, (ctx) => ctx.db.get(ruleId));
      // Both halves of the stamp, and the flag is the half that fails loudly if
      // the clear is removed.
      expect(resumed?.lastSentAt).toBe(MON_8AM_ET - 3 * DAY_MS);
      expect(resumed?.watermarkFromRun).toBeUndefined();

      // …and the consequence, so this isn't only a field assertion: a gift from
      // BEFORE the resume but inside the trailing day is reported, which only
      // happens because the flag came off and the floor applied.
      await atClock(s.t, MON_8AM_ET - 20 * 60 * 60 * 1000, async () => {
        await addGift(s.as, {
          amountCents: 4_200,
          name: "Before Resume",
          email: "before@example.com",
        });
      });
      cap.sent.length = 0;
      await atClock(s.t, MON_8AM_ET, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      expect(cap.sent).toHaveLength(1);
      expect(cap.sent[0].html).toContain("Before Resume");
    } finally {
      cap.restore();
    }
  });

  test("resuming through saveRule closes the same door setRuleActive does", async () => {
    // `isActive` is settable on the edit mutation too, and the mark reset there
    // was gated on a cadence change only — so a rule switched off for months and
    // switched back on by an EDIT reached the dormant replay past the guard
    // written for the other two doors. Not reachable from the desk UI, but this
    // is a public mutation and the UI is not the contract.
    const s = await devDirectorSetup();
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, MON_8AM_ET - 120 * DAY_MS, async () => {
      ruleId = await saveRule(s.as, { cadence: "daily", sendHourLocal: 8 });
    });
    const cap = captureEmails();
    try {
      // IT MUST HAVE RUN FIRST. Asserting `watermarkFromRun` is undefined on a
      // rule that never ran proves nothing — the field was already absent, and
      // deleting the clear in `saveRule` would leave the suite green. So give
      // it a real digest, and check the flag is genuinely `true` before the
      // resume has to clear it.
      await atClock(s.t, MON_8AM_ET - 110 * DAY_MS - 2 * 60 * 60 * 1000, async () => {
        await addGift(s.as, { amountCents: 12_000, name: "Before The Pause" });
      });
      await atClock(s.t, MON_8AM_ET - 110 * DAY_MS, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      const ran = await run(s.t, (ctx) => ctx.db.get(ruleId));
      expect(ran?.watermarkFromRun).toBe(true);

      await atClock(s.t, MON_8AM_ET - 100 * DAY_MS, async () => {
        await s.as.mutation(api.givingNotifications.setRuleActive, {
          ruleId,
          isActive: false,
        });
      });
      await atClock(s.t, MON_8AM_ET - 60 * DAY_MS, async () => {
        await addGift(s.as, { amountCents: 900_000, name: "Dormant Era" });
      });
      // Back on via an EDIT, cadence untouched.
      await atClock(s.t, MON_8AM_ET - 2 * DAY_MS, async () => {
        await saveRule(s.as, {
          ruleId,
          cadence: "daily",
          sendHourLocal: 8,
          isActive: true,
        });
      });
      const row = await run(s.t, (ctx) => ctx.db.get(ruleId));
      expect(row?.lastSentAt).toBe(MON_8AM_ET - 2 * DAY_MS);
      // Synthetic boundary, so the first window back still gets its full
      // trailing period — it just can't reach past the resume. This is the
      // assertion that fails if `saveRule` stops clearing the flag.
      expect(row?.watermarkFromRun).toBeUndefined();
      cap.sent.length = 0;

      await atClock(s.t, MON_8AM_ET, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      // Nothing since it came back, and the dormant stretch is NOT replayed.
      expect(cap.sent).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });

  test("a run that caught up late does not re-report its gifts next time", async () => {
    // Run-hour jitter, end to end. The `>=` hour test means a dropped 08:00
    // tick catches up later the same day and parks the watermark hours late;
    // a trailing-period floor on a run's mark would then reach back over
    // everything that late run already mailed.
    const s = await devDirectorSetup();
    await atClock(s.t, SETUP_AT, async () => {
      await saveRule(s.as, { cadence: "daily", sendHourLocal: 8 });
    });
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET + 3 * 60 * 60 * 1000, async () => {
        await addGift(s.as, { amountCents: 8_800, name: "Late Run Gift" });
      });
      cap.sent.length = 0;

      // Monday's 08:00 tick was dropped; the sweep catches up at 14:00 and
      // mails that gift.
      await atClock(s.t, MON_8AM_ET + 6 * 60 * 60 * 1000, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      expect(cap.sent).toHaveLength(1);
      expect(cap.sent[0].html).toContain("Late Run Gift");
      cap.sent.length = 0;

      // Tuesday, on time. `now − 1 day` sits six hours BEFORE Monday's late
      // watermark — so a floor here would mail "Late Run Gift" a second time.
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

  test("a fortnight of missed runs is reported, not quietly skipped", async () => {
    const s = await devDirectorSetup();
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, MON_8AM_ET - 30 * DAY_MS, async () => {
      ruleId = await saveRule(s.as, {
        name: "Weekly roundup",
        cadence: "weekly",
        sendHourLocal: 8,
        sendWeekday: 1,
      });
    });
    // It last reported three weeks ago and the cron has been down since.
    await run(s.t, (ctx) =>
      ctx.db.patch(ruleId, { lastSentAt: MON_8AM_ET - 21 * DAY_MS }),
    );

    const cap = captureEmails();
    try {
      // A gift twelve days back — older than a period, newer than the
      // watermark. The floor must not shorten the window past it.
      await atClock(s.t, MON_8AM_ET - 12 * DAY_MS, async () => {
        await addGift(s.as, { amountCents: 33_000, name: "Blackout Giver" });
      });
      cap.sent.length = 0;

      await atClock(s.t, MON_8AM_ET, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      expect(cap.sent).toHaveLength(1);
      expect(cap.sent[0].html).toContain("Blackout Giver");
      expect(cap.sent[0].subject).toContain("$330.00");
    } finally {
      cap.restore();
    }
  });

  test("a rule paused for three months reports the WEEK it came back to, and nothing older", async () => {
    const s = await devDirectorSetup();
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, MON_8AM_ET - 120 * DAY_MS, async () => {
      ruleId = await saveRule(s.as, {
        name: "Weekly roundup",
        cadence: "weekly",
        sendHourLocal: 8,
        sendWeekday: 1,
      });
    });
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET - 100 * DAY_MS, async () => {
        await s.as.mutation(api.givingNotifications.setRuleActive, {
          ruleId,
          isActive: false,
        });
      });
      // Ninety dark days of giving it deliberately wasn't told about.
      await atClock(s.t, MON_8AM_ET - 60 * DAY_MS, async () => {
        await addGift(s.as, { amountCents: 900_000, name: "Dormant Era" });
      });
      // Back on, two days before the next Monday.
      await atClock(s.t, MON_8AM_ET - 2 * DAY_MS, async () => {
        await s.as.mutation(api.givingNotifications.setRuleActive, {
          ruleId,
          isActive: true,
        });
      });
      // …and a gift inside the trailing week, from BEFORE it was resumed.
      await atClock(s.t, MON_8AM_ET - 5 * DAY_MS, async () => {
        await addGift(s.as, {
          amountCents: 4_400,
          name: "This Week",
          email: "week@example.com",
        });
      });
      cap.sent.length = 0;

      await atClock(s.t, MON_8AM_ET, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });

      expect(cap.sent).toHaveLength(1);
      // BOTH properties in one assertion pair. The trailing week is reported
      // even though the resume stamped the watermark two days ago…
      expect(cap.sent[0].html).toContain("This Week");
      // …and the ninety days it was switched off for are NOT replayed, because
      // the floor reaches back exactly one period and the watermark is `now`.
      expect(cap.sent[0].html).not.toContain("Dormant Era");
      expect(cap.sent[0].subject).toBe(
        "$44.00 from 1 gift this week — All books",
      );
    } finally {
      cap.restore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The breakdowns — three cuts of one number, each of which must add up
// ═══════════════════════════════════════════════════════════════════════════

describe("a digest breaks its total down, and every cut sums back to it", () => {
  test("by giving type and by chapter, against real gift rows", async () => {
    const s = await devDirectorSetup();
    await atClock(s.t, MON_8AM_ET - 30 * DAY_MS, async () => {
      await saveRule(s.as, {
        name: "Weekly roundup",
        cadence: "weekly",
        sendHourLocal: 8,
        sendWeekday: 1,
      });
    });

    // Written straight into the ledger, because `addGift` is the DESK's entry
    // point and deliberately takes none of the link fields — a pledge cycle and
    // an event donation are written by their own paths. The type cut has to be
    // driven by the real links on the rows, not by a hand-built payload.
    const at = MON_8AM_ET - 3 * DAY_MS;
    await run(s.t, async (ctx) => {
      const donor = async (name: string, scope: Id<"chapters"> | "central") =>
        ctx.db.insert("donors", {
          scope,
          kind: "individual" as const,
          name,
          status: "prospect" as const,
          lifetimeCents: 0,
          giftCount: 0,
          createdAt: MON_8AM_ET - 30 * DAY_MS,
        });
      const backerId = await donor("Backer", "central");
      const pledgeId = await ctx.db.insert("pledges", {
        donorId: backerId,
        scope: "central",
        amountCents: 5_000,
        status: "active",
        origin: "stripe",
        createdAt: MON_8AM_ET - 30 * DAY_MS,
      });
      const eventTypeId = await ctx.db.insert("eventTypes", {
        chapterId: s.chapterId,
        name: "Gala",
        slug: "gala",
        version: 1,
        createdBy: s.userId,
        createdAt: MON_8AM_ET - 30 * DAY_MS,
        updatedAt: MON_8AM_ET - 30 * DAY_MS,
      });
      const eventId = await ctx.db.insert("events", {
        chapterId: s.chapterId,
        eventTypeId,
        templateVersion: 1,
        name: "Summer Gala",
        eventDate: MON_8AM_ET,
        status: "planning",
        createdBy: s.userId,
        createdAt: MON_8AM_ET - 30 * DAY_MS,
        updatedAt: MON_8AM_ET - 30 * DAY_MS,
      });

      // $50 recurring, central — AND attached to the gala. Precedence decides:
      // recurring-ness is a fact about the payment mechanism, an `eventId` is a
      // tag a human can hang on any row, so it counts as Recurring.
      await ctx.db.insert("gifts", {
        donorId: backerId,
        scope: "central",
        amountCents: 5_000,
        currency: "usd",
        receivedAt: at,
        method: "stripe",
        pledgeId,
        eventId,
        createdAt: at,
      });
      // $75 event-attached, New York.
      await ctx.db.insert("gifts", {
        donorId: await donor("Gala Giver", s.chapterId),
        scope: s.chapterId,
        amountCents: 7_500,
        currency: "usd",
        receivedAt: at,
        method: "stripe",
        eventId,
        createdAt: at,
      });
      // $115 one-time, New York — nothing explains it but the desk.
      await ctx.db.insert("gifts", {
        donorId: await donor("Walk In", s.chapterId),
        scope: s.chapterId,
        amountCents: 11_500,
        currency: "usd",
        receivedAt: at,
        method: "cash",
        createdAt: at,
      });
    });

    const cap = captureEmails();
    try {
      cap.sent.length = 0;

      await atClock(s.t, MON_8AM_ET, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      expect(cap.sent).toHaveLength(1);
      const html = cap.sent[0].html;
      expect(cap.sent[0].subject).toBe(
        "$240.00 from 3 gifts this week — All books",
      );

      // All three sections are there…
      expect(html).toContain("By giving type");
      expect(html).toContain("By chapter");
      expect(html).toContain("How it arrived");

      // …the type cut names all three kinds, off the rows' own links…
      expect(html).toContain("Recurring");
      expect(html).toContain("Events");
      expect(html).toContain("One-time");

      // …the chapter cut uses real chapter names, with Central named Central…
      expect(html).toContain("New York");
      expect(html).toContain("Central");

      // …and every cut adds up to the headline. Four `Total:` lines at
      // $240.00: the summary panel's, plus one per section. A section that
      // dropped a gift on the floor would print a smaller number here.
      const totals = html.match(/Total:<\/span>\s*<span[^>]*>\$240\.00/g) ?? [];
      expect(totals).toHaveLength(4);
      // Each section counts all three gifts too — money AND count partition.
      expect(html.match(/\$240\.00 <span[^>]*>\(3\)/g) ?? []).toHaveLength(3);

      // The donor deep links survived the redesign.
      expect(html).toContain("https://publicworship.life/os/giving/donor/");
    } finally {
      cap.restore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// "This week" is the money that arrived this week
// ═══════════════════════════════════════════════════════════════════════════

/**
 * THE PRODUCTION BUG, reproduced to the cent.
 *
 * On 2026-08-07 a Givebutter historical import wrote 35 gifts received between
 * Nov 2025 and Mar 2026 — $8,963.03, including a $5,000.00 and a $2,000.00 wire
 * from March — into a week in which $261.00 actually arrived. The digest window
 * ranged on `createdAt`, so the owner's development team was mailed
 * `$9,224.03 from 44 gifts this week`, itemized under dates like `Nov 4, 2025`.
 * He asked whether this was months of giving history. It was.
 *
 * These are the real numbers. A guard against a 35× error has to be a figure
 * somebody can check against the ledger.
 */
const NOV_4_2025 = Date.parse("2025-11-04T17:00:00Z"); // noon ET
const DEC_31_2025 = Date.parse("2025-12-31T17:00:00Z");
const MAR_26_2026 = Date.parse("2026-03-26T16:00:00Z"); // noon EDT

/**
 * The 9 gifts that genuinely came in during the week: $261.00, spread across
 * the seven days and across three rails and both books — so every breakdown has
 * something to partition and "each cut sums to the headline" is a real claim
 * rather than one row restating the total.
 */
function realWeekGifts(
  chapterId: Id<"chapters">,
): Array<{
  receivedAt: number;
  amountCents: number;
  method: Doc<"gifts">["method"];
  scope: Id<"chapters"> | "central";
}> {
  const day = (n: number, hours = 10) =>
    MON_8AM_ET - n * DAY_MS + (hours - 8) * 60 * 60 * 1000;
  return [
    { receivedAt: day(6), amountCents: 2_500, method: "stripe", scope: "central" },
    { receivedAt: day(5), amountCents: 2_500, method: "stripe", scope: chapterId },
    { receivedAt: day(5, 15), amountCents: 2_500, method: "cash", scope: chapterId },
    { receivedAt: day(4), amountCents: 2_500, method: "stripe", scope: "central" },
    { receivedAt: day(3), amountCents: 6_100, method: "check", scope: "central" },
    { receivedAt: day(2), amountCents: 2_500, method: "stripe", scope: chapterId },
    { receivedAt: day(1), amountCents: 2_500, method: "stripe", scope: "central" },
    { receivedAt: day(1, 16), amountCents: 2_500, method: "cash", scope: chapterId },
    { receivedAt: day(0, 7), amountCents: 2_500, method: "stripe", scope: "central" },
  ];
}

/**
 * The 35 rows the import wrote on the Friday: $8,963.03 of old money, all of it
 * received months before the week and all of it keyed inside it.
 */
function importedGifts(): Array<{
  receivedAt: number;
  createdAt: number;
  amountCents: number;
}> {
  const friday = MON_8AM_ET - 3 * DAY_MS;
  const rows = [
    { receivedAt: NOV_4_2025, createdAt: friday, amountCents: 7_503 },
    { receivedAt: MAR_26_2026, createdAt: friday + 1, amountCents: 500_000 },
    { receivedAt: MAR_26_2026, createdAt: friday + 2, amountCents: 200_000 },
  ];
  for (let i = 0; i < 32; i++) {
    rows.push({
      receivedAt: DEC_31_2025,
      createdAt: friday + 3 + i,
      amountCents: 5_900,
    });
  }
  return rows;
}

describe("a digest reports the money that arrived, not the rows that were written", () => {
  test("44 gifts recorded this week, 35 of them received months ago: the headline is $261.00", async () => {
    const s = await devDirectorSetup();
    await atClock(s.t, MON_8AM_ET - 30 * DAY_MS, async () => {
      await saveRule(s.as, {
        name: "Weekly roundup",
        cadence: "weekly",
        sendHourLocal: 8,
        sendWeekday: 1,
      });
    });
    const donorId = await seedDonor(s, "Givebutter Import");
    await seedRawGifts(s, donorId, [...realWeekGifts(s.chapterId), ...importedGifts()]);

    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      expect(cap.sent).toHaveLength(1);
      const { subject, html } = cap.sent[0];

      // THE HEADLINE: the week that was, not the week the ledger was typed in.
      expect(subject).toBe("$261.00 from 9 gifts this week — All books");
      // The number that went out to a development team, and must never again.
      expect(subject).not.toContain("$9,224.03");
      expect(html).not.toContain("$9,224.03");
      expect(html).not.toContain("44 gifts");

      // EVERY FIGURE agrees. Four `Total:` lines at $261.00 — the summary panel
      // plus one per breakdown — and the count is 9, not 44.
      expect(
        html.match(/Total:<\/span>\s*<span[^>]*>\$261\.00/g) ?? [],
      ).toHaveLength(4);
      expect(html).toMatch(/Gifts:<\/span>\s*<span[^>]*>9</);
      expect(html.match(/\(44\)/g) ?? []).toHaveLength(0);
      // The largest gift is the largest of THIS WEEK's — not the March wire.
      expect(html).toContain("$61.00");

      // THE 35 APPEAR NOWHERE. Not in a total, not in a breakdown, not in the
      // list, not in a footnote. Their amounts and their dates are simply not
      // in this email — history is read in the giving ledger.
      expect(html).not.toContain("$5,000.00");
      expect(html).not.toContain("$2,000.00");
      expect(html).not.toContain("$75.03");
      expect(html).not.toContain("$59.00");
      expect(html).not.toContain("Nov 4, 2025");
      expect(html).not.toContain("Dec 31, 2025");
      expect(html).not.toContain("Mar 26, 2026");
      expect(html).not.toContain("35");
    } finally {
      cap.restore();
    }
  });

  test("a cheque that arrived Saturday and was keyed this morning IS this week's giving", async () => {
    // THE WHOLE REASON `receivedAt` IS THE RIGHT FIELD. The money came in on
    // Saturday; the row was written five minutes ago. A window on when rows are
    // WRITTEN would date it today, and a window on when money ARRIVED puts it
    // where it belongs — in the week it belongs to, at its own date.
    const s = await devDirectorSetup();
    await atClock(s.t, MON_8AM_ET - 30 * DAY_MS, async () => {
      await saveRule(s.as, {
        name: "Weekly roundup",
        cadence: "weekly",
        sendHourLocal: 8,
        sendWeekday: 1,
      });
    });
    const donorId = await seedDonor(s, "Late Desk Entry");
    await seedRawGifts(s, donorId, [
      {
        receivedAt: MON_8AM_ET - 2 * DAY_MS, // the money came on Saturday
        createdAt: MON_8AM_ET - 5 * 60 * 1000, // keyed five minutes ago
        amountCents: 11_500,
      },
      // A gift that arrived on Sunday and was recorded on Sunday — LATER money
      // than the cheque, EARLIER paperwork.
      {
        receivedAt: MON_8AM_ET - DAY_MS,
        amountCents: 2_000,
      },
    ]);

    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      expect(cap.sent).toHaveLength(1);
      expect(cap.sent[0].subject).toBe(
        "$135.00 from 2 gifts this week — All books",
      );
      const html = cap.sent[0].html;
      // Dated the day it arrived, not the morning it was typed.
      expect(html).toContain("Aug 8, 2026");
      // …and the list is ordered by ARRIVAL, newest first. Ordered by when the
      // rows were written, the Saturday cheque would lead — it was keyed last.
      // Sliced from the list's own heading, because the summary panel above it
      // names the largest gift and would confound a whole-document search.
      const list = html.slice(html.indexOf("Every gift"));
      expect(list.indexOf("$20.00")).toBeLessThan(list.indexOf("$115.00"));
    } finally {
      cap.restore();
    }
  });

  test("Send now previews exactly what the scheduled run reported", async () => {
    const s = await devDirectorSetup();
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, MON_8AM_ET - 30 * DAY_MS, async () => {
      ruleId = await saveRule(s.as, {
        name: "Weekly roundup",
        cadence: "weekly",
        sendHourLocal: 8,
        sendWeekday: 1,
      });
    });
    const donorId = await seedDonor(s, "Givebutter Import");
    await seedRawGifts(s, donorId, [...realWeekGifts(s.chapterId), ...importedGifts()]);

    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
        // Pressed at the same instant, so the two windows are the same window:
        // any difference in what they say is a difference in how they DECIDE,
        // which is the drift this asserts against.
        expect(await sendNow(s.as, ruleId)).toEqual({
          status: "sent",
          emailsSent: 1,
        });
      });
      expect(cap.sent).toHaveLength(2);
      const [scheduled, manual] = cap.sent;
      expect(manual.subject).toBe("$261.00 from 9 gifts this week — All books");
      expect(manual.subject).toBe(scheduled.subject);
      // Byte for byte. A preview that disagreed with the mail it previews is
      // worse than no preview.
      expect(manual.html).toBe(scheduled.html);
      expect(manual.html).not.toContain("$5,000.00");
    } finally {
      cap.restore();
    }
  });

  test("a gift backdated behind the watermark is in NO digest — the accepted cost, asserted", async () => {
    /**
     * THE PRICE OF WINDOWING ON A BACKDATABLE FIELD, pinned so it can never
     * change by accident.
     *
     * Under the old `createdAt` window a row could only ever appear AHEAD of the
     * watermark, so nothing was ever missed. `receivedAt` is backdatable, so a
     * gift keyed for a period already reported lands behind the watermark and no
     * later window reaches back for it.
     *
     * That is a decision, not a defect: the digest answers "what came in this
     * week" and the giving ledger holds the history. This test exists so that
     * anyone who thinks a digest should never miss a gift finds the trade
     * written down and asserted, rather than discovering it in production.
     */
    const s = await devDirectorSetup();
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, SETUP_AT, async () => {
      ruleId = await saveRule(s.as, { cadence: "daily", sendHourLocal: 8 });
    });
    const donorId = await seedDonor(s, "Sunday Cash");

    const cap = captureEmails();
    try {
      // Monday's digest reports Monday's giving and stamps a watermark.
      await seedRawGifts(s, donorId, [
        { receivedAt: MON_8AM_ET - 2 * 60 * 60 * 1000, amountCents: 5_000 },
      ]);
      await atClock(s.t, MON_8AM_ET, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      expect(cap.sent).toHaveLength(1);
      expect(cap.sent[0].subject).toBe(
        "$50.00 from 1 gift this day — All books",
      );
      const watermark = (await run(s.t, (ctx) => ctx.db.get(ruleId)))?.lastSentAt;
      expect(watermark).toBe(MON_8AM_ET - 60_000);
      cap.sent.length = 0;

      // Sunday's cash, counted and keyed on Tuesday morning: received BEFORE
      // Monday's watermark, written after it.
      await seedRawGifts(s, donorId, [
        {
          receivedAt: MON_8AM_ET - DAY_MS,
          createdAt: TUE_8AM_ET - 60 * 60 * 1000,
          amountCents: 90_000,
        },
      ]);

      await atClock(s.t, TUE_8AM_ET, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      // Tuesday's window opens strictly after Monday's watermark, so the
      // backdated $900 is not in it — and an empty daily sends nothing.
      expect(cap.sent).toHaveLength(0);
      // It is not reported LATER either: the watermark has moved past its date
      // for good. The immediate rules and the ledger are where it shows up.
      await atClock(s.t, TUE_8AM_ET + 25 * 60 * 60 * 1000, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      expect(cap.sent.some((m) => m.html.includes("$900.00"))).toBe(false);
    } finally {
      cap.restore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// `lastDeliveredAt` — has this rule ever actually mailed anybody?
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The desk needs to answer "has this ever gone out?" and `lastSentAt` cannot:
 * it is a WATERMARK, and both `setRuleActive` and a cadence change stamp it to
 * `now` on purpose. These pin the split — the watermark keeps doing its job,
 * and only a delivered email moves `lastDeliveredAt`.
 */
describe("a rule only claims to have sent when it has", () => {
  test("a delivered immediate email stamps the delivery, not the watermark", async () => {
    const s = await devDirectorSetup();
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, SETUP_AT, async () => {
      ruleId = await saveRule(s.as);
    });
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET, async () => {
        await addGift(s.as, { amountCents: 50_000 });
      });
      expect(cap.sent).toHaveLength(1);
      const row = await run(s.t, (ctx) => ctx.db.get(ruleId));
      expect(row?.lastDeliveredAt).toBe(MON_8AM_ET);
      // An immediate rule has no window, so nothing should have touched it.
      expect(row?.lastSentAt).toBeUndefined();
    } finally {
      cap.restore();
    }
  });

  test("pausing and resuming a rule that has never sent does NOT make it claim it has", async () => {
    // THE BUG THIS FIELD EXISTS FOR. Reactivation stamps `lastSentAt = now` so
    // the rule reports from here rather than replaying its dormancy — correct,
    // and it used to render on the desk as "Last sent <today>" for a rule that
    // had mailed precisely nobody.
    const s = await devDirectorSetup();
    const ruleId = await saveRule(s.as, { cadence: "weekly" });

    await s.as.mutation(api.givingNotifications.setRuleActive, {
      ruleId,
      isActive: false,
    });
    await s.as.mutation(api.givingNotifications.setRuleActive, {
      ruleId,
      isActive: true,
    });

    const row = await run(s.t, (ctx) => ctx.db.get(ruleId));
    expect(row?.isActive).toBe(true);
    expect(row?.lastSentAt).toEqual(expect.any(Number)); // the watermark moved…
    expect(row?.lastDeliveredAt).toBeUndefined(); // …and it still hasn't sent.

    const [listed] = await s.as.query(api.givingNotifications.listRules, {});
    expect(listed.lastDeliveredAt).toBeUndefined();
    expect(listed.lastSentAt).toEqual(expect.any(Number));
  });

  test("a cadence change moves the watermark and leaves the delivery mark alone", async () => {
    const s = await devDirectorSetup();
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, SETUP_AT, async () => {
      ruleId = await saveRule(s.as, { cadence: "daily", sendHourLocal: 8 });
    });
    await s.as.mutation(api.givingNotifications.saveRule, {
      ruleId,
      name: "Every gift",
      recipients: ["dev@publicworship.life"],
      cadence: "weekly",
      scope: "all",
      sendHourLocal: 8,
      sendWeekday: 1,
    } as never);
    const row = await run(s.t, (ctx) => ctx.db.get(ruleId));
    expect(row?.lastSentAt).toEqual(expect.any(Number));
    expect(row?.lastDeliveredAt).toBeUndefined();
  });

  test("a Resend outage sends nothing, so it stamps nothing", async () => {
    const s = await devDirectorSetup();
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, SETUP_AT, async () => {
      ruleId = await saveRule(s.as);
    });
    const realFetch = globalThis.fetch;
    const prevKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "resend_test_key";
    globalThis.fetch = (async () => {
      throw new Error("Resend is down");
    }) as unknown as typeof fetch;
    try {
      await atClock(s.t, MON_8AM_ET, async () => {
        await addGift(s.as, { amountCents: 50_000 });
      });
      const row = await run(s.t, (ctx) => ctx.db.get(ruleId));
      expect(row?.lastDeliveredAt).toBeUndefined();
    } finally {
      globalThis.fetch = realFetch;
      if (prevKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevKey;
    }
  });

  test("a rule below the floor mails nobody, so it stamps nothing", async () => {
    const s = await devDirectorSetup();
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, SETUP_AT, async () => {
      ruleId = await saveRule(s.as, { minAmountCents: 50_000 });
    });
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET, async () => {
        await addGift(s.as, { amountCents: 49_999 });
      });
      expect(cap.sent).toHaveLength(0);
      const row = await run(s.t, (ctx) => ctx.db.get(ruleId));
      expect(row?.lastDeliveredAt).toBeUndefined();
    } finally {
      cap.restore();
    }
  });

  test("a delivered digest stamps both — the window it reported AND the fact it mailed", async () => {
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
      const row = await run(s.t, (ctx) => ctx.db.get(ruleId));
      expect(row?.lastSentAt).toBe(MON_8AM_ET - 60_000); // the window
      expect(row?.lastDeliveredAt).toBe(MON_8AM_ET); // the email
    } finally {
      cap.restore();
    }
  });

  test("a digest that reached nobody releases its window and stamps no delivery", async () => {
    const s = await devDirectorSetup();
    await atClock(s.t, SETUP_AT, async () => {
      await saveRule(s.as, {
        cadence: "weekly",
        sendHourLocal: 8,
        sendWeekday: 1,
      });
    });
    const realFetch = globalThis.fetch;
    const prevKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = "resend_test_key";
    globalThis.fetch = (async () => {
      throw new Error("Resend is down");
    }) as unknown as typeof fetch;
    try {
      await atClock(s.t, MON_8AM_ET, async () => {
        const out = await s.t.action(
          internal.givingNotificationDigests.sendGivingDigests,
          {},
        );
        expect(out).toMatchObject({ digestsSent: 0, failedRules: 1 });
      });
      const [listed] = await s.as.query(api.givingNotifications.listRules, {});
      // The window went back (so the next run re-reads it) and nothing claims
      // an email went out.
      expect(listed.lastSentAt).toBeUndefined();
      expect(listed.lastDeliveredAt).toBeUndefined();
    } finally {
      globalThis.fetch = realFetch;
      if (prevKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prevKey;
    }
  });

  test("two rules sharing one recipient both record that they delivered", async () => {
    const s = await devDirectorSetup();
    let everyGift!: Id<"givingNotificationRules">;
    let bigGifts!: Id<"givingNotificationRules">;
    await atClock(s.t, SETUP_AT, async () => {
      everyGift = await saveRule(s.as, {
        name: "Every gift",
        recipients: ["dev@publicworship.life"],
      });
      bigGifts = await saveRule(s.as, {
        name: "Big gifts",
        minAmountCents: 50_000,
        recipients: ["dev@publicworship.life"],
      });
    });
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_8AM_ET, async () => {
        await addGift(s.as, { amountCents: 50_000 });
      });
      // ONE email, naming both rules — and both rules know they sent it.
      expect(cap.sent).toHaveLength(1);
      const a = await run(s.t, (ctx) => ctx.db.get(everyGift));
      const b = await run(s.t, (ctx) => ctx.db.get(bigGifts));
      expect(a?.lastDeliveredAt).toBe(MON_8AM_ET);
      expect(b?.lastDeliveredAt).toBe(MON_8AM_ET);
    } finally {
      cap.restore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Who aimed this mailer, and where
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A rule keeps mailing donor names and gift amounts after its author's seat is
 * revoked — the send paths bound each email by the RULE's scope and never
 * re-check a caller, because a cron has no caller. So the only defence is the
 * record made at write time, and widening the gate to `giving.view` widened who
 * can write.
 */
describe("a rule names who last touched it, and keeps the trail", () => {
  async function auditFor(
    s: ChapterSetup,
    ruleId: Id<"givingNotificationRules">,
  ) {
    return await run(s.t, (ctx) =>
      ctx.db
        .query("givingNotificationRuleAudit")
        .withIndex("by_rule", (q) => q.eq("ruleId", ruleId))
        .collect(),
    );
  }

  test("creating writes updatedBy and a `created` breadcrumb", async () => {
    const s = await devDirectorSetup();
    const ruleId = await saveRule(s.as, { scope: s.chapterId });
    const row = await run(s.t, (ctx) => ctx.db.get(ruleId));
    expect(row?.updatedBy).toBe(row?.createdBy);

    const trail = await auditFor(s, ruleId);
    expect(trail.map((a) => a.action)).toEqual(["created"]);
    // A bare create carries no diff — there is nothing it changed FROM.
    expect(trail[0].changes).toBeUndefined();
  });

  test("an edit by someone else re-points updatedBy — createdBy does NOT move", async () => {
    // THE MISATTRIBUTION this closes: central authors a rule, a chapter viewer
    // re-points it at their own inbox, and the row went on naming central.
    const s = await devDirectorSetup();
    const viewer = await seatChapterViewer(s, s.chapterId);
    const ruleId = await saveRule(s.as, {
      name: "New York gifts",
      scope: s.chapterId,
      recipients: ["dev@publicworship.life"],
    });
    const before = await run(s.t, (ctx) => ctx.db.get(ruleId));

    await saveRule(viewer, {
      ruleId,
      name: "New York gifts",
      scope: s.chapterId,
      recipients: ["me@personal.example"],
    });

    const after = await run(s.t, (ctx) => ctx.db.get(ruleId));
    expect(after?.createdBy).toBe(before?.createdBy);
    expect(after?.updatedBy).not.toBe(before?.createdBy);

    // And the desk SHOWS it — the flag is worthless if the list still reads
    // like nothing happened.
    const listed = await viewer.query(api.givingNotifications.listRules, {});
    const shown = listed.find((r) => r._id === ruleId);
    expect(shown?.updatedByName).toBe("chapdir@publicworship.life");
  });

  test("the retarget is recorded with the addresses it moved between", async () => {
    // "Who did this start mailing" is the whole question, so recipients are
    // diffed in full rather than summarized.
    const s = await devDirectorSetup();
    const viewer = await seatChapterViewer(s, s.chapterId);
    const ruleId = await saveRule(s.as, {
      name: "New York gifts",
      scope: s.chapterId,
      recipients: ["dev@publicworship.life"],
    });
    await saveRule(viewer, {
      ruleId,
      name: "New York gifts",
      scope: s.chapterId,
      recipients: ["me@personal.example"],
    });

    const trail = await auditFor(s, ruleId);
    expect(trail.map((a) => a.action)).toEqual(["created", "edited"]);
    const recipients = trail[1].changes?.find((c) => c.field === "Recipients");
    expect(recipients?.from).toBe("dev@publicworship.life");
    expect(recipients?.to).toBe("me@personal.example");
  });

  test("a scope move is stamped with the book it LEFT, and names both", async () => {
    const s = await devDirectorSetup();
    const ruleId = await saveRule(s.as, {
      name: "Moving",
      scope: s.chapterId,
    });
    await saveRule(s.as, { ruleId, name: "Moving", scope: "central" });

    const trail = await auditFor(s, ruleId);
    const move = trail[1];
    // The row is filed under the book it could reach at the time.
    expect(move.scope).toBe(s.chapterId);
    const book = move.changes?.find((c) => c.field === "Book");
    expect(book?.from).toBe("New York");
    expect(book?.to).toBe("Central");
  });

  test("pausing and resuming are recorded, and a no-op is not", async () => {
    const s = await devDirectorSetup();
    const viewer = await seatChapterViewer(s, s.chapterId);
    const ruleId = await saveRule(s.as, { scope: s.chapterId });

    await viewer.mutation(api.givingNotifications.setRuleActive, {
      ruleId,
      isActive: false,
    });
    // Idempotent — the switch fires on every render, and a trail padded with
    // no-op rows is a trail nobody reads.
    await viewer.mutation(api.givingNotifications.setRuleActive, {
      ruleId,
      isActive: false,
    });
    await viewer.mutation(api.givingNotifications.setRuleActive, {
      ruleId,
      isActive: true,
    });

    const trail = await auditFor(s, ruleId);
    expect(trail.map((a) => a.action)).toEqual([
      "created",
      "deactivated",
      "activated",
    ]);
    // And the switch names its actor too — turning a mailer off and on is a
    // change to who hears about money.
    const row = await run(s.t, (ctx) => ctx.db.get(ruleId));
    expect(row?.updatedBy).not.toBe(row?.createdBy);
  });

  test("the trail is immutable — later edits append, never rewrite", async () => {
    // The reason a bare `updatedBy` wasn't enough: the next editor overwrites
    // it, and the next editor is exactly who you'd want to catch.
    const s = await devDirectorSetup();
    const viewer = await seatChapterViewer(s, s.chapterId);
    const ruleId = await saveRule(s.as, {
      name: "Rule",
      scope: s.chapterId,
      recipients: ["dev@publicworship.life"],
    });
    await saveRule(viewer, {
      ruleId,
      name: "Rule",
      scope: s.chapterId,
      recipients: ["me@personal.example"],
    });
    await saveRule(s.as, {
      ruleId,
      name: "Rule",
      scope: s.chapterId,
      recipients: ["dev@publicworship.life"],
    });

    const row = await run(s.t, (ctx) => ctx.db.get(ruleId));
    // The row now names central again — it has forgotten the detour.
    expect(row?.updatedBy).toBe(row?.createdBy);
    // The trail has not.
    const trail = await auditFor(s, ruleId);
    expect(trail).toHaveLength(3);
    expect(trail[1].changes?.find((c) => c.field === "Recipients")?.to).toBe(
      "me@personal.example",
    );
  });

  test("a rule written before the field existed reports no editor", async () => {
    // Backfill-free: `updatedBy` is optional, and the desk omits the line
    // rather than guessing the author was the last toucher.
    const s = await devDirectorSetup();
    const ruleId = await saveRule(s.as, { scope: s.chapterId });
    await run(s.t, (ctx) => ctx.db.patch(ruleId, { updatedBy: undefined }));
    const listed = await s.as.query(api.givingNotifications.listRules, {});
    expect(listed.find((r) => r._id === ruleId)?.updatedByName).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// One screen, one answer about who you are
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The Notifications screen reads `listRules` (for the per-row edit affordances)
 * and `givingPlatform.givingScopeOptions` (for the book picker on the create
 * form). They must agree about what the caller may do, or the screen offers
 * Edit on a row while refusing to offer the book to create one in. This test
 * lives here rather than in `givingPlatform.test.ts` because the disagreement
 * is only visible when both are asked at once, which is what this screen does.
 *
 * Since the rule gate became giving VIEW (2026-08-10), the picker no longer
 * reads `option.canManage` at all — that field still means "may record a GIFT
 * in this book", a narrower power the Gifts screen asks about. It reads the
 * OFFER instead: `givingScopeOptions.options` is built from the caller's view
 * reach, so a book being listed is exactly "a book a rule may watch", and
 * `canSeeAllScopes` is exactly "may watch every book". `ruleScopeChoices` in
 * the mobile app is that derivation; `offersBook` below is the same statement
 * on this side of the wire.
 */
describe("listRules and givingScopeOptions agree about manage rights", () => {
  /** Would the screen's book picker offer `scope`? Mirrors
   *  `components/giving/notificationRules.ts#ruleScopeChoices`. */
  function offersBook(
    opts: { canSeeAllScopes: boolean; options: { scope: string }[] },
    scope: string,
  ): boolean {
    if (scope === "all") return opts.canSeeAllScopes;
    return opts.options.some((o) => o.scope === scope);
  }

  /** Central `giving.view` (and nothing more at central) PLUS chapter-scope
   *  `giving.manage` — the seat shape the two queries used to disagree about. */
  async function seatCentralViewerWithChapterManage(
    s: ChapterSetup,
    chapterId: Id<"chapters">,
  ): Promise<ChapterSetup["as"]> {
    const userId = await run(s.t, async (ctx) => {
      const userId = await ctx.db.insert("users", {
        email: "mixed@publicworship.life",
      });
      const personId = await ctx.db.insert("people", {
        chapterId,
        name: "Central Viewer, Chapter Manager",
        userId,
        createdAt: Date.now(),
      });
      const now = Date.now();
      const centralSeat = await ctx.db.insert("seatDefs", {
        slug: "test_central_giving_viewer",
        title: "Central Giving Viewer (test)",
        chart: "central",
        parentSlug: "executive_director",
        maxHolders: 1,
        duties: [],
        capabilities: ["giving.view", "nav.giving"],
        sortOrder: 9998,
        createdAt: now,
        updatedAt: now,
      });
      const chapterSeat = await ctx.db.insert("seatDefs", {
        slug: "test_chapter_giving_manager_mixed",
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
        seatDefId: centralSeat,
        scope: "central",
        personId,
        createdAt: now,
      });
      await ctx.db.insert("seatAssignments", {
        seatDefId: chapterSeat,
        scope: chapterId,
        personId,
        createdAt: now,
      });
      return userId;
    });
    return s.t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
  }

  test("a central VIEWER who manages one chapter can both edit and create there", async () => {
    const s = await devDirectorSetup();
    const mixed = await seatCentralViewerWithChapterManage(s, s.chapterId);
    await saveRule(s.as, { name: "Chapter rule", scope: s.chapterId });
    await saveRule(s.as, { name: "Central rule", scope: "central" });
    await saveRule(s.as, { name: "Org-wide rule", scope: "all" });

    const rules = await mixed.query(api.givingNotifications.listRules, {});
    const byName = new Map(rules.map((r) => [r.name, r]));
    // Central VIEW reaches every book, so all three rules are theirs to work.
    expect(byName.get("Chapter rule")?.canManage).toBe(true);
    expect(byName.get("Central rule")?.canManage).toBe(true);
    expect(byName.get("Org-wide rule")?.canManage).toBe(true);

    const opts = await mixed.query(api.givingPlatform.givingScopeOptions, {});
    const byScope = new Map(opts.options.map((o) => [o.scope as string, o]));
    // The gift powers are UNCHANGED by any of this, and the bug this half of
    // the test was written for stays fixed: central view sent this caller down
    // the central branch, which stamped every option from central MANAGE — so
    // the chapter they genuinely manage came back unmanageable.
    expect(byScope.get(s.chapterId)?.canManage).toBe(true);
    expect(byScope.get("central")?.canManage).toBe(false);
    expect(opts.canManageCentral).toBe(false);

    // The invariant, stated directly: for every rule this caller can see, the
    // picker offers the book it lives in. Row affordance and create affordance
    // cannot contradict each other.
    expect(rules.length).toBe(3);
    for (const rule of rules) {
      expect(offersBook(opts, rule.scope as string)).toBe(rule.canManage);
    }
  });

  test("a chapter VIEWER's rows and picker agree, and neither reaches further", async () => {
    const s = await devDirectorSetup();
    const other = await run(s.t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "Los Angeles",
        slug: "los-angeles",
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    const viewer = await seatChapterViewer(s, s.chapterId);
    await saveRule(s.as, { name: "Chapter rule", scope: s.chapterId });
    await saveRule(s.as, { name: "Central rule", scope: "central" });
    await saveRule(s.as, { name: "Org-wide rule", scope: "all" });
    await saveRule(s.as, { name: "Sibling rule", scope: other });

    const rules = await viewer.query(api.givingNotifications.listRules, {});
    expect(rules.map((r) => r.name)).toEqual(["Chapter rule"]);

    const opts = await viewer.query(api.givingPlatform.givingScopeOptions, {});
    // One book offered, and it is theirs. Not central, not "all", not the
    // sibling chapter — the containment the widened gate had to preserve.
    expect(opts.canSeeAllScopes).toBe(false);
    expect(opts.options.map((o) => o.scope)).toEqual([s.chapterId]);
    expect(offersBook(opts, "all")).toBe(false);
    expect(offersBook(opts, "central")).toBe(false);
    expect(offersBook(opts, other)).toBe(false);

    for (const rule of rules) {
      expect(offersBook(opts, rule.scope as string)).toBe(rule.canManage);
    }
  });

  test("a central MANAGER still manages every book", async () => {
    const s = await devDirectorSetup();
    const opts = await s.as.query(api.givingPlatform.givingScopeOptions, {});
    expect(opts.canManageCentral).toBe(true);
    expect(opts.options.every((o) => o.canManage)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// "Send now" — an on-demand digest
// ═══════════════════════════════════════════════════════════════════════════

/** Every mark the send-now path promises not to touch, plus the two fields a
 *  patch would move as a side effect. Read as a set, compared as a set — the
 *  whole design rests on this tuple being identical before and after. */
async function marksOf(
  s: ChapterSetup,
  ruleId: Id<"givingNotificationRules">,
): Promise<Record<string, unknown>> {
  const row = await run(s.t, (ctx) => ctx.db.get(ruleId));
  return {
    lastSentAt: row?.lastSentAt,
    lastRunDayKey: row?.lastRunDayKey,
    watermarkFromRun: row?.watermarkFromRun,
    updatedAt: row?.updatedAt,
  };
}

async function sendNow(
  as: ChapterSetup["as"],
  ruleId: Id<"givingNotificationRules">,
): Promise<{ status: string; emailsSent: number }> {
  return await as.action(api.givingNotificationDigests.sendDigestNow, {
    ruleId,
  });
}

describe("send now", () => {
  test("the owner's Monday: a rule that already ran at 08:00 previews the WHOLE week, gifts it already reported included", async () => {
    // THE BUG THIS EXISTS FOR, end to end. The 08:00 run went out and stamped a
    // report-provenance watermark, so the rule is emphatically not due and
    // "everything since the last digest" is barely an hour. Pressing Send now
    // has to answer the question actually being asked — "what does my weekly
    // digest look like?" — which means the trailing SEVEN DAYS, including the
    // gifts the 08:00 run already mailed.
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
      // Two days before the run — inside the trailing week, and reported by it.
      await atClock(s.t, MON_8AM_ET - 2 * DAY_MS, async () => {
        await addGift(s.as, { amountCents: 11_500, name: "Ada Donor" });
      });
      cap.sent.length = 0;

      await atClock(s.t, MON_8AM_ET, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      expect(cap.sent).toHaveLength(1);
      expect(cap.sent[0].html).toContain("Ada Donor");
      cap.sent.length = 0;

      // A gift lands after that run's watermark.
      await atClock(s.t, MON_8AM_ET + 30 * 60 * 1000, async () => {
        await addGift(s.as, {
          amountCents: 4_000,
          name: "Bea Donor",
          email: "bea@example.com",
        });
      });
      cap.sent.length = 0;

      const before = await marksOf(s, ruleId);
      // The premise: the rule carries a REPORT-provenance watermark and is
      // stamped for the day, so the scheduled sweep does nothing at 09:00.
      expect(before.watermarkFromRun).toBe(true);
      expect(before.lastSentAt).toBe(MON_8AM_ET - 60_000);
      expect(before.lastRunDayKey).toBe(localParts(MON_8AM_ET).dayKey);
      await atClock(s.t, MON_9AM_ET, async () => {
        const out = await s.t.action(
          internal.givingNotificationDigests.sendGivingDigests,
          {},
        );
        expect(out).toMatchObject({ digestsSent: 0 });
      });
      expect(cap.sent).toHaveLength(0);

      await atClock(s.t, MON_9AM_ET, async () => {
        expect(await sendNow(s.as, ruleId)).toEqual({
          status: "sent",
          emailsSent: 1,
        });
      });

      expect(cap.sent).toHaveLength(1);
      expect(cap.sent[0].to).toBe("dev@publicworship.life");
      // THE PROPERTY: the trailing week, both gifts, totalled — not the
      // one-hour sliver left of the watermark's window. Ada was already mailed
      // by the 08:00 run and appears again, on purpose: this is a preview of
      // the PERIOD, not a claim about what is new.
      expect(cap.sent[0].subject).toBe("$155.00 from 2 gifts this week — All books");
      expect(cap.sent[0].html).toContain("Ada Donor");
      expect(cap.sent[0].html).toContain("Bea Donor");

      // NOT ONE MARK MOVED — actual field values, before and after. This is
      // what makes reaching past the watermark safe: the preview neither reads
      // the scheduling state nor writes it, so it cannot desync it.
      expect(await marksOf(s, ruleId)).toEqual(before);

      // And the cron keeps its own semantics exactly. Next Monday resumes from
      // the watermark: Bea, who has not been scheduled-reported, and NOT Ada,
      // who has.
      cap.sent.length = 0;
      await atClock(s.t, MON_8AM_ET + 7 * DAY_MS, async () => {
        const out = await s.t.action(
          internal.givingNotificationDigests.sendGivingDigests,
          {},
        );
        expect(out).toMatchObject({ digestsSent: 1 });
      });
      expect(cap.sent).toHaveLength(1);
      expect(cap.sent[0].html).toContain("Bea Donor");
      expect(cap.sent[0].html).not.toContain("Ada Donor");
    } finally {
      cap.restore();
    }
  });

  test("the trailing period is the CADENCE's, so a daily previews a day and not a week", async () => {
    // Pins that `sendNowWindowStart` consults the cadence rather than hardcoding
    // one period. A weekly preview would have swept both of these up.
    const s = await devDirectorSetup();
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, SETUP_AT, async () => {
      ruleId = await saveRule(s.as, { cadence: "daily", sendHourLocal: 8 });
    });
    const cap = captureEmails();
    try {
      // 30 hours before the press: inside a week, OUTSIDE a day.
      await atClock(s.t, MON_9AM_ET - 30 * 60 * 60 * 1000, async () => {
        await addGift(s.as, { amountCents: 90_000, name: "Old Donor" });
      });
      // 12 hours before: inside the trailing day, and already reported by the
      // 08:00 run below.
      await atClock(s.t, MON_9AM_ET - 12 * 60 * 60 * 1000, async () => {
        await addGift(s.as, {
          amountCents: 6_000,
          name: "Recent Donor",
          email: "recent@example.com",
        });
      });
      await atClock(s.t, MON_8AM_ET, async () => {
        await s.t.action(internal.givingNotificationDigests.sendGivingDigests, {});
      });
      cap.sent.length = 0;

      await atClock(s.t, MON_9AM_ET, async () => {
        expect((await sendNow(s.as, ruleId)).status).toBe("sent");
      });
      expect(cap.sent).toHaveLength(1);
      expect(cap.sent[0].html).toContain("Recent Donor");
      expect(cap.sent[0].html).not.toContain("Old Donor");
      expect(cap.sent[0].subject).toBe("$60.00 from 1 gift this day — All books");
    } finally {
      cap.restore();
    }
  });

  test("delivery IS stamped — the row that offers the button shows it worked", async () => {
    const s = await devDirectorSetup();
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, SETUP_AT, async () => {
      ruleId = await saveRule(s.as, {
        cadence: "weekly",
        sendHourLocal: 8,
        sendWeekday: 1,
      });
    });
    const cap = captureEmails();
    try {
      const before = await run(s.t, (ctx) => ctx.db.get(ruleId));
      expect(before?.lastDeliveredAt).toBeUndefined();
      await atClock(s.t, MON_9AM_ET, async () => {
        expect((await sendNow(s.as, ruleId)).status).toBe("sent");
      });
      const after = await run(s.t, (ctx) => ctx.db.get(ruleId));
      expect(after?.lastDeliveredAt).toBe(MON_9AM_ET);
      // …without pretending anybody edited the rule.
      expect(after?.updatedAt).toBe(before?.updatedAt);
    } finally {
      cap.restore();
    }
  });

  test("a caller with no reach into the rule's book is refused, and nothing is mailed", async () => {
    const s = await devDirectorSetup();
    const viewer = await seatChapterViewer(s, s.chapterId);
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, SETUP_AT, async () => {
      // CENTRAL's rule. The chapter director holds `giving.view` of New York
      // and nothing else, so `canManageRuleScope` refuses — the same gate that
      // stops them editing or pausing it.
      ruleId = await saveRule(s.as, {
        name: "Central weekly",
        cadence: "weekly",
        scope: "central",
        sendHourLocal: 8,
        sendWeekday: 1,
      });
    });
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_9AM_ET, async () => {
        await expect(sendNow(viewer, ruleId)).rejects.toThrow(ConvexError);
      });
      expect(cap.sent).toHaveLength(0);
      // A refused press is not an attempt: it costs the rule's hourly budget
      // nothing, so a stranger can't exhaust it on the owner's behalf.
      const attempts = await run(s.t, (ctx) =>
        ctx.db.query("givingDigestSendNowAttempts").collect(),
      );
      expect(attempts).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });

  test("a caller who CAN reach the book sends it", async () => {
    // The other half of the gate: view of the rule's own book is enough, which
    // is the 2026-08-10 decision this affordance inherits.
    const s = await devDirectorSetup();
    const viewer = await seatChapterViewer(s, s.chapterId);
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, SETUP_AT, async () => {
      ruleId = await saveRule(s.as, {
        name: "New York weekly",
        cadence: "weekly",
        scope: s.chapterId,
        sendHourLocal: 8,
        sendWeekday: 1,
      });
    });
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_9AM_ET, async () => {
        expect((await sendNow(viewer, ruleId)).status).toBe("sent");
      });
      expect(cap.sent).toHaveLength(1);
    } finally {
      cap.restore();
    }
  });

  test("no mailer configured says so, rather than looking like a bounce", async () => {
    const s = await devDirectorSetup();
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, SETUP_AT, async () => {
      ruleId = await saveRule(s.as, {
        cadence: "weekly",
        sendHourLocal: 8,
        sendWeekday: 1,
      });
    });
    const prev = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      await atClock(s.t, MON_9AM_ET, async () => {
        expect(await sendNow(s.as, ruleId)).toEqual({
          status: "no_mailer",
          emailsSent: 0,
        });
      });
      const row = await run(s.t, (ctx) => ctx.db.get(ruleId));
      expect(row?.lastDeliveredAt).toBeUndefined();
      expect(row?.lastSentAt).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = prev;
    }
  });

  test("an empty DAILY period sends nothing — and unlike the sweep, doesn't stamp the day", async () => {
    const s = await devDirectorSetup();
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, SETUP_AT, async () => {
      ruleId = await saveRule(s.as, { cadence: "daily", sendHourLocal: 8 });
    });
    const cap = captureEmails();
    try {
      const before = await marksOf(s, ruleId);
      // Nothing in the whole trailing DAY, not merely nothing since the last
      // run — the manual window is the nominal period, so this message is the
      // rare and meaningful one it sounds like.
      await atClock(s.t, MON_9AM_ET, async () => {
        expect(await sendNow(s.as, ruleId)).toEqual({
          status: "empty_window",
          emailsSent: 0,
        });
      });
      expect(cap.sent).toHaveLength(0);
      // The SCHEDULED empty daily stamps `lastRunDayKey` (so `>=`-hour matching
      // doesn't re-scan all day). A preview must not: stamping it here would
      // let a press at 07:00 cancel the 08:00 digest outright.
      expect(await marksOf(s, ruleId)).toEqual(before);
    } finally {
      cap.restore();
    }
  });

  test("three presses an hour, and the fourth is refused", async () => {
    const s = await devDirectorSetup();
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, SETUP_AT, async () => {
      ruleId = await saveRule(s.as, {
        cadence: "weekly",
        sendHourLocal: 8,
        sendWeekday: 1,
      });
    });
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_9AM_ET, async () => {
        for (let i = 0; i < SEND_NOW_MAX_PER_RULE; i++) {
          expect((await sendNow(s.as, ruleId)).status).toBe("sent");
        }
        await expect(sendNow(s.as, ruleId)).rejects.toThrow(ConvexError);
      });
      expect(cap.sent).toHaveLength(SEND_NOW_MAX_PER_RULE);

      // An hour later the window has rolled and the budget is back.
      await atClock(s.t, MON_9AM_ET + 60 * 60 * 1000 + 1, async () => {
        expect((await sendNow(s.as, ruleId)).status).toBe("sent");
      });
      expect(cap.sent).toHaveLength(SEND_NOW_MAX_PER_RULE + 1);
    } finally {
      cap.restore();
    }
  });

  test("the budget is per RULE, not per caller", async () => {
    // Two people with reach into the same book must not get a budget each —
    // the cost of this button falls on the recipients, who only have one inbox.
    const s = await devDirectorSetup();
    const viewer = await seatChapterViewer(s, s.chapterId);
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, SETUP_AT, async () => {
      ruleId = await saveRule(s.as, {
        cadence: "weekly",
        scope: s.chapterId,
        sendHourLocal: 8,
        sendWeekday: 1,
      });
    });
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_9AM_ET, async () => {
        for (let i = 0; i < SEND_NOW_MAX_PER_RULE; i++) {
          expect((await sendNow(s.as, ruleId)).status).toBe("sent");
        }
        await expect(sendNow(viewer, ruleId)).rejects.toThrow(ConvexError);
      });
      expect(cap.sent).toHaveLength(SEND_NOW_MAX_PER_RULE);
    } finally {
      cap.restore();
    }
  });

  test("a paused rule refuses, rather than mailing a false 'no giving this week'", async () => {
    const s = await devDirectorSetup();
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, SETUP_AT, async () => {
      ruleId = await saveRule(s.as, {
        cadence: "weekly",
        sendHourLocal: 8,
        sendWeekday: 1,
      });
      await s.as.mutation(api.givingNotifications.setRuleActive, {
        ruleId,
        isActive: false,
      });
    });
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_9AM_ET, async () => {
        await expect(sendNow(s.as, ruleId)).rejects.toThrow(ConvexError);
      });
      expect(cap.sent).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });

  test("an immediate rule has no digest to send", async () => {
    const s = await devDirectorSetup();
    let ruleId!: Id<"givingNotificationRules">;
    await atClock(s.t, SETUP_AT, async () => {
      ruleId = await saveRule(s.as, { cadence: "immediate" });
    });
    const cap = captureEmails();
    try {
      await atClock(s.t, MON_9AM_ET, async () => {
        await expect(sendNow(s.as, ruleId)).rejects.toThrow(ConvexError);
      });
      expect(cap.sent).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });
});
