/**
 * WHICH CATEGORY MUTATION TO CALL, IF ANY — pure so it's testable without a
 * server round-trip, and so `FinishChargeSheetBody`'s `submitBoth` has one
 * place to read instead of re-deriving this inline (the HIGH review finding
 * this file fixes: the inline version called `submitOwnCharge` unconditionally
 * for every card charge, which throws `NOT_A_CARD_CHARGE`/`FORBIDDEN` for a
 * historical Stripe-FC/Relay-CSV row the caller doesn't own — the Explain
 * workbench's core population).
 *
 * TWO INDEPENDENT QUESTIONS:
 *  1. Did the category actually CHANGE? Re-running a category write on every
 *     submit would exercise a mutation the caller might not even be allowed
 *     to call (a non-owner without finance reach) for a no-op write.
 *  2. Who OWNS this row? `submitOwnCharge` is the cardholder's own-charge
 *     path (server-enforced: refuses a charge that isn't the caller's own
 *     card); `finances.setTransactionCategory` is the bookkeeper-gated path
 *     — same category write, different access rule, works on ANY chapter
 *     transaction a finance role can reach. The HOST decides ownership
 *     (`ownCharge`), not this helper and not a per-row guess: `personTransactions`
 *     rows (My Transactions / the coding.tsx sheet) are own-by-construction;
 *     `monthCodingWorklist` rows (the Explain workbench) are not.
 */
import type { Id } from "@events-os/convex/_generated/dataModel";

export type CategoryEditPlan =
  | { kind: "none" }
  | { kind: "own"; categoryId: Id<"budgetCategories"> | null }
  | { kind: "bookkeeper"; categoryId: Id<"budgetCategories"> | null };

export function planCategoryEdit(args: {
  /** `submitOwnCharge` refuses a non-card txn outright — there is no
   *  category half to attempt at all when this is false, regardless of
   *  ownership (unchanged from before this fix). */
  isCardCharge: boolean;
  /** Which mutation is even reachable for this row — see the module doc. */
  ownCharge: boolean;
  draftCategoryId: Id<"budgetCategories"> | null;
  currentCategoryId: Id<"budgetCategories"> | null;
}): CategoryEditPlan {
  if (!args.isCardCharge) return { kind: "none" };
  if (args.draftCategoryId === args.currentCategoryId) return { kind: "none" };
  return args.ownCharge
    ? { kind: "own", categoryId: args.draftCategoryId }
    : { kind: "bookkeeper", categoryId: args.draftCategoryId };
}
