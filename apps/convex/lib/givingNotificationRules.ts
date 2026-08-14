/**
 * Giving notification rules — matching, validation, and the digest clock.
 *
 * Everything here is PURE (no `ctx`, no I/O) so the parts that are easy to get
 * subtly wrong — an off-by-one on a threshold, a digest that reports the same
 * gift twice — are testable without a database.
 *
 * ── THE DELIBERATE ASYMMETRY: empty daily vs empty weekly ──────────────────
 * An empty DAILY digest is NOT sent, and an empty WEEKLY digest IS.
 *
 * They look inconsistent and they are, on purpose. Most days no gift arrives,
 * so a daily "nothing came in" is a mail the recipient learns to delete
 * unread — and a recipient who deletes the daily unread will delete the one
 * that matters too. A WEEK with no giving is a different thing entirely: for
 * the people this is built for it is the single most actionable sentence the
 * system can say, and its absence would be indistinguishable from the job
 * being broken. The weekly email is therefore also the heartbeat that proves
 * the pipeline is alive.
 *
 * ── TWO MARKS, BECAUSE THEY ANSWER TWO QUESTIONS ───────────────────────────
 * `lastSentAt` means "the window has been REPORTED up to here" — a fact about
 * money. `lastRunDayKey` means "this rule has already been LOOKED AT today" —
 * a fact about scheduling. A skipped empty daily stamps the second and not the
 * first: the window carries forward so no gift can fall between two runs, and
 * the rule still doesn't re-scan on every remaining hour of the day.
 *
 * One field could not do both once the hour test became `>=` (a catch-up
 * match, so a rule is "due" for the rest of the day), and conflating them is
 * how a window that has to move for correctness starts silencing a rule that
 * has to keep firing.
 *
 * ── THE WINDOW IS ON `receivedAt` — WHEN THE MONEY ARRIVED ─────────────────
 * "Giving this week" means money that came in this week. Every window bound,
 * and therefore every figure a digest reports, is `gifts.receivedAt`.
 *
 * It used to be `createdAt` — when the LEDGER learned of the gift — and that is
 * the worst bug this feature has had. On 2026-08-07 a Givebutter historical
 * import wrote 35 gifts received between Nov 2025 and Mar 2026, and the
 * following weekly digest told the development team `$9,224.03 from 44 gifts
 * this week` about a week in which $261.00 arrived: 35× the truth, itemized
 * under dates like `Nov 4, 2025`, including a $5,000.00 wire from March. A
 * digest that reports the wrong number by a factor of 35 whenever anyone
 * imports anything is not a digest.
 *
 * THE COST, NAMED RATHER THAN HIDDEN. `receivedAt` is freely backdatable, so a
 * gift entered for a period whose digest has already gone out is behind the
 * watermark and no later window reaches back for it: it is never in any digest.
 * That is a deliberate product decision, not an oversight — the digest answers
 * "what came in this week", and giving HISTORY is what the giving ledger in the
 * app is for. (A late desk entry is still announced the moment it is keyed, by
 * an `immediate` rule, which says in as many words that a BACKDATED gift was
 * recorded — see `isBackdatedGift`. Bulk imports deliberately suppress that,
 * because 5,000 emails is not a notification.)
 *
 * WHAT THAT COSTS THE MACHINERY, in one line, because it is the part that is
 * easy to get wrong: windows still PARTITION the `receivedAt` axis, so nothing
 * is ever reported twice — a row can only fall out of the chain, never into it
 * twice. See `collectWindowGifts` for the cut/resume argument in full.
 */
import type { Doc, Id } from "../_generated/dataModel";

/** The org's timezone — the one `crons.ts`, `reminders.ts` and every other
 *  human-facing time in this backend reason in. */
export const ORG_TIME_ZONE = "America/New_York";

/** Default digest hour when a rule doesn't name one (08:00 local). */
export const DEFAULT_SEND_HOUR_LOCAL = 8;
/** Default digest weekday when a weekly rule doesn't name one (Monday). */
export const DEFAULT_SEND_WEEKDAY = 1;

/** A rule mails a team, not a mailing list — bounded so a typo can't turn one
 *  gift into a hundred sends. */
export const MAX_RULE_RECIPIENTS = 20;
/** Rules are hand-authored config; the desk will never have hundreds. */
export const MAX_RULES = 200;
/** How many gifts one digest email itemizes before it stops listing (the
 *  totals still count every gift — only the per-gift list is capped). */
export const MAX_DIGEST_GIFT_ROWS = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far back a gift's `receivedAt` can be and still read as "money just came
 * in". Past it the immediate email says a BACKDATED gift was RECORDED.
 *
 * It changes the wording and nothing else — deliberately. Suppressing an old
 * gift's notification outright was the other option and it is worse: a
 * treasurer entering a cheque that arrived three weeks ago would get silence,
 * and "someone gave a big gift and I want to thank them" is exactly as true
 * three weeks later. A notification nobody can see the absence of is the
 * failure mode that makes people stop trusting the system. So nothing is
 * dropped; the email simply stops claiming something untrue about when the
 * money moved. The VOLUME problem — a bulk import firing thousands of these —
 * is a different axis, solved deterministically by `recordGiftForDonor`'s
 * `notify` flag rather than by guessing from a date.
 */
export const FRESH_ARRIVAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Whether a gift's stated date is far enough back that calling it an arrival
 *  would be wrong. */
export function isBackdatedGift(receivedAt: number, now: number): boolean {
  return now - receivedAt > FRESH_ARRIVAL_WINDOW_MS;
}

/** A rule's reach — the three-way union, with `"all"` as an explicit sentinel
 *  rather than an absent chapter id. */
export type RuleScope = "all" | "central" | Id<"chapters">;
/** A gift's book — the two-way union `donors.scope`/`gifts.scope` carry. */
export type GiftScope = "central" | Id<"chapters">;

// ── Recipients ───────────────────────────────────────────────────────────────

/**
 * Loose address check — deliberately NOT an RFC 5322 parse (same discipline as
 * `lib/resend.ts#parseFromAddress`). It exists to catch the typo that would
 * otherwise be discovered as a Resend bounce three weeks later, not to
 * adjudicate exotic-but-legal addresses.
 */
export function isLikelyEmail(raw: string): boolean {
  const value = raw.trim();
  if (value.length === 0 || value.length > 254) return false;
  if (/\s/.test(value)) return false;
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(value);
}

/**
 * Trim, lowercase, and de-duplicate a recipient list, preserving first-seen
 * order. Blank entries are dropped (a UI that renders one input per row will
 * send empties). Returns the cleaned list AND the entries that didn't look
 * like addresses, so the caller can name them in its error.
 */
export function normalizeRecipients(raw: readonly string[]): {
  recipients: string[];
  invalid: string[];
} {
  const recipients: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    if (!isLikelyEmail(trimmed)) {
      invalid.push(trimmed);
      continue;
    }
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    recipients.push(lower);
  }
  return { recipients, invalid };
}

// ── Matching ─────────────────────────────────────────────────────────────────

/** Does a rule's scope cover the book a gift landed in? `"all"` covers every
 *  book; the other two are exact matches. */
export function ruleCoversScope(
  ruleScope: RuleScope,
  giftScope: GiftScope,
): boolean {
  if (ruleScope === "all") return true;
  return ruleScope === giftScope;
}

/** The amount test. INCLUSIVE (`>=`): a rule set at $500 fires on a gift of
 *  exactly $500, which is what anyone typing "500" means. An absent floor
 *  matches everything. Compared in integer cents — never a formatted string. */
export function meetsAmountFloor(
  minAmountCents: number | undefined,
  amountCents: number,
): boolean {
  if (minAmountCents === undefined) return true;
  return amountCents >= minAmountCents;
}

/**
 * How many cycles of a monthly pledge a rule weighs a NEW BACKER at.
 *
 * ── WHY A SIGNUP IS TESTED AT ITS ANNUAL VALUE ─────────────────────────────
 * A rule's floor is the desk's answer to "what is big enough to tell me about
 * today", and against a backer signup the monthly figure answers a different
 * question than the one being asked. Someone starting a $50/month pledge has
 * committed $600 over the year ahead; tested at $50 they fall under every floor
 * the org actually sets, and the single most consequential thing that happens on
 * the giving desk — a person deciding to fund the work every month from now on —
 * arrives as silence, while a one-off $500 cheque rings the bell.
 *
 * The owner's framing, and it is the right one: a backer IS a big gift, it just
 * arrives twelve payments at a time. So the floor test sees the commitment, and
 * every email that results prints BOTH figures so nobody mistakes the annual
 * number for money in the bank.
 *
 * The cost, named: a rule set at $500 now hears about a $42/month backer
 * ($504/yr). That is the intended behaviour, not a leak — and it is bounded by
 * the $20 pledge floor, so the smallest signup any rule can hear about at $500
 * is one worth $240/yr, which is under it.
 */
export const BACKER_ANNUAL_MONTHS = 12;

/** A monthly pledge's value over a year, in integer cents. Never used as an
 *  amount of money that has arrived — only as the weight a floor is tested
 *  against, and as a figure emails print beside the monthly one. */
export function backerAnnualCents(monthlyCents: number): number {
  return monthlyCents * BACKER_ANNUAL_MONTHS;
}

/**
 * The whole eligibility test for one NEW BACKER against one rule — the same
 * shape as `ruleMatchesGift`, differing in exactly one place: the floor is
 * tested against the ANNUAL commitment (see `BACKER_ANNUAL_MONTHS`) rather than
 * the monthly amount.
 *
 * Deliberately a separate function rather than a flag on `ruleMatchesGift`: the
 * gift test is called on every gift write and in the middle of the digest
 * window scan, and a boolean that changes what a floor MEANS is the kind of
 * argument that gets passed wrong once and silently mis-reports money forever.
 */
export function ruleMatchesBackerSignup(
  rule: Pick<
    Doc<"givingNotificationRules">,
    "isActive" | "scope" | "minAmountCents"
  >,
  signup: Pick<Doc<"pledges">, "scope" | "amountCents">,
): boolean {
  if (!rule.isActive) return false;
  if (!ruleCoversScope(rule.scope, signup.scope)) return false;
  return meetsAmountFloor(
    rule.minAmountCents,
    backerAnnualCents(signup.amountCents),
  );
}

/** The whole eligibility test for one gift against one rule. Inactive rules
 *  match nothing; there is no other exclusion (see the module doc). */
export function ruleMatchesGift(
  rule: Pick<
    Doc<"givingNotificationRules">,
    "isActive" | "scope" | "minAmountCents"
  >,
  gift: Pick<Doc<"gifts">, "scope" | "amountCents">,
): boolean {
  if (!rule.isActive) return false;
  if (!ruleCoversScope(rule.scope, gift.scope)) return false;
  return meetsAmountFloor(rule.minAmountCents, gift.amountCents);
}

// ── The digest clock ─────────────────────────────────────────────────────────

// One formatter, reused — `Intl.DateTimeFormat` construction dwarfs `.format()`
// and this runs once per rule per hourly sweep (same reasoning as
// `reminders.ts#DAY_FMT`).
const LOCAL_PARTS_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: ORG_TIME_ZONE,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  weekday: "short",
});

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Local calendar hour / weekday / day-key for an instant, in `ORG_TIME_ZONE`. */
export function localParts(ts: number): {
  hour: number;
  weekday: number;
  dayKey: string;
} {
  const parts = LOCAL_PARTS_FMT.formatToParts(new Date(ts));
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";
  // `hour12: false` renders midnight as "24" in some ICU builds — normalize.
  const hour = Number(get("hour")) % 24;
  return {
    hour,
    // FAILS CLOSED. `?? 0` here meant an unrecognized weekday string turned
    // every weekly rule into "due on Sunday" — a mailer guessing is worse than
    // a mailer waiting, so an unknown weekday matches nothing.
    weekday: WEEKDAY_INDEX[get("weekday")] ?? -1,
    dayKey: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

/** The hour a rule wants its digest, defaulted. */
export function ruleSendHour(
  rule: Pick<Doc<"givingNotificationRules">, "sendHourLocal">,
): number {
  return rule.sendHourLocal ?? DEFAULT_SEND_HOUR_LOCAL;
}

/** The weekday a weekly rule wants its digest, defaulted. */
export function ruleSendWeekday(
  rule: Pick<Doc<"givingNotificationRules">, "sendWeekday">,
): number {
  return rule.sendWeekday ?? DEFAULT_SEND_WEEKDAY;
}

/**
 * Has this rule's send time arrived, and has it not already gone out today?
 *
 * Both halves matter. The hour match is what schedules it; the day-key
 * comparison against `lastSentAt` is what makes the sweep SAFE TO RUN TWICE —
 * a retried cron, an overlapping run, or a manual re-invocation inside the
 * same local day finds the watermark already stamped today and does nothing.
 *
 * `immediate` rules are never "due": they fire from the gift write, not the
 * clock.
 */
export function isDigestDue(
  rule: Pick<
    Doc<"givingNotificationRules">,
    | "cadence"
    | "isActive"
    | "sendHourLocal"
    | "sendWeekday"
    | "lastRunDayKey"
  >,
  now: number,
): boolean {
  if (!rule.isActive) return false;
  if (rule.cadence !== "daily" && rule.cadence !== "weekly") return false;

  const nowParts = localParts(now);
  // AT OR AFTER the hour, not exactly on it. An exact match meant one dropped
  // cron tick cost a whole day — and a whole WEEK for a weekly rule — and a
  // rule set to hour 2 was skipped entirely on the DST spring-forward Sunday,
  // when local 2am does not exist. `lastRunDayKey` already enforces
  // once-per-day, so "at or after 8am, once today" is strictly better.
  if (nowParts.hour < ruleSendHour(rule)) return false;
  if (rule.cadence === "weekly" && nowParts.weekday !== ruleSendWeekday(rule)) {
    return false;
  }
  // Once per local day. Keyed on `lastRunDayKey`, NOT on `lastSentAt`: the two
  // answer different questions and only one of them is about money. See the
  // schema doc.
  return rule.lastRunDayKey !== nowParts.dayKey;
}

/** The local day-key a run at `now` belongs to — what a claim stamps on
 *  `lastRunDayKey`, whether or not it ends up sending. */
export function runDayKey(now: number): string {
  return localParts(now).dayKey;
}

/**
 * The `lastRunDayKey` a rule should be BORN with (or come back from dormancy
 * with), so its first digest isn't an empty one about a period it didn't exist
 * for.
 *
 * The problem this closes: a rule whose send moment has ALREADY PASSED today is
 * due the instant it is written, and its window opens at that same instant — so
 * it can only ever be empty. For a weekly rule that lands as a confident "No
 * giving this week" about a week nobody was watching, which is worse than
 * saying nothing. Stamping today's key makes it wait for its next real
 * occurrence, with a real window behind it.
 *
 * Deliberately NOT unconditional: a daily rule created at 6am for an 8am send
 * still fires at 8am today, because that window is genuine. The test is
 * literally "would this be due right now?", reusing `isDigestDue` so the two
 * can never drift apart.
 */
export function firstRunDayKey(
  rule: Pick<
    Doc<"givingNotificationRules">,
    "cadence" | "sendHourLocal" | "sendWeekday"
  >,
  now: number,
): string | undefined {
  const wouldFireNow = isDigestDue(
    { ...rule, isActive: true, lastRunDayKey: undefined },
    now,
  );
  return wouldFireNow ? runDayKey(now) : undefined;
}

/** The nominal length of a cadence's period — the fallback window when a rule
 *  has never sent. */
export function cadencePeriodMs(cadence: string): number {
  return cadence === "weekly" ? 7 * DAY_MS : DAY_MS;
}

/**
 * The exclusive lower bound of the gifts this digest covers, on `receivedAt` —
 * the instant the period opens.
 *
 * WHICH FIELD it bounds is the module doc's business; WHERE the boundary falls
 * is this function's, and the two are independent. Everything below is
 * unchanged by the move off `createdAt`: the three cases are about what
 * `lastSentAt` MEANS, not about what it measures.
 *
 * Three cases, because `lastSentAt` does not mean the same thing in all three.
 * The whole difficulty here is that one timestamp is used both as a REPORT
 * ("gifts up to here have been mailed") and as a BOUNDARY ("don't look further
 * back than here"), and those want opposite treatment. `watermarkFromRun` is
 * what tells them apart.
 *
 * ── 1. NEVER REPORTED → exactly the trailing period ────────────────────────
 * `now − period`, full stop.
 *
 * NOT clamped to the rule's `createdAt`, and that clamp is worth naming because
 * it is the bug this replaced: a weekly rule created on the morning of Aug 10
 * mailed `Aug 10, 2026 – Aug 10, 2026 · No gifts came in` over a week that had
 * a $115 gift and a $20 gift in it. "Weekly digest" means the trailing seven
 * days to whoever opens it, on the first run as much as the fiftieth.
 *
 * And NOT `min(now − period, createdAt)` either, which was the first attempt at
 * that fix and is worse than the bug it fixed: before the first send the only
 * lower bound available is `createdAt`, which can be arbitrarily old, so the
 * `min` reaches back to whenever the rule was made. Three ordinary ways a rule
 * sits watermark-less for months and then fires — an empty daily deliberately
 * never stamps `lastSentAt` (see `shouldSendDigest`), so a quiet chapter's rule
 * or one with a $1,000 floor never gets a watermark; a sweep that finds no
 * mailer configured claims nothing at all; and `saveRule` deliberately doesn't
 * reset the marks on a scope or threshold change. Widen such a rule's scope
 * after six months and `min` gives you a DAILY digest headlined
 * `Feb 10 – Aug 10` carrying the org's entire ledger, truncated at 750 and
 * draining hourly for days. `now − period` is the only bound that holds.
 *
 * The cost, stated plainly: gifts older than one period on a rule that has
 * never reported anything are NOT picked up. Deliberate — a rule that has never
 * sent has no claim on history.
 *
 * ── 2. A DIGEST RUN SET IT → exactly the watermark ─────────────────────────
 * It is a REPORT, so starting before it re-reports gifts that have already been
 * mailed and inflates the new period's total. No floor, ever — including when
 * that leaves the window SHORTER than the nominal period, which is not a defect
 * but the absence of a duplicate. Two ordinary ways that happens:
 *
 *   • RUN-HOUR JITTER. The hour test is `>=`, so a dropped 08:00 tick catches
 *     up at 14:00; next week's `now − period` then sits six hours BEFORE last
 *     week's watermark. This is the NORMAL case, not an edge one.
 *   • DST. A rule at 08:00 local moves an hour in UTC across a boundary, so
 *     `now − 7d` lands an hour before the previous watermark. Twice a year,
 *     forever.
 *
 * This case also covers the MID-DRAIN bookmark. A cut window parks the
 * watermark on the last gift it managed to read — inside a period, not at the
 * edge of one — and a floor there would re-read the gifts that caused the cut,
 * cut at the same instant, and re-mail the same 750 gifts on every hourly tick
 * until the import aged out of the period. Cut or complete, a run's mark is a
 * run's mark and the next window resumes from it exactly.
 *
 * ── 3. A SYNTHETIC BOUNDARY → `min(now − period, watermark)` ───────────────
 * `setRuleActive` (resume) and `saveRule` (cadence change, or an `isActive`
 * flip) stamp `lastSentAt = now` and CLEAR the flag. Nothing was reported at
 * that instant; the stamp exists only to stop a dormant rule replaying its
 * backlog. So the floor applies and the first digest back covers its trailing
 * period — the point of resuming — while the `min` still picks the stamp up
 * once the rule has been back longer than a period, so the un-reported stretch
 * since it resumed is never skipped.
 *
 * ── THE THREE PROPERTIES ───────────────────────────────────────────────────
 *  A. AT LEAST THE TRAILING PERIOD — except in case 2, where an earlier digest
 *     already reported the difference and a shorter window is the correct
 *     answer rather than a lost one.
 *  B. NOTHING REPORTED-UP-TO IS SKIPPED. Cases 2 and 3 never start after the
 *     watermark. Case 1 has no watermark to honour and is bounded on purpose.
 *  C. NO DORMANT REPLAY. Reaching back further than one period needs a
 *     watermark older than one period AND the flag clear; every path into
 *     dormancy stamps `now` and clears it, and case 1 is capped at one period
 *     regardless. Three months off comes back reporting a week.
 *
 * ── LEGACY ROWS ARE MIGRATED, NOT LEFT TO HEAL ─────────────────────────────
 * A rule written before `watermarkFromRun` existed has a run's watermark and no
 * flag, so it reads as case 3 until its next claim re-stamps it. "At most one
 * window's overlap" was the estimate, and it was too kind: a rule caught
 * MID-DRAIN re-reads from a period back, matches the same first
 * `MAX_DIGEST_MATCHES` gifts, and mails a BYTE-IDENTICAL duplicate digest
 * before the flag it just stamped takes effect. It recovers on the run after
 * and never skips a gift — but a duplicate digest is exactly what costs a new
 * feature its credibility with the people reading it, so migration
 * `0061_stamp_digest_watermark_provenance` stamps every existing watermark
 * rather than waiting. The case-3 fallback stays as the honest default for a
 * field that has to mean something the instant it ships.
 */
export function digestWindowStart(
  rule: Pick<
    Doc<"givingNotificationRules">,
    "cadence" | "lastSentAt" | "watermarkFromRun"
  >,
  now: number,
): number {
  const floor = now - cadencePeriodMs(rule.cadence);
  if (rule.lastSentAt === undefined) return floor;
  if (rule.watermarkFromRun) return rule.lastSentAt;
  return Math.min(floor, rule.lastSentAt);
}

/**
 * How far behind `now` a digest window closes.
 *
 * A gift is DATED before it is WRITTEN — `receivedAt` is stamped when the money
 * moved and the row lands some milliseconds (a Stripe webhook: some seconds)
 * later. Close the window at `now` and any gift in that gap is dated behind a
 * watermark that has already passed it, which on a `receivedAt` window means it
 * is never reported by anything. Closing a minute early costs a daily digest
 * nothing and puts every such gift in the NEXT window instead of nowhere.
 *
 * This mattered less when the window was on `createdAt` — there it only closed
 * an OCC race on the write transaction's start time — and it matters more now,
 * because the gap it covers is ordinary latency rather than a near-unreachable
 * interleaving. It is the one protection the `receivedAt` window keeps against
 * the routine case of a gift written just after the run that would have
 * reported it.
 */
export const DIGEST_LAG_MS = 60 * 1000;

/**
 * Clamp a donor's name for use in a SUBJECT line. Donor names arrive from the
 * public `/give` form, and nothing else bounds them — a ten-thousand-character
 * name produced a ten-thousand-character subject. Control characters go too:
 * a newline in a subject is header-injection shaped, and while Resend's JSON
 * API encodes it safely, a mailer should not be the thing relying on that.
 */
export function clampSubjectName(name: string, max = 80): string {
  // eslint-disable-next-line no-control-regex
  const flat = name.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Does a digest carrying this many ITEMS get sent at all? The asymmetry lives
 * here and nowhere else — see the module doc for why.
 *
 * "Items" is deliberately broader than gifts: it is everything the window found
 * worth reporting — settled gifts, in-flight ACH, and new backers. A week whose
 * only news is that two people started monthly pledges is emphatically not an
 * empty week, and skipping it as one would hide the best thing that happened.
 */
export function shouldSendDigest(
  cadence: string,
  itemCount: number,
  windowTruncated = false,
): boolean {
  // A CUT WINDOW ALWAYS SENDS, whatever it matched. "Nothing matched" is not a
  // trustworthy answer when the read stopped early — and a daily rule that
  // skips also declines to stamp, so a chapter rule sitting behind a large
  // import's prefix would re-read the same prefix every day and never send
  // again. Sending breaks that wedge and tells the humans the total is a floor.
  if (windowTruncated) return true;
  if (itemCount > 0) return true;
  return cadence === "weekly";
}
