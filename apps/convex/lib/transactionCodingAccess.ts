/**
 * Transaction-coding authorization — who may author a coding, who may decide
 * on one, and who may see meal-attendee NAMES.
 *
 * Mirrors `lib/receiptExceptionAccess.ts` exactly, because the powers are the
 * same separation-of-duties pair (see `docs/plans/transaction-coding.md`):
 *
 *  - SUBMIT (`requireSubmitCoding`) — author "this is what the spend was, and
 *    who was involved". Open today to the transaction's OWN person (the
 *    cardholder coding their own charge is the entire phase-2 flow, and it
 *    must not need a finance grant — `finances.attachReceipt`'s own-txn
 *    carve-out) or to bookkeeper+ on any row in scope. Graduates to a
 *    `finance.coding.submit` capability if it ever needs narrowing.
 *
 *  - REVIEW (`requireReviewCoding`) — decide. Finance MANAGER rank, the same
 *    bar as the rest of the approve ladder. No own-txn carve-out by
 *    construction, and `transactionCodings.approve` additionally refuses a
 *    reviewer deciding a coding THEY authored (every coding is somebody's
 *    testimony; the second name is the point). Graduates to
 *    `finance.coding.review`.
 *
 *  - NAMES (`hasCodingNamesView`) — see attendee names. Names are
 *    internal-only forever (owner decision, 2026-08-08): the public ledger
 *    renders the affiliation breakdown, never a name. Internally, whoever may
 *    author on the row (its own person, bookkeeper+) may read what's on it;
 *    everyone else gets the redacted projection. Graduates to
 *    `finance.coding.viewNames` the day a seat needs it carried or stripped
 *    separately.
 *
 * Scope resolution is `requireReconcileTxn`'s, byte for byte, via the same
 * local `resolve` shape as the exception gates. Every refusal throws
 * `ConvexError({ code, message })` so the app's AuthErrorBoundary can surface
 * it.
 */
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { CENTRAL, financeRoleAtLeast } from "@events-os/shared";
import {
  getFinanceRole,
  requireFinanceCentral,
  type FinanceScope,
} from "./finance";
import { requireChapterId } from "./context";

/** The resolved right to act on one transaction's coding. */
export interface TransactionCodingAccess {
  txn: Doc<"transactions">;
  scope: FinanceScope;
  /** The caller's roster person id at this scope. `null` for a superuser with
   *  no roster row (the same supported path as the exception gates). */
  actorPersonId: Id<"people"> | null;
}

/** Shared scope+role resolution for all three gates. `min` is the graded
 *  finance rank required of a NON-owner caller. */
async function resolve(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
  min: "bookkeeper" | "manager",
  allowOwnTxn: boolean,
  forbiddenMessage: string,
): Promise<TransactionCodingAccess> {
  const homeChapterId = (await requireChapterId(ctx)) as Id<"chapters">;
  const txn = (await ctx.db.get(transactionId)) as Doc<"transactions"> | null;
  const notFound = () =>
    new ConvexError({
      code: "NOT_FOUND",
      message: "Transaction not found in your chapter.",
    });
  if (!txn) throw notFound();

  const forbidden = () =>
    new ConvexError({ code: "FORBIDDEN", message: forbiddenMessage });

  if (txn.chapterId === CENTRAL) {
    // Central-owned money is central-desk territory; central issues no cards,
    // so a central row has no cardholder to be (same as the exception gates).
    const access = await requireFinanceCentral(ctx, homeChapterId);
    if (!financeRoleAtLeast(access.role, min)) throw forbidden();
    return { txn, scope: CENTRAL, actorPersonId: access.personId };
  }

  const access = await getFinanceRole(ctx, homeChapterId);
  if (txn.chapterId !== homeChapterId) throw notFound();
  const isOwnTxn =
    access.personId != null && access.personId === txn.personId;
  if (!(allowOwnTxn && isOwnTxn) && !financeRoleAtLeast(access.role, min)) {
    throw forbidden();
  }
  return { txn, scope: txn.chapterId, actorPersonId: access.personId };
}

/** True iff the caller may AUTHOR/EDIT the coding on this transaction.
 *  Read-only probe for the UI (the mutation still calls the `require` form). */
export async function hasSubmitCoding(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<boolean> {
  try {
    await requireSubmitCoding(ctx, transactionId);
    return true;
  } catch {
    return false;
  }
}

/** Assert the caller may AUTHOR/EDIT the coding on this transaction. */
export async function requireSubmitCoding(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<TransactionCodingAccess> {
  return resolve(
    ctx,
    transactionId,
    "bookkeeper",
    true,
    "Only the transaction's own person or a bookkeeper can code this transaction.",
  );
}

/** True iff the caller may DECIDE on this transaction's coding. Read-only
 *  probe for the UI (the mutation still calls the `require` form). */
export async function hasReviewCoding(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<boolean> {
  try {
    await requireReviewCoding(ctx, transactionId);
    return true;
  } catch {
    return false;
  }
}

/** Assert the caller may DECIDE (approve / send back) the coding on this
 *  transaction, else throw. */
export async function requireReviewCoding(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<TransactionCodingAccess> {
  return resolve(
    ctx,
    transactionId,
    "manager",
    false,
    "Reviewing a transaction coding needs the Finance manager role.",
  );
}

/** True iff the caller may see this coding's attendee NAMES (vs. the redacted
 *  affiliation-breakdown projection). Same bar as authoring: the row's own
 *  person, or bookkeeper+ in scope. Names NEVER publish regardless — this
 *  gates internal reads only. */
export async function hasCodingNamesView(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<boolean> {
  return hasSubmitCoding(ctx, transactionId);
}
