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

/**
 * The rails label for money that hasn't arrived — an authorised ACH debit the
 * bank hasn't moved yet (`pendingGifts`).
 *
 * NOT a member of `GIFT_METHOD_LABELS`, deliberately: that map is keyed on the
 * `gifts.method` union, every member of which is money that has landed, and a
 * key nothing can ever hold would be a trap for the next reader. A pending row
 * has no `method` of its own — the rail is the only thing we know about it.
 *
 * The wording carries its own caveat because this is the ONE place in a digest
 * where pending money is visibly separated from the rest by rails, and a reader
 * skimming the "How it arrived" cut has to be able to see it there without
 * having read the paragraph at the top.
 */
export const PENDING_METHOD_LABEL = "Bank transfer — still clearing";

// ── What KIND of giving a gift is ────────────────────────────────────────────

/**
 * The four shapes money arrives in, in PRECEDENCE order.
 *
 * `method` answers "what rails did it come down" (card, cash, check). This
 * answers the different question a fundraising team actually plans against:
 * "why did this money arrive at all?" — the one the owner asked for as
 * "one time giving, events, recurring".
 *
 * ── EVERY GIFT LANDS IN EXACTLY ONE ────────────────────────────────────────
 * A gift can carry several of these links at once — a recurring backer's cycle
 * can be hand-attached to a gala's `eventId` by the fundraiser attribution
 * feature, and a sponsorship payment usually names its event too. So the order
 * below is not cosmetic: it is what makes a breakdown by type SUM to the total
 * instead of double-counting, and a breakdown whose parts don't add up to the
 * total is worse than no breakdown.
 *
 * ── WHY THIS ORDER ─────────────────────────────────────────────────────────
 * Most-binding commitment first. Each bucket is an answer to "why did this
 * arrive", and the answer with the most force behind it wins:
 *
 *  1. RECURRING (`pledgeId`) — an open-ended standing commitment. A backer's
 *     August cycle arrived because they are a backer; it would have arrived
 *     whether or not a gala happened. Counting it under Events would inflate
 *     what an event raised with money that recurs regardless, AND under-report
 *     the committed monthly base, which is the number a team budgets from.
 *     Recurring-ness is a fact about the payment MECHANISM; an `eventId` is an
 *     attribution tag a human can add to any gift after the fact, so the
 *     mechanism wins.
 *  2. SPONSORSHIP (`sponsorshipId`) — a fixed contractual agreement. Weaker
 *     than a subscription (it doesn't renew itself) but stronger than a tag.
 *     Given its own line rather than being folded into Events or silently
 *     dropped into One-time: sponsorship money is sold, invoiced and chased by
 *     different people than gifts are, and a "One-time" bucket quietly holding
 *     a $25k sponsorship teaches the reader to distrust the whole cut.
 *  3. EVENT (`eventId` or `donationId`) — attributed to an event. `donationId`
 *     is here because an event-page donation dual-writes its gift from a
 *     `donations` row, INCLUDING one bundled into a ticket checkout, and those
 *     rows don't always carry the `eventId` themselves.
 *  4. ONE-TIME — nothing above explains it: the desk entry, the CSV import,
 *     the `/give` page, the matched bank credit.
 *
 * `giftProvenance` (lib/givingNotificationContext.ts) reads `donationId` FIRST
 * and is not in conflict: it answers "what happened", one gift at a time, and a
 * donation-derived gift is never also a pledge cycle (different write paths
 * entirely). The reachable overlap is pledge-or-sponsorship + `eventId`, which
 * is what this order is about.
 */
export const GIFT_TYPES = [
  "recurring",
  "sponsorship",
  "event",
  "one_time",
] as const;

export type GiftType = (typeof GIFT_TYPES)[number];

/** Display label per gift type — what the digest's "By type" section prints. */
export const GIFT_TYPE_LABELS: Record<GiftType, string> = {
  recurring: "Recurring",
  sponsorship: "Sponsorships",
  event: "Events",
  one_time: "One-time",
};

/** Just the `gifts` fields the classification reads. Structural rather than a
 *  `Doc<"gifts">` so this module stays dependency-free and testable with a
 *  literal. */
export type GiftTypeFields = {
  pledgeId?: unknown;
  sponsorshipId?: unknown;
  eventId?: unknown;
  donationId?: unknown;
};

/** Which of the four a gift is. First match wins — see `GIFT_TYPES`. */
export function giftType(gift: GiftTypeFields): GiftType {
  if (gift.pledgeId != null) return "recurring";
  if (gift.sponsorshipId != null) return "sponsorship";
  if (gift.eventId != null || gift.donationId != null) return "event";
  return "one_time";
}

/** The display label for a gift's type. */
export function giftTypeLabel(gift: GiftTypeFields): string {
  return GIFT_TYPE_LABELS[giftType(gift)];
}
