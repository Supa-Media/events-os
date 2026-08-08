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
 *  - a MARKED bank transfer (`preMarkFlow` set, whatever `flow` now reads) → 0.
 *    Cash moving between accounts the org already owns is neither earning nor
 *    spending, so it changes no book's VALUE — only where the cash sits.
 *  - remaining `flow:"transfer"` legs, by what kind of leg it is:
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

  // ── A MARKED TRANSFER MOVES CASH, NOT VALUE ────────────────────────────────
  // `preMarkFlow` is written by `finances.markAsTransfer` and nothing else, so
  // it identifies exactly the rows a human declared to be two legs of one
  // movement between accounts the org ALREADY owns.
  //
  // Book value is what a book EARNED minus what it SPENT. Moving cash from one
  // of the org's accounts to another is neither, and charging it to a book
  // produces a real distortion: the founder transferred $2,873.21 from Central
  // to New York on 2026-08-07 because New York's Stripe payouts land in
  // Central's account and New York needed to spend. New York had already been
  // credited that revenue when the tickets sold. Signing the legs took
  // $2,873.21 off Central — for money Central never earned — and credited New
  // York a second time for money it had earned once.
  //
  // The engine already treats its own version of this movement as valueless
  // (`transferOrigin === "payout_allocation"` returns 0 above). This is the
  // same delivery done by hand, and it gets the same answer.
  //
  // NOT the same as an `auto_settlement` pair, which falls through to the
  // direction branch below and stays signed — deliberately. That one corrects
  // WHO BORE A COST when one book's card paid for another book's spending, so
  // it moves real economic weight rather than just cash.
  //
  // CHECKED BEFORE `flow`, not after. A half-unmarked pair exists in production
  // — the 2026-07-17 Relay→Increase move has one leg still `flow:"transfer"`
  // and the other back to `flow:"outflow"` with `preMarkFlow` never cleared.
  // Reading `flow` first would zero one leg and keep the other, turning a pair
  // that nets to nothing into a $1,000 hole. `preMarkFlow` is the durable
  // signal; it says "a human called this a transfer" whatever `flow` now reads.
  if (tr.preMarkFlow != null) return 0;

  if (tr.flow === "inflow") return tr.amountCents;
  if (tr.flow === "outflow") return -tr.amountCents;

  // flow === "transfer" — resolve which side of the movement this leg is.
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
