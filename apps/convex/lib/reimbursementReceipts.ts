/**
 * Reimbursement receipts, as first-class receipts.
 *
 * ── THE BUG THIS FIXES ──────────────────────────────────────────────────────
 * A reimbursement line's receipt was stored as a bare `_storage` id on
 * `reimbursementLineItems.receiptStorageId`, and the payout transaction was
 * written with that same id copied straight onto `transactions.
 * receiptStorageId`. That field is a DENORMALIZED CACHE of the first-linked
 * receipt (see `receiptLinks.ts`'s module doc, which says in as many words that
 * nothing but its helpers should ever patch it) — so the payout row was left
 * holding a cache with nothing behind it: no `receipts` row, no `receiptLinks`
 * row, `linkCount` never incremented.
 *
 * The visible result was a pair of symptoms that sounded like two different
 * bugs and were one (founder, 2026-08-12): the Reconcile row says "receipt
 * attached" — truthfully, the cache is set and the file really is in storage —
 * while the Receipts library can never list or find it, because the library
 * reads `receipts`, and no row was ever made. "There is no receipt, but it says
 * attached … but it's not in the file."
 *
 * ── WHAT THIS DOES ──────────────────────────────────────────────────────────
 * One receipt row per line that carries a file, each LINKED to the payout
 * transaction through the ordinary path. That gets three things at once, none
 * of which the old copy did: the document appears in the library like every
 * other receipt, `linkCount` reflects reality, and the transaction's cache is
 * set by the one function allowed to set it.
 *
 * EVERY line's receipt, not just the first. The old code cached one
 * "representative" file because a cache holds one value; a reimbursement for a
 * bus ticket and a hotel has two documents and both are evidence. The first one
 * linked still drives the cache, so nothing downstream changes.
 *
 * CANONICAL FIELDS, NOT OCR. Each row is seeded with its line's own amount,
 * date and description via `createReceipt`'s `canonical` argument. Those are
 * facts a human typed and a reviewer approved — real, and the only reason the
 * document is findable by search — but they are not a machine reading of the
 * file, so the `ocr*` provenance fields stay empty. See that argument's doc.
 *
 * IDEMPOTENT, on the transaction's own links. Called from the live payout path,
 * the one-shot backfill and the migration, and every one of them can run twice.
 * A transaction that already has any `receiptLinks` row has been materialized,
 * so the whole operation short-circuits — which also means a receipt a human
 * has since linked or unlinked by hand is never second-guessed by a re-run.
 */
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { createReceipt, linkReceiptToTransaction } from "./receiptLinks";

/** A reimbursement has a handful of lines, never an unbounded list — same cap
 *  `reimbursementTxnFields.ts` reads them with. */
const LINE_SCAN_LIMIT = 200;

export type MaterializeReimbursementReceiptsResult = {
  /** `receipts` rows created and linked to the payout transaction. */
  created: number;
  /** True when the transaction already carried links, so nothing was done. */
  alreadyMaterialized: boolean;
};

/**
 * Give every receipt on `req`'s lines a real `receipts` row, linked to
 * `transactionId`. Safe to call more than once; see the module doc.
 */
export async function materializeReimbursementReceipts(
  ctx: MutationCtx,
  args: {
    req: Doc<"reimbursementRequests">;
    transactionId: Id<"transactions">;
    /** Where the receipt belongs — the payout transaction's own book. */
    chapterId: Id<"chapters"> | "central";
  },
): Promise<MaterializeReimbursementReceiptsResult> {
  // Already done? A single link is proof: this helper always creates at least
  // one when it runs at all, and only ever for a transaction with none.
  const existingLink = await ctx.db
    .query("receiptLinks")
    .withIndex("by_transaction", (q) => q.eq("transactionId", args.transactionId))
    .first();
  if (existingLink) return { created: 0, alreadyMaterialized: true };

  const lines = await ctx.db
    .query("reimbursementLineItems")
    .withIndex("by_reimbursement", (q) => q.eq("reimbursementId", args.req._id))
    .take(LINE_SCAN_LIMIT);

  let created = 0;
  // Line order, so the FIRST line's receipt is the one that drives the
  // transaction's cache — the same document the old copy chose, so no
  // downstream reader sees a different "the" receipt than it did before.
  for (const line of lines.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    if (!line.receiptStorageId) continue;

    const receiptId = await createReceipt(ctx, {
      chapterId: args.chapterId,
      storageId: line.receiptStorageId,
      // The claimant uploaded it when they filed. Not `email`/`sms`: those
      // describe how a document ARRIVED, and this one arrived through a form.
      source: "upload",
      ...(args.req.personId ? { uploadedByPersonId: args.req.personId } : {}),
      canonical: {
        amountCents: line.amountCents,
        ...(line.transactionDate != null
          ? { receiptDate: line.transactionDate }
          : {}),
        ...(line.description?.trim()
          ? { merchant: line.description.trim() }
          : {}),
      },
      note: `Reimbursement to ${args.req.payeeName}`,
    });

    await linkReceiptToTransaction(ctx, {
      receiptId,
      transactionId: args.transactionId,
      source: "upload",
      ...(args.req.personId ? { linkedByPersonId: args.req.personId } : {}),
      // The payout row is inserted `reconciled` already, so this never fires —
      // passed explicitly so a future change to that insert can't silently
      // start flipping statuses from in here.
      reconcileIfCategorized: false,
    });
    created++;
  }

  return { created, alreadyMaterialized: false };
}
