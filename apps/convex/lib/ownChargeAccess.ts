/**
 * "Is this MY charge?" — the one answer, for every gate that carves out the
 * cardholder from a finance-role requirement.
 *
 * ## Why this exists
 *
 * Three gates (`lib/transactionCodingAccess.ts`, `lib/receiptExceptionAccess.ts`,
 * `finances.attachReceipt`) each carried their own inline own-txn test AND
 * each stated the same premise in a comment:
 *
 *   > Central-owned money is central-desk territory. There is no own-txn
 *   > carve-out here — central issues no cards, so a central row has no
 *   > cardholder to be.
 *
 * That premise stopped being true. `increaseCardSync.ts` scopes a card to the
 * Increase ACCOUNT it draws on, never its holder's chapter ("your card
 * determines whose account paid; reconcile determines whose budget it was"),
 * so a chapter member holding a card drawn on central's own account has their
 * charges ingested as `chapterId: "central"` with `personId` set to them
 * (`increaseLedger.ts`). Central issues no cards OF ITS OWN; it very much has
 * cardholders.
 *
 * The result, in production (2026-08-31, a Chapter 08 member on `/code`): the
 * charge is listed — `finances.personTransactions` deliberately shows central
 * rows, that being the caller's own spend — and then EVERY act the page exists
 * for is refused. Read the coding record, submit one, attach a receipt, attest
 * that there is no receipt: `FORBIDDEN`, all four. Worse than a disabled
 * button, because a refused Convex query THROWS as the sheet mounts, so
 * tapping "Finish" unwound to the root `ErrorBoundary` and replaced the whole
 * page. The person's report was "I can't select anything except for uploading
 * the receipt", and the receipt was the one thing that would have failed too.
 *
 * ## The rule
 *
 * A charge is yours if the ledger says so (`transactions.personId` — what
 * `personTransactions` indexes on, so the row you were SHOWN as yours is the
 * row this agrees is yours) or if it sits on your card
 * (`cards.cardholderPersonId` — the same test `finances.submitOwnCharge` and
 * `cards.flagPersonalCharge` already apply, and the field `personId` is
 * derived from at ingest).
 *
 * Scope is deliberately NOT part of the question. The caller's own roster
 * person is resolved in their home chapter; a charge carrying that person id
 * is theirs whichever book pays for it. Callers still decide what ownership
 * BUYS — the coding and receipt gates give an owner the author's rights and
 * nothing more; deciding on your own testimony stays forbidden everywhere
 * (`requireReviewCoding`, `requireApproveReceiptException`).
 *
 * Per the house rule (CLAUDE.md, "Gate It Behind a Power"), this is a named
 * resolver rather than three inline checks: the day "code your own charge"
 * needs narrowing to a `finance.coding.submitOwn` capability, this is the one
 * body that changes and no call site does.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { viewerPerson } from "./org";

/**
 * The caller's own roster person id IFF this transaction is their own charge,
 * else `null`.
 *
 * Returns the id rather than a boolean because every call site needs it
 * anyway: it is the `actorPersonId` the gates hand back for audit rows and
 * separation-of-duties comparisons.
 *
 * @param homeChapterId the CALLER's chapter (not the transaction's) — where
 *   their roster row lives.
 */
export async function ownChargeActor(
  ctx: QueryCtx,
  txn: Doc<"transactions">,
  homeChapterId: Id<"chapters">,
): Promise<Id<"people"> | null> {
  const me = await viewerPerson(ctx, homeChapterId);
  if (!me) return null;
  if (txn.personId != null && txn.personId === me._id) return me._id;
  if (txn.cardId == null) return null;
  const card = await ctx.db.get(txn.cardId);
  return card != null && card.cardholderPersonId === me._id ? me._id : null;
}
