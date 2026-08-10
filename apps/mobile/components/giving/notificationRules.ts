/**
 * Giving notification rules — the screen's pure logic.
 *
 * `app/(app)/giving/notifications.tsx` is the only caller. Everything that can
 * be got subtly wrong — dollars→cents at the form boundary, a recipient list
 * that has to dedupe the way the server will, the sentence a rule reads as —
 * lives here so it can be tested without rendering anything (this app's jest is
 * `testEnvironment: "node"`; see `components/giving/csv.test.ts` for the same
 * shape).
 *
 * ── THE SERVER IS THE AUTHORITY ─────────────────────────────────────────────
 * Nothing here is a security boundary. `givingNotifications.saveRule` re-runs
 * every one of these checks (`lib/givingNotificationRules.ts#normalizeRecipients`,
 * `assertFloor`, `assertHour`, `assertWeekday`) and throws a `ConvexError` with
 * a written message. These exist so the common typo is caught in the field the
 * user is standing in, one keystroke after they made it, instead of after a
 * round trip. When the two ever disagree, the screen surfaces the SERVER's
 * message — see `notifications.tsx`.
 *
 * The constants and the address check are deliberately transcribed from
 * `apps/convex/lib/givingNotificationRules.ts` rather than imported: that module
 * builds an `Intl.DateTimeFormat` at import time and types itself against
 * `_generated/dataModel`, neither of which belongs in the mobile bundle. If the
 * backend's bounds move, move them here too.
 */
import { formatCents } from "@events-os/shared";
import type { Id } from "@events-os/convex/_generated/dataModel";

export type RuleCadence = "immediate" | "daily" | "weekly";
/** A rule's reach — the three-way union, `"all"` as an explicit sentinel. */
export type RuleScope = "all" | "central" | Id<"chapters">;

/** Mirrors `MAX_RULE_RECIPIENTS` in the backend's rules lib. */
export const MAX_RULE_RECIPIENTS = 20;
/** Mirrors `DEFAULT_SEND_HOUR_LOCAL` — 08:00 in the org's timezone. */
export const DEFAULT_SEND_HOUR_LOCAL = 8;
/** Mirrors `DEFAULT_SEND_WEEKDAY` — Monday. */
export const DEFAULT_SEND_WEEKDAY = 1;

// ── Recipients ───────────────────────────────────────────────────────────────

/**
 * Loose address check, transcribed from the backend's `isLikelyEmail`. Catches
 * the typo; deliberately not an RFC 5322 parse.
 */
export function isLikelyEmail(raw: string): boolean {
  const value = raw.trim();
  if (value.length === 0 || value.length > 254) return false;
  if (/\s/.test(value)) return false;
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(value);
}

/**
 * Add one or more addresses to a recipient list.
 *
 * Accepts a paste — "shay@x.org, aj@x.org" — because that is how anyone
 * actually has a list of addresses to hand, and typing them one at a time into
 * a chip field is the kind of friction that gets a feature left unconfigured.
 * Splits on commas, semicolons, and whitespace.
 *
 * Lowercases and de-duplicates, matching the server's `normalizeRecipients`, so
 * what the chips show is what will be stored. A duplicate is dropped SILENTLY
 * (a pasted list containing one address already on the rule is not a mistake
 * worth an error); anything that doesn't look like an address is named, and
 * NOTHING in the batch is added, so the user can fix the typo and re-paste the
 * whole thing rather than hunting for which half went in.
 */
export function addRecipients(
  current: readonly string[],
  raw: string,
): { recipients: string[]; error: string | null } {
  const entries = raw.split(/[,;\s]+/).filter((e) => e.length > 0);
  if (entries.length === 0) {
    return { recipients: [...current], error: "Enter an email address." };
  }

  const invalid = entries.filter((e) => !isLikelyEmail(e));
  if (invalid.length > 0) {
    return {
      recipients: [...current],
      error: `That doesn't look like an email address: ${invalid.join(", ")}`,
    };
  }

  const next = [...current];
  const seen = new Set(next.map((e) => e.toLowerCase()));
  for (const entry of entries) {
    const lower = entry.trim().toLowerCase();
    if (seen.has(lower)) continue;
    if (next.length >= MAX_RULE_RECIPIENTS) {
      return {
        recipients: [...current],
        error: `A rule may send to at most ${MAX_RULE_RECIPIENTS} addresses.`,
      };
    }
    seen.add(lower);
    next.push(lower);
  }
  return { recipients: next, error: null };
}

/** Drop one address. Compared case-insensitively — the list is stored
 *  lowercased, but a caller shouldn't have to know that to remove a chip. */
export function removeRecipient(
  current: readonly string[],
  email: string,
): string[] {
  const lower = email.trim().toLowerCase();
  return current.filter((e) => e.toLowerCase() !== lower);
}

// ── Money at the boundary ────────────────────────────────────────────────────

/**
 * Parse the threshold field — DOLLARS as typed by a human — into the integer
 * cents the mutation takes.
 *
 * BLANK IS NOT ZERO, and the difference is the whole feature: blank means "tell
 * me about every gift" (an absent `minAmountCents`), and the caller must pass
 * `undefined` rather than `0` so the rule reads as unfiltered rather than as a
 * floor that happens to catch everything. Both behave identically today; only
 * one of them still says the right thing if the backend's floor test ever stops
 * being `>=`.
 *
 * Tolerates the way people type money: a leading `$`, thousands commas, and
 * surrounding space.
 */
export function parseDollarsToCents(raw: string): {
  cents?: number;
  error: string | null;
} {
  const cleaned = raw.trim().replace(/^\$/, "").replace(/,/g, "").trim();
  if (cleaned.length === 0) return { cents: undefined, error: null };

  const badAmount = {
    error: "Enter a dollar amount, or leave it blank for every gift.",
  };
  // Digits with at most one decimal point, and the point may sit at either
  // end: this field is a `decimal-pad`, where ".50" and "1." are both natural
  // things to have typed — the first is what you get typing a threshold under a
  // dollar, the second is a keystroke away from every whole amount. A bare "."
  // is still refused, because it is not a number in any reading. The minus sign
  // is refused outright rather than parsed and complained about afterwards;
  // there is no reading of "-50" a threshold could honour.
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(cleaned)) return badAmount;

  // Parsed off the DIGITS, not via `Math.round(Number(x) * 100)`. That reading
  // is wrong for a value a fundraiser can plausibly type: `1.005 * 100` is
  // 100.49999999999999 in binary floating point, so it rounds DOWN to $1.00 —
  // a threshold a cent below the one that was asked for, which is exactly the
  // kind of off-by-one that shows up as "why didn't I get told about that
  // gift". Integer arithmetic on the string can't drift.
  const [whole, fraction = ""] = cleaned.split(".");
  const centsPart = `${fraction}00`.slice(0, 2);
  const beyond = fraction.slice(2);
  let cents = Number(whole) * 100 + Number(centsPart);
  // Half-up on the third decimal, matching how `Math.round` would have behaved
  // if floats were exact.
  if (beyond.length > 0 && Number(beyond[0]) >= 5) cents += 1;
  if (!Number.isSafeInteger(cents)) return badAmount;
  return { cents, error: null };
}

/** The threshold field's value when EDITING an existing rule — the inverse of
 *  `parseDollarsToCents`, so a round trip through the form doesn't move the
 *  number. Absent floor → an empty field, never "0". */
export function centsToDollarsInput(cents: number | undefined): string {
  if (cents === undefined) return "";
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

/** How a rule's floor reads in the list. An absent floor — and an explicit
 *  zero, which the backend accepts and which matches everything — both say
 *  "every gift" rather than "$0.00 and up". */
export function thresholdLabel(minAmountCents: number | undefined): string {
  if (minAmountCents === undefined || minAmountCents === 0) return "Every gift";
  return `${formatCents(minAmountCents)} and up`;
}

// ── The schedule, in words ───────────────────────────────────────────────────

export const CADENCE_OPTIONS: { value: RuleCadence; label: string }[] = [
  { value: "immediate", label: "As each gift arrives" },
  { value: "daily", label: "Daily digest" },
  { value: "weekly", label: "Weekly digest" },
];

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** Short cadence label for a badge. */
export function cadenceLabel(cadence: RuleCadence): string {
  return cadence === "immediate"
    ? "Immediate"
    : cadence === "daily"
      ? "Daily"
      : "Weekly";
}

/** 0–6 → a weekday name. Out of range falls back to the default rather than
 *  rendering `undefined` — the backend defaults the same way. */
export function weekdayLabel(weekday: number | undefined): string {
  const index = weekday ?? DEFAULT_SEND_WEEKDAY;
  return WEEKDAY_NAMES[index] ?? WEEKDAY_NAMES[DEFAULT_SEND_WEEKDAY];
}

/** 0–23 → a 12-hour clock label. Midnight is "12:00 AM", noon "12:00 PM". */
export function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const suffix = h < 12 ? "AM" : "PM";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}:00 ${suffix}`;
}

export const HOUR_OPTIONS: { value: string; label: string }[] = Array.from(
  { length: 24 },
  (_, h) => ({ value: String(h), label: hourLabel(h) }),
);

export const WEEKDAY_OPTIONS: { value: string; label: string }[] =
  WEEKDAY_NAMES.map((label, value) => ({ value: String(value), label }));

/**
 * The sentence a rule's schedule reads as. Times are stated in ET because the
 * stored hour IS an ET hour (see the schema's send-time note) — leaving the
 * zone off would make "8:00" a promise the rule doesn't keep for anyone west of
 * Ohio.
 */
export function scheduleSummary(rule: {
  cadence: RuleCadence;
  sendHourLocal?: number;
  sendWeekday?: number;
}): string {
  if (rule.cadence === "immediate") return "As each gift arrives";
  const at = `${hourLabel(rule.sendHourLocal ?? DEFAULT_SEND_HOUR_LOCAL)} ET`;
  if (rule.cadence === "daily") return `Every day at ${at}`;
  return `Every ${weekdayLabel(rule.sendWeekday)} at ${at}`;
}

/**
 * The delivery line on a list row. Takes the formatter rather than importing
 * one, so the wording is testable without pinning a timezone into this module.
 *
 * THREE STATES, BECAUSE THE ROW HAS THREE THINGS IT MIGHT TRUTHFULLY SAY, and
 * an earlier cut of this screen collapsed them into two and lied. It read
 * "Last sent" off `lastSentAt`, which is not a record of any email: it is the
 * digest WATERMARK, and `setRuleActive` and a cadence change both stamp it to
 * `now` on purpose so a resumed rule reports from there instead of replaying
 * its dormancy. So a rule that had never sent anything at all announced "Last
 * sent" with today's date the moment somebody paused and resumed it — a
 * confident, checkable, false claim about whether the org's donors had been
 * acknowledged.
 *
 * `lastDeliveredAt` is the honest field (stamped only by a delivered email),
 * and a watermark with nothing behind it is worth SAYING rather than hiding —
 * it is exactly the sentence that explains why a resumed rule won't mention
 * last month's giving.
 */
export function deliveryLabel(
  rule: { lastDeliveredAt?: number; lastSentAt?: number },
  formatTs: (ts: number) => string,
): string {
  if (rule.lastDeliveredAt !== undefined) {
    return `Last sent ${formatTs(rule.lastDeliveredAt)}`;
  }
  if (rule.lastSentAt !== undefined) {
    return `Nothing sent yet — watching from ${formatTs(rule.lastSentAt)}`;
  }
  return "Hasn't sent yet";
}

// ── The whole form ───────────────────────────────────────────────────────────

/** What the form holds, all as the strings the inputs actually carry. */
export interface RuleDraft {
  name: string;
  recipients: readonly string[];
  cadence: RuleCadence;
  /** Dollars, as typed. Blank means every gift. */
  minAmount: string;
  /** `null` until a book is chosen. */
  scope: RuleScope | null;
  /** `"0"`–`"23"`, from the hour Select. */
  sendHour: string;
  /** `"0"`–`"6"`, from the weekday Select. */
  sendWeekday: string;
}

/** Exactly the `saveRule` argument shape, minus the optional `ruleId` the
 *  caller supplies. */
export interface SaveRuleArgs {
  name: string;
  recipients: string[];
  cadence: RuleCadence;
  minAmountCents?: number;
  scope: RuleScope;
  sendHourLocal?: number;
  sendWeekday?: number;
}

/**
 * Turn a draft into mutation arguments, or into the one sentence that says why
 * it can't be.
 *
 * The send hour and weekday are sent ONLY for a digest cadence. They are
 * ignored for `immediate` (see the schema doc), and writing them anyway would
 * put a number on a rule that never consults it — so a rule switched from
 * weekly to immediate and back would silently resurrect a schedule the user
 * last saw months ago.
 */
export function buildSaveArgs(
  draft: RuleDraft,
):
  | { args: SaveRuleArgs; error: null }
  | { args: null; error: string } {
  const name = draft.name.trim();
  if (name.length === 0) {
    return { args: null, error: "A rule needs a name." };
  }
  if (draft.recipients.length === 0) {
    return {
      args: null,
      error: "A rule needs at least one email address to send to.",
    };
  }
  if (draft.recipients.length > MAX_RULE_RECIPIENTS) {
    return {
      args: null,
      error: `A rule may send to at most ${MAX_RULE_RECIPIENTS} addresses.`,
    };
  }
  if (draft.scope === null) {
    return { args: null, error: "Choose which book this rule watches." };
  }

  const { cents, error } = parseDollarsToCents(draft.minAmount);
  if (error) return { args: null, error };

  const args: SaveRuleArgs = {
    name,
    recipients: [...draft.recipients],
    cadence: draft.cadence,
    minAmountCents: cents,
    scope: draft.scope,
  };
  if (draft.cadence !== "immediate") {
    args.sendHourLocal = Number(draft.sendHour);
    if (draft.cadence === "weekly") {
      args.sendWeekday = Number(draft.sendWeekday);
    }
  }
  return { args, error: null };
}
