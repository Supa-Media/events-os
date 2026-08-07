/**
 * Per-book (chapter or central) LEDGER BALANCE — the signed contribution of
 * one `transactions` row to its own book's running total. This is the "true
 * value" number the accounts page shows and the morning reconciliation engine
 * exists to keep honest: after the engine books a payout's allocation pairs
 * and the day's `auto_settlement` pair, Σ signedBookCents over a book's rows
 * IS what that book is actually worth.
 *
 * The ledger stores direction in `flow`, never a sign (invariant #1), and a
 * `flow:"transfer"` row's side depends on WHOSE book you're reading it from —
 * so the sign rules live here, in one tested place, instead of being re-derived
 * ad hoc:
 *
 *  - `inflow` → +, `outflow` → −. (A personal charge still counts — the money
 *    really left the account; its repayment credit brings it back.)
 *  - `status:"excluded"` → 0 (a duplicate / bank error is out of ALL totals).
 *  - `flow:"transfer"` legs, by what kind of leg it is:
 *      · marked bank transfer (`preMarkFlow` set) → the bank's own original
 *        direction (`finances.ts#isMarkedTransfer`'s field).
 *      · `source:"repayment"` → + (the offsetting credit `cards.ts` posts on
 *        the chapter book when a personal charge is repaid).
 *      · `source:"reimbursement"` → − (legacy only: reimbursement expenses
 *        post as plain `outflow` since migration 0044; any transfer-flow
 *        straggler is still money that left).
 *      · a central↔chapter PAIR leg (`transferDirection` set, or the
 *        historical `skim`/`launch_grant` kinds whose direction was implied):
 *        the leg's own `chapterId` vs the pair's direction says whether this
 *        book paid or received.
 *      · anything else → 0, deliberately — never guess a sign on a shape this
 *        function doesn't recognize.
 *
 * Pure + dependency-light so `convex-test` and the vitest unit suite can hit
 * it directly.
 */
import type { Doc } from "../_generated/dataModel";
import { CENTRAL } from "@events-os/shared";

/** The signed cents this row contributes to ITS OWN book's balance. */
export function signedBookCents(tr: Doc<"transactions">): number {
  if (tr.status === "excluded") return 0;
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
