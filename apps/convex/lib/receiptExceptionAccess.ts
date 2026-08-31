/**
 * Receipt-exception authorization — who may file an attestation that no
 * receipt exists, and who may decide on one.
 *
 * Two powers, deliberately separate, because they are the two halves of a
 * separation-of-duties pair (see `docs/plans/receipt-exceptions.md`):
 *
 *  - ATTEST (`requireAttestReceiptException`) — put your name on "there is no
 *    receipt for this, and here's what it was for". Open today to the
 *    transaction's OWN person (a cardholder attesting their own cash tip
 *    shouldn't need a finance grant, exactly like `finances.attachReceipt`'s
 *    own-txn carve-out) — in EITHER book, central included, since a member's
 *    card can draw on central's account (`lib/ownChargeAccess.ts`) — or to
 *    bookkeeper+ on any row in scope. Will graduate
 *    to a `finance.receiptException.attest` capability if it ever needs
 *    narrowing — the body changes, no call site does.
 *
 *  - APPROVE (`requireApproveReceiptException`) — decide. Finance MANAGER
 *    rank, i.e. the same bar as the rest of the finance write/approve ladder,
 *    which the `finance.approve` seat capability already feeds
 *    (`lib/finance.ts`'s module doc). Will graduate to
 *    `finance.receiptException.approve` if approving exceptions ever needs to
 *    be grantable separately from the rest of finance management.
 *
 * Scope resolution is `requireReconcileTxn`'s, byte for byte, for everyone but
 * the charge's own spender: a central-owned transaction needs central reach at
 * the rank, a chapter-owned one needs the caller's own chapter at the rank.
 * Nothing here invents new scoping.
 *
 * Every refusal throws `ConvexError({ code, message })` (never a plain
 * `Error`) so the app's AuthErrorBoundary can surface it, matching the finance
 * and giving gates.
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
import { ownChargeActor } from "./ownChargeAccess";

/** The resolved right to act on one transaction's receipt exceptions. */
export interface ReceiptExceptionAccess {
  /** The transaction the caller is acting on. */
  txn: Doc<"transactions">;
  /** The transaction's own scope (a real chapter, or the `central` sentinel). */
  scope: FinanceScope;
  /** The caller's roster person id at this scope. `null` for a superuser with
   *  no roster row — a real, supported path (see `financeAuditLog`'s doc), and
   *  the reason the separation-of-duties check below has to handle it. */
  actorPersonId: Id<"people"> | null;
}

/** Shared scope+role resolution for both gates. `min` is the graded finance
 *  rank required of a NON-owner caller. */
async function resolve(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
  min: "bookkeeper" | "manager",
  allowOwnTxn: boolean,
  forbiddenMessage: string,
): Promise<ReceiptExceptionAccess> {
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

  // THE OWN-CHARGE ARM, ASKED FIRST AND IN BOTH BOOKS — `allowOwnTxn` still
  // decides whether it counts, so the APPROVE gate is untouched by it.
  // Central used to have no such arm at all, on the premise that "central
  // issues no cards, so a central row has no cardholder to be". A member
  // whose card draws on central's Increase account spends into the central
  // book (`increaseCardSync.ts`), so that premise was false and the person
  // the receipt is being chased from could not attest that there isn't one.
  // See `lib/ownChargeAccess.ts`.
  const ownerPersonId = allowOwnTxn
    ? await ownChargeActor(ctx, txn, homeChapterId)
    : null;

  if (txn.chapterId === CENTRAL) {
    if (ownerPersonId != null) {
      return { txn, scope: CENTRAL, actorPersonId: ownerPersonId };
    }
    // Central-owned money nobody spent on a card is central-desk territory.
    const access = await requireFinanceCentral(ctx, homeChapterId);
    if (!financeRoleAtLeast(access.role, min)) throw forbidden();
    return { txn, scope: CENTRAL, actorPersonId: access.personId };
  }

  const access = await getFinanceRole(ctx, homeChapterId);
  if (txn.chapterId !== homeChapterId) throw notFound();
  if (ownerPersonId == null && !financeRoleAtLeast(access.role, min)) {
    throw forbidden();
  }
  return { txn, scope: txn.chapterId, actorPersonId: access.personId };
}

/** True iff the caller may FILE an exception on this transaction. Read-only
 *  probe for the UI (the mutation still calls the `require` form). */
export async function hasAttestReceiptException(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<boolean> {
  try {
    await requireAttestReceiptException(ctx, transactionId);
    return true;
  } catch {
    return false;
  }
}

/** Assert the caller may FILE an exception on this transaction, else throw. */
export async function requireAttestReceiptException(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<ReceiptExceptionAccess> {
  return resolve(
    ctx,
    transactionId,
    "bookkeeper",
    true,
    "Only the transaction's own person or a bookkeeper can file a receipt exception.",
  );
}

/** True iff the caller may DECIDE on this transaction's exceptions. Read-only
 *  probe for the UI (the mutation still calls the `require` form). */
export async function hasApproveReceiptException(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<boolean> {
  try {
    await requireApproveReceiptException(ctx, transactionId);
    return true;
  } catch {
    return false;
  }
}

/** Assert the caller may DECIDE (approve/reject) an exception on this
 *  transaction, else throw. No own-txn carve-out by construction — deciding on
 *  your own attestation is the exact thing separation of duties forbids, and
 *  the amount-threshold check in `receiptExceptions.ts` enforces the rest. */
export async function requireApproveReceiptException(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<ReceiptExceptionAccess> {
  return resolve(
    ctx,
    transactionId,
    "manager",
    false,
    "Deciding on a receipt exception needs the Finance manager role.",
  );
}
