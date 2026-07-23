/**
 * Receipt ⇄ transaction linking — the ONE write path for the many-to-many
 * `receipts` ⇄ `receiptLinks` ⇄ `transactions` layer.
 *
 * `receipts` is the source of truth a receipt document is; a receipt can back
 * MANY transactions and a transaction can carry MANY receipts. The legacy
 * `transactions.receiptStorageId` field survives as a DENORMALIZED CACHE of
 * "the" (first-linked) receipt's stored file, so every existing reader — the
 * reconcile `missing_receipt` filter, receipt reminders, the 7-day card
 * auto-lock, the `hasReceipt` display — keeps working unchanged. These helpers
 * are the only place that cache and `receipts.linkCount` are kept consistent;
 * nothing else should patch `receiptStorageId` or insert a `receiptLinks` row.
 *
 * MONEY SAFETY: the only transaction-status change any of these make is the
 * behavior-preserving `categorized → reconciled` flip when a receipt first
 * lands on an already-coded charge (opt-out via `reconcileIfCategorized`).
 * Unlinking NEVER changes status — a human unlinked deliberately.
 */
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { unlockCardIfReceiptsResolved } from "../cards";
import type {
  ReceiptSource,
  ReceiptLinkSource,
  ReceiptSenderClass,
} from "@events-os/shared";

/** A chapter id or the `"central"` sentinel (mirrors `transactions.chapterId`). */
type ReceiptChapterId = Id<"chapters"> | "central";

/**
 * Insert a `receipts` row with `linkCount: 0`, seeding the CANONICAL
 * (human-correctable) fields from the provided OCR values. The `ocr*` fields are
 * immutable provenance; the canonical `amountCents`/`receiptDate`/`merchant` are
 * seeded to match at creation and edited only by a later correction mutation.
 * Returns the new receipt id. Callers link it to transaction(s) separately via
 * `linkReceiptToTransaction`.
 */
export async function createReceipt(
  ctx: MutationCtx,
  args: {
    // Absent only for an unknown-sender email receipt (no chapter to infer).
    chapterId?: ReceiptChapterId;
    storageId: Id<"_storage">;
    source: ReceiptSource;
    inboundReceiptId?: Id<"inboundReceipts">;
    uploadedByPersonId?: Id<"people">;
    senderClass?: ReceiptSenderClass;
    ocrAmountCents?: number;
    ocrDate?: number;
    ocrMerchant?: string;
    ocrConfidence?: number;
    ocrModel?: string;
    // RECEIPT QUALITY PR: a human-readable reason extraction produced nothing
    // (see `schema/finances.ts`'s doc comment on `receipts.ocrError`), and the
    // original attachment filename (or a synthetic "email body"/"text
    // message" label) — both optional, populated by every ingest path.
    ocrError?: string;
    filename?: string;
    note?: string;
    candidateTransactionIds?: Id<"transactions">[];
    // CRM PR: the stored file's content hash (from the `_storage` system
    // table), and — when a same-chapter earlier receipt already carries that
    // hash — the id of the receipt this one duplicates. Both optional; a
    // caller that hasn't computed a hash (or found no dupe) omits them.
    fileSha256?: string;
    duplicateOfReceiptId?: Id<"receipts">;
  },
): Promise<Id<"receipts">> {
  const now = Date.now();
  return await ctx.db.insert("receipts", {
    ...(args.chapterId != null ? { chapterId: args.chapterId } : {}),
    storageId: args.storageId,
    source: args.source,
    ...(args.inboundReceiptId ? { inboundReceiptId: args.inboundReceiptId } : {}),
    ...(args.uploadedByPersonId
      ? { uploadedByPersonId: args.uploadedByPersonId }
      : {}),
    ...(args.senderClass ? { senderClass: args.senderClass } : {}),
    ...(args.filename ? { filename: args.filename } : {}),
    ...(args.ocrError ? { ocrError: args.ocrError } : {}),
    ...(args.fileSha256 ? { fileSha256: args.fileSha256 } : {}),
    ...(args.duplicateOfReceiptId
      ? { duplicateOfReceiptId: args.duplicateOfReceiptId }
      : {}),
    // Canonical fields seeded from OCR (never fabricated — undefined stays
    // undefined so a backfilled legacy document keeps no read total).
    ...(args.ocrAmountCents != null ? { amountCents: args.ocrAmountCents } : {}),
    ...(args.ocrDate != null ? { receiptDate: args.ocrDate } : {}),
    ...(args.ocrMerchant ? { merchant: args.ocrMerchant } : {}),
    ...(args.note ? { note: args.note } : {}),
    // Immutable OCR provenance.
    ...(args.ocrAmountCents != null ? { ocrAmountCents: args.ocrAmountCents } : {}),
    ...(args.ocrDate != null ? { ocrDate: args.ocrDate } : {}),
    ...(args.ocrMerchant ? { ocrMerchant: args.ocrMerchant } : {}),
    ...(args.ocrConfidence != null ? { ocrConfidence: args.ocrConfidence } : {}),
    ...(args.ocrModel ? { ocrModel: args.ocrModel } : {}),
    ...(args.candidateTransactionIds
      ? { candidateTransactionIds: args.candidateTransactionIds }
      : {}),
    linkCount: 0,
    createdAt: now,
    updatedAt: now,
  });
}

/** Find the existing link row for a (receipt, transaction) pair, or null.
 *  Bounded: a receipt links to few transactions, so scanning its `by_receipt`
 *  links and matching the transaction is cheap. */
async function findLink(
  ctx: MutationCtx,
  receiptId: Id<"receipts">,
  transactionId: Id<"transactions">,
): Promise<Id<"receiptLinks"> | null> {
  const links = await ctx.db
    .query("receiptLinks")
    .withIndex("by_receipt", (q) => q.eq("receiptId", receiptId))
    .take(200);
  const hit = links.find((l) => l.transactionId === transactionId);
  return hit ? hit._id : null;
}

/**
 * Link a receipt to a transaction (the ONLY way to create a `receiptLinks` row).
 *
 * No-op (returns `{ linked: false }`) if the pair is already linked. Otherwise
 * inserts the link, increments `receipts.linkCount`, and — ONLY when the txn has
 * no `receiptStorageId` yet — points the denorm cache at this receipt's file,
 * clears the receipt-reminder timeline, re-checks the card's receipt-lock, and
 * (when `reconcileIfCategorized`) flips a `categorized` charge to `reconciled`.
 * A second receipt on a txn that already has a cached file never overwrites it
 * and never reconciles.
 */
export async function linkReceiptToTransaction(
  ctx: MutationCtx,
  args: {
    receiptId: Id<"receipts">;
    transactionId: Id<"transactions">;
    source: ReceiptLinkSource;
    linkedByPersonId?: Id<"people">;
    reconcileIfCategorized?: boolean;
  },
): Promise<{ linked: boolean; reconciled: boolean }> {
  const reconcileIfCategorized = args.reconcileIfCategorized ?? true;

  const existing = await findLink(ctx, args.receiptId, args.transactionId);
  if (existing) return { linked: false, reconciled: false };

  const receipt = await ctx.db.get(args.receiptId);
  if (!receipt) return { linked: false, reconciled: false };
  const txn = await ctx.db.get(args.transactionId);
  if (!txn) return { linked: false, reconciled: false };

  await ctx.db.insert("receiptLinks", {
    receiptId: args.receiptId,
    transactionId: args.transactionId,
    chapterId: txn.chapterId,
    source: args.source,
    ...(args.linkedByPersonId ? { linkedByPersonId: args.linkedByPersonId } : {}),
    createdAt: Date.now(),
  });
  await ctx.db.patch(args.receiptId, {
    linkCount: receipt.linkCount + 1,
    updatedAt: Date.now(),
  });

  let reconciled = false;
  // Only the FIRST receipt to land on a txn drives the denorm cache + status.
  if (txn.receiptStorageId == null) {
    reconciled =
      reconcileIfCategorized && txn.status === "categorized";
    await ctx.db.patch(args.transactionId, {
      receiptStorageId: receipt.storageId,
      receiptReminderStage: undefined,
      lastReminderSentAt: undefined,
      ...(reconciled ? { status: "reconciled" as const } : {}),
    });
    if (txn.cardId) {
      await unlockCardIfReceiptsResolved(ctx, txn.cardId);
    }
  }

  return { linked: true, reconciled };
}

/**
 * Remove a receipt↔transaction link. Deletes the link, decrements
 * `receipts.linkCount`, and — if this receipt's file was the one cached on the
 * txn's `receiptStorageId` — repoints the cache at another still-linked
 * receipt's file (or clears it when none remain). NEVER changes the txn's
 * status: a human unlinked deliberately, so re-deciding reconcile is their call.
 */
export async function unlinkReceiptFromTransaction(
  ctx: MutationCtx,
  args: { receiptId: Id<"receipts">; transactionId: Id<"transactions"> },
): Promise<{ unlinked: boolean }> {
  const linkId = await findLink(ctx, args.receiptId, args.transactionId);
  if (!linkId) return { unlinked: false };

  await ctx.db.delete(linkId);
  const receipt = await ctx.db.get(args.receiptId);
  if (receipt) {
    await ctx.db.patch(args.receiptId, {
      linkCount: Math.max(0, receipt.linkCount - 1),
      updatedAt: Date.now(),
    });
  }

  const txn = await ctx.db.get(args.transactionId);
  if (txn && receipt && txn.receiptStorageId === receipt.storageId) {
    // The unlinked receipt WAS the cached file — repoint at another still-linked
    // receipt, or clear the cache when this was the last one.
    const remaining = await ctx.db
      .query("receiptLinks")
      .withIndex("by_transaction", (q) =>
        q.eq("transactionId", args.transactionId),
      )
      .take(200);
    let nextStorageId: Id<"_storage"> | undefined;
    for (const link of remaining) {
      const other = await ctx.db.get(link.receiptId);
      if (other) {
        nextStorageId = other.storageId;
        break;
      }
    }
    await ctx.db.patch(args.transactionId, { receiptStorageId: nextStorageId });
  }

  return { unlinked: true };
}

/**
 * Find an EARLIER receipt in the same chapter whose stored file has the exact
 * same content hash (`by_sha256`, then chapter-filtered in memory — a real
 * hash collision among one chapter's receipts is rare, so this stays cheap).
 * Used by both ingest paths (`receipts.ts#submitUploadedReceipts`,
 * `receiptInbox.ts#commitInboundReceipts`) to catch the SAME bytes arriving
 * twice, whether by re-upload or by re-forwarding an email — deliberately
 * scoped to one chapter (a coincidental cross-chapter match is not a
 * duplicate submission, just two chapters photographing similar receipts).
 * A chapterless (unknown-sender) or central-owned receipt never dedupes
 * (`chapterId` must be a real chapter id) — returns `null` immediately.
 */
export async function findDuplicateReceiptBySha256(
  ctx: MutationCtx,
  chapterId: ReceiptChapterId | undefined,
  fileSha256: string,
): Promise<Id<"receipts"> | null> {
  if (chapterId == null || chapterId === "central") return null;
  const matches = await ctx.db
    .query("receipts")
    .withIndex("by_sha256", (q) => q.eq("fileSha256", fileSha256))
    .take(50);
  const hit = matches.find((r) => r.chapterId === chapterId);
  return hit ? hit._id : null;
}
