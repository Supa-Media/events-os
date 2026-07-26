/**
 * The descriptive + attribution fields a reimbursement PAYOUT transaction should
 * inherit from the reimbursement it settles. Without this, `postReimbursementSpend`
 * (increase.ts) writes a bare row — no category, no "For", no purpose, no
 * receipt, no merchant — so every paid reimbursement lands in Reconcile as an
 * "Unlabeled charge / Uncategorized / For: None / missing receipt", inflating
 * the missing-receipt + uncategorized backlogs even though all of it is
 * already captured on the reimbursement.
 *
 * The payout row is `flow:"outflow"` — the reimbursed purchase IS the
 * chapter's expense, and this row is the only place it enters the ledger — so
 * these fields are the row's LIVE attribution: the category/fund/"For" ported
 * here are what the budget and category rollups actually read. Anything left
 * ambiguous (see `unanimous`) stays unset for a bookkeeper to code in
 * Reconcile rather than being guessed into the wrong budget.
 *
 * Shared by the live insert path (`increase.ts#postReimbursementSpend`) and
 * the one-shot backfill (`reimbursementBackfill.ts`).
 */
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

export type ReimbursementTxnFields = {
  description?: string;
  merchantName?: string;
  note?: string;
  budgetId?: Id<"budgets">;
  eventId?: Id<"events">;
  projectId?: Id<"projects">;
  categoryId?: Id<"budgetCategories">;
  fundId?: Id<"funds">;
  receiptStorageId?: Id<"_storage">;
};

/** The single value shared by every element of `ids`, or `undefined` when the
 *  set is empty or the elements disagree — the "port only when unambiguous"
 *  rule for per-line category/fund. */
function unanimous<T>(ids: (T | undefined)[]): T | undefined {
  const present = ids.filter((x): x is T => x != null);
  if (present.length === 0) return undefined;
  const first = present[0];
  return present.every((x) => x === first) ? first : undefined;
}

export async function deriveReimbursementTxnFields(
  ctx: QueryCtx,
  req: Doc<"reimbursementRequests">,
): Promise<ReimbursementTxnFields> {
  // Bounded like `reimbursements.ts#linesFor` — a reimbursement has a handful
  // of lines, never an unbounded list.
  const lines = await ctx.db
    .query("reimbursementLineItems")
    .withIndex("by_reimbursement", (q) => q.eq("reimbursementId", req._id))
    .take(200);

  const fields: ReimbursementTxnFields = {};

  // Purpose → the txn note (the "who/why" a bookkeeper would otherwise chase).
  const purpose = req.purpose?.trim();
  if (purpose) fields.note = purpose;

  // "For" — the reimbursement's mutually-exclusive event/project/budget target
  // (createReimbursement enforces at most one). Mirror it so the Reconcile "For"
  // column resolves instead of reading "None".
  if (req.budgetId) fields.budgetId = req.budgetId;
  else if (req.eventId) fields.eventId = req.eventId;
  else if (req.projectId) fields.projectId = req.projectId;

  // Merchant / description label. A single-line reimbursement's line text is the
  // truest merchant ("Dig Inn"); a multi-line one collapses to a payee label.
  const payeeLabel = `Reimbursement to ${req.payeeName}`;
  const singleLineMerchant = lines.length === 1 ? lines[0].description?.trim() : "";
  fields.merchantName = singleLineMerchant || payeeLabel;
  fields.description = payeeLabel;

  // Category / fund live per line. Port only when UNAMBIGUOUS (one line, or all
  // lines agree), else leave it for the bookkeeper rather than guess.
  const categoryId = unanimous(lines.map((l) => l.categoryId));
  if (categoryId) fields.categoryId = categoryId;
  const fundId = unanimous(lines.map((l) => l.fundId));
  if (fundId) fields.fundId = fundId;

  // Receipt lives per line (every submitted line has one). Use the first as the
  // row's REPRESENTATIVE receipt so the payout stops reading as "missing
  // receipt"; the authoritative per-line receipts stay on the reimbursement,
  // reachable from the row via `reimbursementId`.
  const withReceipt = lines.find((l) => l.receiptStorageId != null);
  if (withReceipt?.receiptStorageId) fields.receiptStorageId = withReceipt.receiptStorageId;

  return fields;
}
