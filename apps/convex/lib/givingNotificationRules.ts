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
 * ── WHY THE WINDOW IS ON `createdAt`, NOT `receivedAt` ─────────────────────
 * `gifts.receivedAt` is when the money changed hands and is freely
 * backdatable (a CSV import of 2019 giving, a desk entry for a check that
 * arrived last week). A window on it would silently drop any gift entered
 * after its own period closed. `createdAt` is when the ledger learned of the
 * gift; it only moves forward, so a `createdAt` range can't lose a gift to a
 * backdated entry the way a `receivedAt` range can, and NOTHING IS EVER MISSED.
 * (Nothing is double-reported either, in steady state — but a window
 * deliberately reaches back a full period even when the watermark is newer, so
 * a young or freshly-resumed rule overlaps the previous digest on purpose. See
 * `digestWindowStart`.) The email still SHOWS `receivedAt` as the gift's date,
 * because that is the true answer to "when was this given".
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
 * The exclusive lower bound of the gifts this digest covers, on `createdAt`.
 *
 * ── `min(now − period, watermark)` — never less than the period, never past
 *    the un-reported tail ─────────────────────────────────────────────────
 * Two promises, and the `min` is what keeps both:
 *
 *  • AT LEAST THE TRAILING PERIOD. "Weekly digest" means the last seven days
 *    to the person reading it, on the first run as much as the fiftieth. The
 *    old `max(createdAt, now − period)` clamp meant a rule created this morning
 *    mailed `Aug 10 – Aug 10 · No gifts came in` — technically true about a
 *    window nobody asked for, and flatly wrong about the week, which had
 *    giving in it. A digest whose first outing is a confident falsehood is one
 *    nobody trusts afterwards.
 *  • NEVER LESS THAN THE WATERMARK REACHES BACK. If a run was missed, or the
 *    cron dropped ticks for a fortnight, the watermark is older than
 *    `now − period` and it wins — so nothing that has not been reported is
 *    silently skipped.
 *
 * The cost is an OVERLAP, deliberately: on a rule younger than its own period,
 * or one resumed inside the last period, the window re-reads gifts an earlier
 * digest already showed. That is the point — a weekly digest that covers four
 * days because that is all that is new is not a weekly digest.
 *
 * ── AND THE THREE-MONTH REPLAY STILL CAN'T HAPPEN ──────────────────────────
 * Reaching back further than the period requires a watermark older than
 * `now − period`, and a dormant rule never has one: `setRuleActive` stamps
 * `lastSentAt = now` on resume, and `saveRule` does the same on a cadence
 * change (the other door into dormancy). So a rule paused for three months
 * comes back with a watermark of "now", and `min(now − 7d, now)` is `now − 7d`
 * — the trailing week, which is what a reader expects, and not one day more.
 * Only genuinely un-reported time extends the window.
 *
 * ── EXCEPT MID-DRAIN, WHERE THE WATERMARK IS A BOOKMARK, NOT A BOUNDARY ────
 * A cut window (`lastWindowTruncated`) stops the read part-way and parks the
 * watermark on the last gift it managed to read. That mark is INSIDE a period,
 * not at the edge of one, and applying the floor to it would re-read the
 * gifts that caused the cut, cut at exactly the same place, and mail the same
 * 750 gifts again — every hour, until the import aged past the period. So a
 * drain resumes from precisely where it stopped, and the floor comes back the
 * moment a window completes.
 */
export function digestWindowStart(
  rule: Pick<
    Doc<"givingNotificationRules">,
    "cadence" | "lastSentAt" | "createdAt" | "lastWindowTruncated"
  >,
  now: number,
): number {
  // Before the first send the rule's own birth is the watermark — it is the
  // earliest instant anything could have been reported from.
  const watermark = rule.lastSentAt ?? rule.createdAt;
  if (rule.lastWindowTruncated) return watermark;
  return Math.min(now - cadencePeriodMs(rule.cadence), watermark);
}

/**
 * How far behind `now` a digest window closes.
 *
 * `gifts.createdAt` is the WRITE TRANSACTION'S START time, not its commit
 * time, so a gift whose mutation began before a digest ran but committed after
 * it would land behind the watermark and never be reported. Convex's OCC makes
 * that nearly unreachable (the digest's range read overlaps the gift write and
 * forces a retry), but "nearly" is doing real work in a sentence about money.
 * Closing the window a minute early costs a daily digest nothing and removes
 * the race outright: any transaction in flight for under a minute is inside
 * the NEXT window rather than lost between two.
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
 * Does a digest with this many gifts get sent at all? The asymmetry lives
 * here and nowhere else — see the module doc for why.
 */
export function shouldSendDigest(
  cadence: string,
  giftCount: number,
  windowTruncated = false,
): boolean {
  // A CUT WINDOW ALWAYS SENDS, whatever it matched. "Nothing matched" is not a
  // trustworthy answer when the read stopped early — and a daily rule that
  // skips also declines to stamp, so a chapter rule sitting behind a large
  // import's prefix would re-read the same prefix every day and never send
  // again. Sending breaks that wedge and tells the humans the total is a floor.
  if (windowTruncated) return true;
  if (giftCount > 0) return true;
  return cadence === "weekly";
}
