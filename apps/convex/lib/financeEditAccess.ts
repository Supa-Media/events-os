/**
 * Correcting a transaction — who may rewrite a row's amount, date, merchant or
 * description, and which rows will ever accept it.
 *
 * TWO INDEPENDENT LOCKS, and the order matters:
 *
 *  1. THE ROW (`isCorrectableSource`, `@events-os/shared`). A row synced from
 *     Increase / Relay / Stripe is a third party's claim about money that
 *     actually moved — correcting it would break reconciliation against a bank
 *     statement, which is the property the whole ledger rests on. A
 *     `reimbursement` / `repayment` / `transfer` row is a system-written leg
 *     paired to another record, and editing one in isolation desyncs the pair.
 *     Only `manual` rows are standalone human assertions, and only those are
 *     correctable. NO ROLE OVERRIDES THIS — not a manager, not a superuser.
 *     It's a data-integrity invariant, not a permission.
 *
 *  2. THE CALLER (`requireCorrectTransaction`). Finance MANAGER rank at the
 *     row's own scope, resolved exactly like `requireReconcileTxn` does.
 *     Deliberately a rank rather than a superuser check: correcting history is
 *     bookkeeping, and the seat chart is already the honest answer to who does
 *     bookkeeping. Graduates to a `finance.correctHistory` capability if it
 *     ever needs to be grantable separately — the body changes, no call site
 *     does.
 *
 * Refusals throw `ConvexError({ code, message })` so the app's AuthErrorBoundary
 * can surface them, matching every other finance gate.
 */
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  CENTRAL,
  financeRoleAtLeast,
  isCorrectableSource,
} from "@events-os/shared";
import {
  getFinanceRole,
  requireFinanceCentral,
  type FinanceScope,
} from "./finance";
import { requireChapterId } from "./context";

/** The resolved right to correct one transaction. */
export interface CorrectTransactionAccess {
  txn: Doc<"transactions">;
  scope: FinanceScope;
  actorPersonId: Id<"people"> | null;
}

/**
 * True iff this row's SOURCE will ever accept a correction. Pure, and exported
 * so the reconcile projection can tell the grid whether to offer the affordance
 * at all — an edit button that always throws is worse than no button.
 */
export function isTransactionCorrectable(txn: Doc<"transactions">): boolean {
  return isCorrectableSource(txn.source);
}

/**
 * Assert the caller may correct this transaction, else throw. Checks the ROW
 * first: a synced row is refused with `NOT_CORRECTABLE` regardless of who is
 * asking, so the error a caller sees names the real reason rather than
 * misreporting an integrity rule as a permissions problem.
 */
export async function requireCorrectTransaction(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<CorrectTransactionAccess> {
  const homeChapterId = (await requireChapterId(ctx)) as Id<"chapters">;
  const txn = (await ctx.db.get(transactionId)) as Doc<"transactions"> | null;
  const notFound = () =>
    new ConvexError({
      code: "NOT_FOUND",
      message: "Transaction not found in your chapter.",
    });
  if (!txn) throw notFound();

  if (!isTransactionCorrectable(txn)) {
    throw new ConvexError({
      code: "NOT_CORRECTABLE",
      message:
        "This transaction came from a bank feed or is one leg of a paired record, so its amount and date can't be edited — the ledger has to keep matching the statement. Add a note, or exclude it with a reason, instead.",
    });
  }

  const forbidden = () =>
    new ConvexError({
      code: "FORBIDDEN",
      message: "Correcting a transaction needs the Finance manager role.",
    });

  if (txn.chapterId === CENTRAL) {
    const access = await requireFinanceCentral(ctx, homeChapterId);
    if (!financeRoleAtLeast(access.role, "manager")) throw forbidden();
    return { txn, scope: CENTRAL, actorPersonId: access.personId };
  }

  const access = await getFinanceRole(ctx, homeChapterId);
  if (txn.chapterId !== homeChapterId) throw notFound();
  if (!financeRoleAtLeast(access.role, "manager")) throw forbidden();
  return { txn, scope: txn.chapterId, actorPersonId: access.personId };
}
