/**
 * Receipt-SUGGESTION authorization — who may see the unlinked receipts a
 * transaction might be documented with, and who may confirm one onto it.
 *
 * This gate exists because of the 2026-08-08 owner decision that turned the
 * inbound pipeline from AUTO-ATTACH into CAPTURE-AND-SUGGEST: a receipt that
 * is texted or emailed in no longer links itself to a charge the system
 * guessed at — it waits, unlinked, until the person coding the charge says
 * "yes, that's the one". That person is usually the CARDHOLDER, not a
 * bookkeeper, and every read in `receipts.ts` is `requireFinanceRole(…,
 * "bookkeeper")`-gated — which is precisely why the coding sheet couldn't
 * offer suggestions before this file existed.
 *
 * The bar is `lib/transactionCodingAccess.ts#requireSubmitCoding`'s, and
 * deliberately so: whoever may AUTHOR the coding on a transaction may see the
 * receipts offered for it and attach one. A cardholder looking at their own
 * charge and their own receipt at the same moment is the entire point; a
 * bookkeeper coding on someone's behalf needs the same list.
 *
 * OPEN TODAY, GATED ANYWAY (house rule): the body below is the own-row-or-
 * bookkeeper+ check, with no seat capability consulted. The day suggestions
 * need to be narrowed (or widened past the cardholder), add
 * `finance.receipts.suggest` to `SEAT_CAPABILITIES`, list it on the seats that
 * should carry it, and change THIS function's body — no call site moves.
 *
 * Scope resolution mirrors `requireSubmitCoding`'s `resolve` byte for byte
 * (central-owned money is central-desk territory and issues no cards, so a
 * central row has no cardholder to be). Every refusal throws
 * `ConvexError({ code, message })` so the app's AuthErrorBoundary surfaces it.
 */
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { CENTRAL, financeRoleAtLeast } from "@events-os/shared";
import { getFinanceRole, requireFinanceCentral, type FinanceScope } from "./finance";
import { requireChapterId } from "./context";

/** The resolved right to see/confirm receipt suggestions on one transaction. */
export interface ReceiptSuggestionAccess {
  txn: Doc<"transactions">;
  scope: FinanceScope;
  /** The caller's roster person id at this scope. `null` for a superuser with
   *  no roster row (the same supported path as the coding gates). */
  actorPersonId: Id<"people"> | null;
  /** True when the caller reached this row as its OWN person (the cardholder
   *  coding their own charge) rather than on a finance grant. Callers use it
   *  for copy, never for a second authorization decision. */
  isOwnTxn: boolean;
  /** True when the caller holds bookkeeper+ in the row's scope — i.e. they
   *  could reach the same receipt through the bookkeeper surfaces
   *  (`receipts.linkReceipt`) anyway. Used to decide how far the OFFERED pool
   *  may stretch, never whether the caller is allowed in at all. */
  isBookkeeper: boolean;
}

/**
 * Assert the caller may see (and confirm) receipt suggestions for one
 * transaction: its own person, or bookkeeper+ in the transaction's scope.
 */
export async function requireReceiptSuggestions(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<ReceiptSuggestionAccess> {
  const homeChapterId = (await requireChapterId(ctx)) as Id<"chapters">;
  const txn = (await ctx.db.get(transactionId)) as Doc<"transactions"> | null;
  const notFound = () =>
    new ConvexError({
      code: "NOT_FOUND",
      message: "Transaction not found in your chapter.",
    });
  if (!txn) throw notFound();

  const forbidden = () =>
    new ConvexError({
      code: "FORBIDDEN",
      message:
        "Only the transaction's own person or a bookkeeper can see receipt suggestions for this charge.",
    });

  if (txn.chapterId === CENTRAL) {
    const access = await requireFinanceCentral(ctx, homeChapterId);
    if (!financeRoleAtLeast(access.role, "bookkeeper")) throw forbidden();
    return {
      txn,
      scope: CENTRAL,
      actorPersonId: access.personId,
      isOwnTxn: false,
      isBookkeeper: true,
    };
  }

  const access = await getFinanceRole(ctx, homeChapterId);
  if (txn.chapterId !== homeChapterId) throw notFound();
  const isOwnTxn = access.personId != null && access.personId === txn.personId;
  const isBookkeeper = financeRoleAtLeast(access.role, "bookkeeper");
  if (!isOwnTxn && !isBookkeeper) throw forbidden();
  return {
    txn,
    scope: txn.chapterId,
    actorPersonId: access.personId,
    isOwnTxn,
    isBookkeeper,
  };
}

/** True iff the caller may see receipt suggestions for this transaction.
 *  Read-only probe for the UI (every mutation calls the `require` form). */
export async function hasReceiptSuggestions(
  ctx: QueryCtx,
  transactionId: Id<"transactions">,
): Promise<boolean> {
  try {
    await requireReceiptSuggestions(ctx, transactionId);
    return true;
  } catch {
    return false;
  }
}
