/**
 * Pure decision logic for `ReconciliationSection`'s "last run" card — pulled
 * out so the truncation/visibility rules are unit-testable without a
 * renderer (this repo's jest config runs colocated `*.test.ts` files in a
 * plain node environment; it does not mount React components — see
 * `jest.config.js`).
 *
 * ── THE BUG THIS EXISTS TO PIN (review finding, 2026-08-14) ──────────────────
 *
 * `settleChapterBalances` stopped booking a `balance_settlement` ledger pair
 * when a chapter's book value exceeds its bank and Real cash movement is off,
 * on the justification that "the gap is still reported, through the
 * run-summary `notes` channel." That was false in practice: `notes` is an
 * unordered, capped, UI-collapsible log of "what happened this run" —
 *
 *   - `runNotes` only ever shows the FIRST `RUN_NOTES_DISPLAY_LIMIT` (6) of
 *     the run's notes, and the settlement gap was always pushed LAST (step 8
 *     of 8), so on any morning with more than 6 total notes it never reached
 *     this component at all;
 *   - even inside those 6, `notesCollapsible` hides everything past
 *     `RUN_NOTES_INLINE_THRESHOLD` (3) behind a toggle that starts collapsed
 *     on every page load.
 *
 * So a STANDING CONDITION ("chapters aren't being settled, and here's why")
 * was riding a channel built for a transient, truncatable event log.
 *
 * The fix is `computeReconciliationRunView`: it keeps the notes
 * truncation/collapse behaviour exactly as it was (still useful — `notes` is
 * still a real log), but carries `advisoryGaps` as a SEPARATE field that is
 * never sliced and never gated on `notesExpanded`. `ReconciliationSection`
 * renders it unconditionally, next to the "Real cash movement" toggle that
 * causes it.
 */

/** Last-run notes at/below this count render inline — same threshold
 *  `TransactionHistoryCompact` uses, so a short list never grows a toggle
 *  just to reveal almost nothing. */
export const RUN_NOTES_INLINE_THRESHOLD = 3;

/** The last run can write up to `MAX_RUN_NOTES` (40, server-side) notes; the
 *  panel only ever shows the first this many. */
export const RUN_NOTES_DISPLAY_LIMIT = 6;

/** Mirrors `unsettledGapValidator` in `apps/convex/reconciliation.ts`. */
export interface UnsettledGap {
  scope: string;
  scopeName: string;
  bookBalanceCents: number;
  bankBalanceCents: number;
  gapCents: number;
}

export interface LastRunNotesInput {
  notes: string[];
  unsettledGaps: UnsettledGap[];
}

export interface ReconciliationRunView {
  /** The (possibly truncated) slice of `notes` the card is willing to show at
   *  all — independent of whether it's currently expanded. */
  runNotes: string[];
  /** Whether that slice is long enough to need a "Notes (n)" toggle. */
  notesCollapsible: boolean;
  /** Whether the notes lines should render right now, given `notesExpanded`. */
  showNotes: boolean;
  /** Every chapter the last run measured as unsettled — ALWAYS the full list,
   *  never sliced to `RUN_NOTES_DISPLAY_LIMIT` and never dependent on
   *  `notesExpanded`. Empty when nothing is unsettled (real cash movement on,
   *  or every chapter is at its book). */
  advisoryGaps: UnsettledGap[];
}

export function computeReconciliationRunView(
  lastRun: LastRunNotesInput,
  notesExpanded: boolean,
): ReconciliationRunView {
  const runNotes = lastRun.notes.slice(0, RUN_NOTES_DISPLAY_LIMIT);
  const notesCollapsible = runNotes.length > RUN_NOTES_INLINE_THRESHOLD;
  const showNotes = !notesCollapsible || notesExpanded;
  return {
    runNotes,
    notesCollapsible,
    showNotes,
    advisoryGaps: lastRun.unsettledGaps,
  };
}
