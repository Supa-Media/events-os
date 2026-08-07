/**
 * Per-book (chapter or central) BOOK VALUE — the founder's model
 * (2026-08-07): "we should be using donations and ticket sales to calculate
 * the money we have, and then use transactions from reconcile to determine
 * money going out."
 *
 *   book value = REVENUE EARNED (gifts + paid ticket orders, per scope —
 *                summed in `reconciliation.ts#accountBalances`)
 *              + Σ signedBookCents over the book's LEDGER rows (this file)
 *
 * The ledger side is money-out plus corrections — NOT a second copy of
 * revenue. The anti-double-count rule that makes the model sound: a gift or
 * ticket sale is counted ONCE, at the giving/ticketing layer, so the ledger
 * rows that represent that same money's bank arrival contribute ZERO here:
 *
 *  - a PAYOUT DEPOSIT (`payoutProcessor` set, or engine-matched via
 *    `stripePayoutId`) → 0. It's the cash arrival of already-counted revenue.
 *  - a `transferOrigin:"payout_allocation"` pair leg → 0. It redistributes
 *    that same (uncounted-here) deposit between books; the revenue already
 *    sits on the right book at the gifts/tickets layer.
 *
 * Everything else keeps its sign (direction lives in `flow`, never a sign —
 * invariant #1 — and a `flow:"transfer"` row's side depends on WHOSE book
 * you read it from):
 *
 *  - `inflow` → + (non-payout income: interest, misc credits — and any
 *    UNMARKED payout deposit, which double-counts until a human marks it;
 *    marking is the fix, and the engine marks Stripe's automatically).
 *  - `outflow` → −. (A personal charge still counts — the money really left;
 *    its repayment credit brings it back.)
 *  - `status:"excluded"` → 0 (a duplicate / bank error is out of ALL totals).
 *  - `flow:"transfer"` legs, by what kind of leg it is:
 *      · marked bank transfer (`preMarkFlow` set) → the bank's own original
 *        direction (`finances.ts#isMarkedTransfer`'s field).
 *      · `source:"repayment"` → + (the offsetting credit `cards.ts` posts on
 *        the chapter book when a personal charge is repaid).
 *      · `source:"reimbursement"` → − (legacy only: reimbursement expenses
 *        post as plain `outflow` since migration 0044).
 *      · a central↔chapter PAIR leg (`transferDirection` set, or the
 *        historical `skim`/`launch_grant` kinds whose direction was implied):
 *        the leg's own `chapterId` vs the pair's direction says whether this
 *        book paid or received. Covers manual transfers AND the engine's
 *        `auto_settlement` pairs (which correct cross-book card custody).
 *      · anything else → 0, deliberately — never guess a sign on a shape
 *        this function doesn't recognize.
 *
 * Pure + dependency-light so `convex-test` and the vitest unit suite can hit
 * it directly.
 */
import type { Doc } from "../_generated/dataModel";
import { CENTRAL } from "@events-os/shared";

/** The signed cents this LEDGER row contributes to its own book's VALUE. */
export function signedBookCents(tr: Doc<"transactions">): number {
  if (tr.status === "excluded") return 0;
  // Revenue is counted at the gifts/tickets layer — its bank arrival, and
  // the engine pairs that redistribute that arrival, contribute nothing.
  if (tr.payoutProcessor != null || tr.stripePayoutId != null) return 0;
  if (tr.transferOrigin === "payout_allocation") return 0;

  if (tr.flow === "inflow") return tr.amountCents;
  if (tr.flow === "outflow") return -tr.amountCents;

  // flow === "transfer" — resolve which side of the movement this leg is.
  if (tr.preMarkFlow === "inflow") return tr.amountCents;
  if (tr.preMarkFlow === "outflow") return -tr.amountCents;
  if (tr.source === "repayment") return tr.amountCents;
  if (tr.source === "reimbursement") return -tr.amountCents;

  // A central↔chapter pair leg: direction + own scope name the side.
  const direction =
    tr.transferDirection ??
    // Historical kinds implied their direction and left the field unset.
    (tr.source === "skim"
      ? "chapter_to_central"
      : tr.source === "launch_grant"
        ? "central_to_chapter"
        : undefined);
  if (direction === "central_to_chapter") {
    return tr.chapterId === CENTRAL ? -tr.amountCents : tr.amountCents;
  }
  if (direction === "chapter_to_central") {
    return tr.chapterId === CENTRAL ? tr.amountCents : -tr.amountCents;
  }

  // Unknown transfer shape — contribute nothing rather than guess.
  return 0;
}
