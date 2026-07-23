import { describe, expect, test } from "vitest";
import {
  newT,
  run,
  setupChapter,
  storeBlob,
  type ChapterSetup,
} from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  createReceipt,
  linkReceiptToTransaction,
  unlinkReceiptFromTransaction,
} from "../lib/receiptLinks";
import { runBackfillReceiptDocuments } from "../migrations/0035_backfill_receipt_documents";

/**
 * The first-class receipts layer (`lib/receiptLinks.ts`) + its backfill
 * (`migrations/0035`). Exercises the denormalization contract directly: the
 * `receipts.linkCount` counter and the `transactions.receiptStorageId` cache the
 * link layer maintains as the many-to-many source of truth, plus repointing on
 * unlink, double-link idempotency, and the money-safety reconcile rules.
 */

async function seedTxn(
  s: ChapterSetup,
  opts: {
    status?: "unreviewed" | "categorized" | "reconciled" | "excluded";
    hasReceipt?: boolean;
  } = {},
): Promise<Id<"transactions">> {
  return await run(s.t, async (ctx) => {
    const storageId = opts.hasReceipt
      ? await (ctx.storage as unknown as {
          store: (b: Blob) => Promise<Id<"_storage">>;
        }).store(new Blob(["r"], { type: "image/png" }))
      : undefined;
    return await ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: 4210,
      postedAt: Date.now(),
      merchantName: "Office Depot",
      status: opts.status ?? "unreviewed",
      receiptStorageId: storageId,
      createdAt: Date.now(),
    });
  });
}

async function newUploadReceipt(s: ChapterSetup): Promise<{
  receiptId: Id<"receipts">;
  storageId: Id<"_storage">;
}> {
  const storageId = await storeBlob(s.t);
  const receiptId = await run(s.t, (ctx) =>
    createReceipt(ctx, {
      chapterId: s.chapterId,
      storageId,
      source: "upload",
    }),
  );
  return { receiptId, storageId };
}

// ── link denorm behavior ─────────────────────────────────────────────────────
describe("linkReceiptToTransaction", () => {
  test("first link sets the denorm cache, bumps linkCount, and reconciles a categorized charge", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const txn = await seedTxn(s, { status: "categorized" });
    const { receiptId, storageId } = await newUploadReceipt(s);

    const res = await run(t, (ctx) =>
      linkReceiptToTransaction(ctx, {
        receiptId,
        transactionId: txn,
        source: "manual",
      }),
    );
    expect(res).toEqual({ linked: true, reconciled: true });

    const receipt = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(receipt?.linkCount).toBe(1);
    const txnRow = await run(t, (ctx) => ctx.db.get(txn));
    expect(txnRow?.receiptStorageId).toBe(storageId);
    expect(txnRow?.status).toBe("reconciled");
  });

  test("reconcileIfCategorized:false attaches without flipping status", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const txn = await seedTxn(s, { status: "categorized" });
    const { receiptId } = await newUploadReceipt(s);

    const res = await run(t, (ctx) =>
      linkReceiptToTransaction(ctx, {
        receiptId,
        transactionId: txn,
        source: "upload",
        reconcileIfCategorized: false,
      }),
    );
    expect(res).toEqual({ linked: true, reconciled: false });
    const txnRow = await run(t, (ctx) => ctx.db.get(txn));
    expect(txnRow?.status).toBe("categorized");
  });

  test("double-linking the same pair is idempotent (no-op)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const txn = await seedTxn(s, { status: "unreviewed" });
    const { receiptId } = await newUploadReceipt(s);

    const first = await run(t, (ctx) =>
      linkReceiptToTransaction(ctx, { receiptId, transactionId: txn, source: "manual" }),
    );
    const second = await run(t, (ctx) =>
      linkReceiptToTransaction(ctx, { receiptId, transactionId: txn, source: "manual" }),
    );
    expect(first.linked).toBe(true);
    expect(second.linked).toBe(false);

    const receipt = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(receipt?.linkCount).toBe(1);
    const links = await run(t, (ctx) =>
      ctx.db
        .query("receiptLinks")
        .withIndex("by_receipt", (q) => q.eq("receiptId", receiptId))
        .collect(),
    );
    expect(links.length).toBe(1);
  });

  test("one receipt → two transactions (both get the cache; linkCount 2)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const txnA = await seedTxn(s);
    const txnB = await seedTxn(s);
    const { receiptId, storageId } = await newUploadReceipt(s);

    await run(t, (ctx) =>
      linkReceiptToTransaction(ctx, { receiptId, transactionId: txnA, source: "manual" }),
    );
    await run(t, (ctx) =>
      linkReceiptToTransaction(ctx, { receiptId, transactionId: txnB, source: "manual" }),
    );

    const receipt = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(receipt?.linkCount).toBe(2);
    const a = await run(t, (ctx) => ctx.db.get(txnA));
    const b = await run(t, (ctx) => ctx.db.get(txnB));
    expect(a?.receiptStorageId).toBe(storageId);
    expect(b?.receiptStorageId).toBe(storageId);
  });

  test("two receipts → one transaction: the second link does NOT overwrite the cache or reconcile", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const txn = await seedTxn(s, { status: "categorized" });
    const r1 = await newUploadReceipt(s);
    const r2 = await newUploadReceipt(s);

    const first = await run(t, (ctx) =>
      linkReceiptToTransaction(ctx, {
        receiptId: r1.receiptId,
        transactionId: txn,
        source: "manual",
      }),
    );
    expect(first.reconciled).toBe(true);
    const second = await run(t, (ctx) =>
      linkReceiptToTransaction(ctx, {
        receiptId: r2.receiptId,
        transactionId: txn,
        source: "manual",
      }),
    );
    // Second receipt links but the txn already had a cached file → untouched.
    expect(second).toEqual({ linked: true, reconciled: false });
    const txnRow = await run(t, (ctx) => ctx.db.get(txn));
    expect(txnRow?.receiptStorageId).toBe(r1.storageId);
  });
});

// ── unlink denorm behavior ───────────────────────────────────────────────────
describe("unlinkReceiptFromTransaction", () => {
  test("unlinking the PRIMARY receipt repoints the cache to another still-linked receipt", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const txn = await seedTxn(s);
    const r1 = await newUploadReceipt(s);
    const r2 = await newUploadReceipt(s);

    await run(t, (ctx) =>
      linkReceiptToTransaction(ctx, { receiptId: r1.receiptId, transactionId: txn, source: "manual" }),
    );
    await run(t, (ctx) =>
      linkReceiptToTransaction(ctx, { receiptId: r2.receiptId, transactionId: txn, source: "manual" }),
    );
    // r1 is the cached (primary) file.
    let txnRow = await run(t, (ctx) => ctx.db.get(txn));
    expect(txnRow?.receiptStorageId).toBe(r1.storageId);

    // Unlink the primary → cache repoints to r2 (still linked), never cleared.
    await run(t, (ctx) =>
      unlinkReceiptFromTransaction(ctx, { receiptId: r1.receiptId, transactionId: txn }),
    );
    txnRow = await run(t, (ctx) => ctx.db.get(txn));
    expect(txnRow?.receiptStorageId).toBe(r2.storageId);
    const rec1 = await run(t, (ctx) => ctx.db.get(r1.receiptId));
    expect(rec1?.linkCount).toBe(0);

    // Unlink the last one → cache clears; status never changes.
    await run(t, (ctx) =>
      unlinkReceiptFromTransaction(ctx, { receiptId: r2.receiptId, transactionId: txn }),
    );
    txnRow = await run(t, (ctx) => ctx.db.get(txn));
    expect(txnRow?.receiptStorageId).toBeUndefined();
    expect(txnRow?.status).toBe("unreviewed");
  });

  test("unlinking a NON-primary receipt leaves the cache untouched", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const txn = await seedTxn(s);
    const r1 = await newUploadReceipt(s);
    const r2 = await newUploadReceipt(s);
    await run(t, (ctx) =>
      linkReceiptToTransaction(ctx, { receiptId: r1.receiptId, transactionId: txn, source: "manual" }),
    );
    await run(t, (ctx) =>
      linkReceiptToTransaction(ctx, { receiptId: r2.receiptId, transactionId: txn, source: "manual" }),
    );
    await run(t, (ctx) =>
      unlinkReceiptFromTransaction(ctx, { receiptId: r2.receiptId, transactionId: txn }),
    );
    const txnRow = await run(t, (ctx) => ctx.db.get(txn));
    expect(txnRow?.receiptStorageId).toBe(r1.storageId);
  });
});

// ── finances.attachReceipt (the mobile upload path) ──────────────────────────
describe("finances.attachReceipt", () => {
  test("writes a receipts row + upload link and does NOT reconcile a categorized charge", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // The caller needs a bookkeeper seat (+ a roster person for the uploader stamp).
    const person = await run(t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Book Keeper",
        userId: s.userId,
        createdAt: Date.now(),
      }),
    );
    await run(t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId: person,
        role: "bookkeeper",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );
    const txn = await seedTxn(s, { status: "categorized" });
    const storageId = await storeBlob(t);

    await s.as.mutation(api.finances.attachReceipt, {
      transactionId: txn,
      storageId,
    });

    const txnRow = await run(t, (ctx) => ctx.db.get(txn));
    expect(txnRow?.receiptStorageId).toBe(storageId);
    // Upload path preserves the "no auto-reconcile" behavior.
    expect(txnRow?.status).toBe("categorized");

    const receipts = await run(t, (ctx) => ctx.db.query("receipts").take(5));
    expect(receipts.length).toBe(1);
    expect(receipts[0].source).toBe("upload");
    expect(receipts[0].uploadedByPersonId).toBe(person);
    expect(receipts[0].linkCount).toBe(1);
    const links = await run(t, (ctx) => ctx.db.query("receiptLinks").take(5));
    expect(links.length).toBe(1);
    expect(links[0].source).toBe("upload");
  });
});

// ── migration 0035 (backfill from the legacy denorm cache) ───────────────────
describe("backfillReceiptDocuments", () => {
  test("creates one receipt + backfill link per receipted txn and is idempotent", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const withReceipt = await seedTxn(s, { status: "categorized", hasReceipt: true });
    await seedTxn(s, { status: "categorized" }); // no receipt → skipped

    await run(t, (ctx) => runBackfillReceiptDocuments(ctx));

    let receipts = await run(t, (ctx) => ctx.db.query("receipts").take(10));
    let links = await run(t, (ctx) => ctx.db.query("receiptLinks").take(10));
    expect(receipts.length).toBe(1);
    expect(receipts[0].source).toBe("upload");
    expect(receipts[0].amountCents).toBeUndefined(); // never fabricated
    expect(receipts[0].linkCount).toBe(1);
    expect(links.length).toBe(1);
    expect(links[0].source).toBe("backfill");
    expect(links[0].transactionId).toBe(withReceipt);

    // A categorized charge is NOT reconciled by the backfill.
    const txnRow = await run(t, (ctx) => ctx.db.get(withReceipt));
    expect(txnRow?.status).toBe("categorized");

    // Re-run → no duplicates.
    await run(t, (ctx) => runBackfillReceiptDocuments(ctx));
    receipts = await run(t, (ctx) => ctx.db.query("receipts").take(10));
    links = await run(t, (ctx) => ctx.db.query("receiptLinks").take(10));
    expect(receipts.length).toBe(1);
    expect(links.length).toBe(1);
  });

  test("stamps email provenance + seeds canonical from OCR when an inbound row matched the txn", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const storageId = await storeBlob(t);
    const txn = await run(t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 4210,
        postedAt: Date.now(),
        status: "categorized",
        receiptStorageId: storageId,
        createdAt: Date.now(),
      }),
    );
    const inbound = await run(t, (ctx) =>
      ctx.db.insert("inboundReceipts", {
        emailId: "e_prov_1",
        status: "matched",
        fromEmail: "jane@example.com",
        chapterId: s.chapterId,
        receiptStorageId: storageId,
        matchedTransactionId: txn,
        senderClass: "roster",
        ocrAmountCents: 4210,
        ocrMerchant: "Home Depot",
        receivedAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    await run(t, (ctx) => runBackfillReceiptDocuments(ctx));

    const receipts = await run(t, (ctx) => ctx.db.query("receipts").take(10));
    expect(receipts.length).toBe(1);
    const r = receipts[0];
    expect(r.source).toBe("email");
    expect(r.inboundReceiptId).toBe(inbound);
    expect(r.senderClass).toBe("roster");
    // OCR read copied into BOTH ocr* and canonical.
    expect(r.ocrAmountCents).toBe(4210);
    expect(r.amountCents).toBe(4210);
    expect(r.merchant).toBe("Home Depot");
  });
});
