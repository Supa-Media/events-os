import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { createReceipt, linkReceiptToTransaction } from "../lib/receiptLinks";

/**
 * Backfill the first-class `receipts` layer from the legacy
 * `transactions.receiptStorageId` cache (receipts-foundation PR).
 *
 * Every transaction that already carries a `receiptStorageId` gets a `receipts`
 * DOCUMENT + a `receiptLinks` row (source `backfill`), so the new many-to-many
 * layer is the complete source of truth from day one while the denorm cache
 * keeps serving every existing reader unchanged. Where an `inboundReceipts` row
 * matched THIS transaction with the SAME stored file, the receipt is stamped
 * with that email's provenance (`inboundReceiptId` + source `email`) and its
 * `ocr*` read is copied into BOTH the immutable `ocr*` fields AND the canonical
 * fields (the email pipeline's read is our best canonical seed). For every other
 * (plain upload) receipt the canonical amount/date/merchant are LEFT UNSET — we
 * never fabricate a total we didn't read.
 *
 * IDEMPOTENT: a transaction that already has a `by_transaction` link is skipped,
 * so a re-run creates no duplicates. BATCHED with scheduler continuation
 * (`internal.migrations.continueReceiptBackfill`) so each transaction stays
 * within Convex's per-mutation read/write limits on a large table.
 */

/** Transactions processed per batch — bounded so one mutation stays within
 *  Convex transaction limits; the tail continues via the scheduler. */
const PAGE_SIZE = 100;
/** Bounded scan of matched inbound-email rows, built once per page into a
 *  txn→inbound lookup (inbound-receipt volume is low — a backfill webhook). */
const MATCHED_INBOUND_SCAN = 5000;

export async function backfillReceiptDocumentsPage(
  ctx: MutationCtx,
  cursor: string | null,
): Promise<{ created: number; skipped: number; isDone: boolean }> {
  const page = await ctx.db
    .query("transactions")
    .paginate({ numItems: PAGE_SIZE, cursor });

  // Build a txn→inbound lookup for email provenance: a matched inbound row whose
  // stored file equals the txn's cached receipt is the email this receipt came
  // from. Bounded scan of `matched` rows via `by_status`.
  const matchedInbound = await ctx.db
    .query("inboundReceipts")
    .withIndex("by_status", (q) => q.eq("status", "matched"))
    .take(MATCHED_INBOUND_SCAN);
  const inboundByTxn = new Map<string, Doc<"inboundReceipts">>();
  for (const r of matchedInbound) {
    if (r.matchedTransactionId) inboundByTxn.set(r.matchedTransactionId, r);
  }

  let created = 0;
  let skipped = 0;
  for (const txn of page.page) {
    if (txn.receiptStorageId == null) continue;
    // Idempotency: never double-create for a txn already backfilled/linked.
    const existingLink = await ctx.db
      .query("receiptLinks")
      .withIndex("by_transaction", (q) => q.eq("transactionId", txn._id))
      .first();
    if (existingLink) {
      skipped++;
      continue;
    }

    const inbound = inboundByTxn.get(txn._id);
    const fromEmail =
      inbound != null && inbound.receiptStorageId === txn.receiptStorageId
        ? inbound
        : null;

    let receiptId: Id<"receipts">;
    if (fromEmail) {
      // Email-sourced: stamp provenance and seed canonical FROM the OCR read.
      receiptId = await createReceipt(ctx, {
        chapterId: txn.chapterId,
        storageId: txn.receiptStorageId,
        source: "email",
        inboundReceiptId: fromEmail._id,
        senderClass: fromEmail.senderClass,
        ocrAmountCents: fromEmail.ocrAmountCents,
        ocrDate: fromEmail.ocrDate,
        ocrMerchant: fromEmail.ocrMerchant,
        ocrConfidence: fromEmail.ocrConfidence,
        ocrModel: fromEmail.ocrModel,
      });
    } else {
      // Plain upload: no read we can trust → canonical fields stay unset.
      receiptId = await createReceipt(ctx, {
        chapterId: txn.chapterId,
        storageId: txn.receiptStorageId,
        source: "upload",
      });
    }

    await linkReceiptToTransaction(ctx, {
      receiptId,
      transactionId: txn._id,
      source: "backfill",
      // Backfill reconstructs an EXISTING attachment — never re-decide status.
      reconcileIfCategorized: false,
    });
    created++;
  }

  if (!page.isDone) {
    await ctx.scheduler.runAfter(
      0,
      internal.migrations.continueReceiptBackfill,
      { cursor: page.continueCursor },
    );
  }

  return { created, skipped, isDone: page.isDone };
}

export async function runBackfillReceiptDocuments(ctx: MutationCtx) {
  return await backfillReceiptDocumentsPage(ctx, null);
}

export const backfillReceiptDocuments: Migration = {
  name: "0035_backfill_receipt_documents",
  run: runBackfillReceiptDocuments,
};
