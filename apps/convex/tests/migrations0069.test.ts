/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, storeBlob, type ChapterSetup } from "./setup.helpers";
import { runMaterializeReimbursementReceipts } from "../migrations/0069_materialize_reimbursement_receipts";
import { createReceipt, linkReceiptToTransaction } from "../lib/receiptLinks";
import type { Id } from "../_generated/dataModel";

/**
 * Migration 0069 — give already-paid reimbursements' receipts real `receipts`
 * rows. See the migration's module doc for the two-symptom bug behind it.
 */

async function seedPaidReimbursement(
  s: ChapterSetup,
  opts: { lineDescriptions: string[]; withReceipts: boolean },
): Promise<{ txnId: Id<"transactions">; storageIds: Id<"_storage">[] }> {
  const storageIds: Id<"_storage">[] = [];
  for (const _ of opts.lineDescriptions) {
    if (opts.withReceipts) storageIds.push(await storeBlob(s.t));
  }
  const txnId = await run(s.t, async (ctx) => {
    const now = Date.now();
    const reimbursementId = await ctx.db.insert("reimbursementRequests", {
      chapterId: s.chapterId,
      token: `tok-${Math.random()}`,
      payeeName: "Adam",
      status: "paid",
      totalCents: 1000 * opts.lineDescriptions.length,
      createdAt: now,
      updatedAt: now,
    });
    let order = 0;
    for (const description of opts.lineDescriptions) {
      await ctx.db.insert("reimbursementLineItems", {
        chapterId: s.chapterId,
        reimbursementId,
        description,
        amountCents: 1000,
        transactionDate: now,
        order,
        ...(opts.withReceipts ? { receiptStorageId: storageIds[order] } : {}),
        createdAt: now,
      });
      order++;
    }
    return await ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "reimbursement",
      reimbursementId,
      flow: "outflow",
      amountCents: 1000 * opts.lineDescriptions.length,
      postedAt: now,
      status: "reconciled",
      // The stale shape this migration exists for: the cache was copied on
      // directly, with no `receipts` row behind it.
      ...(opts.withReceipts ? { receiptStorageId: storageIds[0] } : {}),
      createdAt: now,
    });
  });
  return { txnId, storageIds };
}

describe("0069_materialize_reimbursement_receipts", () => {
  test("creates a receipt per line document and links each to the payout", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { txnId, storageIds } = await seedPaidReimbursement(s, {
      lineDescriptions: ["Bus ticket", "Parking"],
      withReceipts: true,
    });

    const result = await run(s.t, (ctx) => runMaterializeReimbursementReceipts(ctx));
    expect(result).toEqual({ scanned: 1, created: 2, alreadyLinked: 0 });

    const receipts = await run(s.t, (ctx) => ctx.db.query("receipts").collect());
    expect(receipts).toHaveLength(2);
    expect(receipts.map((r) => r.storageId).sort()).toEqual([...storageIds].sort());
    expect(receipts.map((r) => r.merchant).sort()).toEqual(["Bus ticket", "Parking"]);
    // Human-asserted facts land canonical; nothing read the file, so no OCR.
    expect(receipts.every((r) => r.ocrMerchant === undefined)).toBe(true);
    expect(receipts.every((r) => r.linkCount === 1)).toBe(true);

    const links = await run(s.t, (ctx) => ctx.db.query("receiptLinks").collect());
    expect(links).toHaveLength(2);
    expect(links.every((l) => l.transactionId === txnId)).toBe(true);

    // The cache still points at the first line's document — unchanged, so no
    // row flickers to "missing receipt", not even for an instant.
    const after = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(after?.receiptStorageId).toBe(storageIds[0]);
  });

  test("leaves a payout a human already linked a receipt to completely alone", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { txnId } = await seedPaidReimbursement(s, {
      lineDescriptions: ["Bus ticket"],
      withReceipts: true,
    });
    // Somebody matched a receipt by hand before this ever ran.
    const handStorageId = await storeBlob(s.t);
    await run(s.t, async (ctx) => {
      const receiptId = await createReceipt(ctx, {
        chapterId: s.chapterId,
        storageId: handStorageId,
        source: "upload",
      });
      await linkReceiptToTransaction(ctx, {
        receiptId,
        transactionId: txnId,
        source: "manual",
      });
    });

    const result = await run(s.t, (ctx) => runMaterializeReimbursementReceipts(ctx));
    expect(result.alreadyLinked).toBe(1);
    expect(result.created).toBe(0);
    // No duplicate copy of the same document.
    expect(await run(s.t, (ctx) => ctx.db.query("receipts").collect())).toHaveLength(1);
  });

  test("a reimbursement with no documents creates nothing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPaidReimbursement(s, {
      lineDescriptions: ["Bus ticket"],
      withReceipts: false,
    });
    const result = await run(s.t, (ctx) => runMaterializeReimbursementReceipts(ctx));
    expect(result).toEqual({ scanned: 1, created: 0, alreadyLinked: 0 });
    expect(await run(s.t, (ctx) => ctx.db.query("receipts").collect())).toHaveLength(0);
  });

  test("is idempotent — a second run creates nothing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPaidReimbursement(s, {
      lineDescriptions: ["Bus ticket"],
      withReceipts: true,
    });
    expect((await run(s.t, (ctx) => runMaterializeReimbursementReceipts(ctx))).created).toBe(1);
    const second = await run(s.t, (ctx) => runMaterializeReimbursementReceipts(ctx));
    expect(second.created).toBe(0);
    expect(second.alreadyLinked).toBe(1);
    expect(await run(s.t, (ctx) => ctx.db.query("receipts").collect())).toHaveLength(1);
  });
});
