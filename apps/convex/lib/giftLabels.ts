/**
 * Display labels for a gift's `method` literal — the field the desk shows as
 * "Source".
 *
 * Extracted from `givingPlatform.ts` (where it was module-private) the moment a
 * second reader appeared: the giving notification emails. A label map that
 * exists twice is a label map that will disagree with itself, and the one place
 * that disagreement would surface is an email nobody can re-read against the
 * screen it came from.
 *
 * `in_kind` matters most here. It is the one "gift" that moved no money — a
 * purchase made on the org's behalf that counts toward the giver's statement —
 * so a notification that doesn't say so reads as cash that never arrived.
 */

/** Display label per gift source/method literal (`stripe` reads as
 *  "Chapter OS" — our own rails). Mirrors the mobile `SOURCE_LABELS`. */
export const GIFT_METHOD_LABELS: Record<string, string> = {
  stripe: "Chapter OS",
  cash: "Cash",
  check: "Check",
  wire: "Wire",
  in_kind: "In-kind",
  zelle: "Zelle",
  venmo: "Venmo",
  givebutter: "Givebutter",
  cash_app: "Cash App",
  other: "Other",
};

/** Label for one gift method, falling back to the raw literal so a newly
 *  appended source is never rendered as blank. */
export function giftMethodLabel(method: string): string {
  return GIFT_METHOD_LABELS[method] ?? method;
}
