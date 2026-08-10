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
 * The watermark follows the same logic. A skipped empty daily does NOT stamp
 * `lastSentAt`, so the window simply carries forward — the next digest covers
 * everything since the last mail that was actually sent, and no gift can fall
 * between two runs. (Stamping on a skip would be harmless today, because
 * "nothing" is what carried forward, but it would quietly become wrong the
 * moment the skip rule grows any other reason to skip.)
 *
 * ── WHY THE WINDOW IS ON `createdAt`, NOT `receivedAt` ─────────────────────
 * `gifts.receivedAt` is when the money changed hands and is freely
 * backdatable (a CSV import of 2019 giving, a desk entry for a check that
 * arrived last week). A window on it would silently drop any gift entered
 * after its own period closed. `createdAt` is when the ledger learned of the
 * gift; it only moves forward, so `(lastSentAt, now]` is a partition of every
 * gift that will ever exist — nothing is reported twice and nothing is
 * missed. The email still SHOWS `receivedAt` as the gift's date, because that
 * is the true answer to "when was this given".
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
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
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
    "cadence" | "isActive" | "sendHourLocal" | "sendWeekday" | "lastSentAt"
  >,
  now: number,
): boolean {
  if (!rule.isActive) return false;
  if (rule.cadence !== "daily" && rule.cadence !== "weekly") return false;

  const nowParts = localParts(now);
  if (nowParts.hour !== ruleSendHour(rule)) return false;
  if (rule.cadence === "weekly" && nowParts.weekday !== ruleSendWeekday(rule)) {
    return false;
  }
  if (rule.lastSentAt !== undefined) {
    if (localParts(rule.lastSentAt).dayKey === nowParts.dayKey) return false;
  }
  return true;
}

/** The nominal length of a cadence's period — the fallback window when a rule
 *  has never sent. */
export function cadencePeriodMs(cadence: string): number {
  return cadence === "weekly" ? 7 * DAY_MS : DAY_MS;
}

/**
 * The exclusive lower bound of the gifts this digest covers, on `createdAt`.
 *
 * Normally the watermark. On the FIRST run there is no watermark, so it falls
 * back to one nominal period — clamped to the rule's own `createdAt`, because
 * a rule written yesterday must not open by reporting a week of giving that
 * predates it.
 */
export function digestWindowStart(
  rule: Pick<
    Doc<"givingNotificationRules">,
    "cadence" | "lastSentAt" | "createdAt"
  >,
  now: number,
): number {
  if (rule.lastSentAt !== undefined) return rule.lastSentAt;
  return Math.max(rule.createdAt, now - cadencePeriodMs(rule.cadence));
}

/**
 * Does a digest with this many gifts get sent at all? The asymmetry lives
 * here and nowhere else — see the module doc for why.
 */
export function shouldSendDigest(cadence: string, giftCount: number): boolean {
  if (giftCount > 0) return true;
  return cadence === "weekly";
}
