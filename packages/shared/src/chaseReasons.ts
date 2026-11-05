/**
 * WHY A MANAGER IS CHASING — the reasons a finance manager can attach to a
 * coding chase (`cards.sendCodingChase`), shown in the email and the text.
 *
 * Founder, 2026-11-05: "I also need options to explain why I'm chasing them."
 * A bare "code your charges" reads the same whether the receipt is missing,
 * the purpose was too thin, or the month is about to close, so the person
 * chased can't tell what would actually settle it. Each reason carries a short
 * label for the picker and the sentence the cardholder reads.
 */
export const CHASE_REASONS = [
  "missing_receipt",
  "missing_purpose",
  "vague_purpose",
  "closing_month",
  "overdue",
] as const;
export type ChaseReason = (typeof CHASE_REASONS)[number];

/** The picker's label — what the manager taps. */
export const CHASE_REASON_LABELS: Record<ChaseReason, string> = {
  missing_receipt: "Receipt missing",
  missing_purpose: "No explanation yet",
  vague_purpose: "Explanation too vague",
  closing_month: "Closing the month",
  overdue: "Overdue",
};

/** What the cardholder reads, one sentence per reason, in the email and text. */
export const CHASE_REASON_SENTENCES: Record<ChaseReason, string> = {
  missing_receipt: "We still need a receipt. A photo of it is enough.",
  missing_purpose: "We still need to know what it was for.",
  vague_purpose:
    "The explanation we have doesn't say enough. Tell us what it was for and who it served, in a sentence a donor would understand.",
  closing_month:
    "We're closing the books for the month, and these are the last ones open.",
  overdue:
    "These are past due. Charges that never get explained are billed back to the person who made them.",
};

/** Cap on the manager's own note, so a chase stays a message, not a letter. */
export const CHASE_NOTE_MAX_LENGTH = 500;
