import { describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { createReceipt, linkReceiptToTransaction } from "../lib/receiptLinks";

/**
 * The receipt CRM surface (`receipts.ts`): the query/mutation API the UI
 * consumes, plus mass upload + duplicate detection. The email-pipeline side of
 * duplicate detection (`commitInboundReceipts`'s `fileSha256` check) is
 * exercised in `receiptInbox.test.ts`, not here.
 */

// ── Seed helpers ─────────────────────────────────────────────────────────────
async function seedPerson(s: ChapterSetup): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Book Keeper",
      userId: s.userId,
      createdAt: Date.now(),
    }),
  );
}

async function grantRole(
  s: ChapterSetup,
  personId: Id<"people">,
  role: "viewer" | "bookkeeper" | "manager",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
}

/** Seed a bookkeeper-capable caller (person + grant) in one call. */
async function seedBookkeeper(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedPerson(s);
  await grantRole(s, personId, "bookkeeper");
  return personId;
}

async function seedTxn(
  s: ChapterSetup,
  opts: {
    amountCents?: number;
    postedAt?: number;
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
      amountCents: opts.amountCents ?? 4210,
      postedAt: opts.postedAt ?? Date.now(),
      merchantName: "Office Depot",
      status: opts.status ?? "unreviewed",
      receiptStorageId: storageId,
      createdAt: Date.now(),
    });
  });
}

async function storeBlobWithContent(
  s: ChapterSetup,
  content: string,
): Promise<Id<"_storage">> {
  return await run(s.t, (ctx) =>
    (ctx.storage as unknown as {
      store: (b: Blob) => Promise<Id<"_storage">>;
    }).store(new Blob([content], { type: "image/png" })),
  );
}

async function newUploadReceipt(
  s: ChapterSetup,
  opts: { amountCents?: number; receiptDate?: number } = {},
): Promise<Id<"receipts">> {
  const storageId = await storeBlobWithContent(s, `receipt-${Math.random()}`);
  return await run(s.t, (ctx) =>
    createReceipt(ctx, {
      chapterId: s.chapterId,
      storageId,
      source: "upload",
      ocrAmountCents: opts.amountCents,
      ocrDate: opts.receiptDate,
    }),
  );
}

async function scheduledJobs(
  s: ChapterSetup,
): Promise<{ name: string; args: unknown }[]> {
  const rows = await run(s.t, (ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  return rows.map((r) => ({ name: r.name, args: r.args[0] }));
}

// ── Role gates ───────────────────────────────────────────────────────────────
describe("role gates", () => {
  test("listReceipts / getReceipt / linkReceipt / submitUploadedReceipts all need bookkeeper+", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // No `financeRoles` grant at all → role null, below bookkeeper.
    const txn = await seedTxn(s);
    const receiptId = await newUploadReceipt(s);

    await expect(s.as.query(api.receipts.getReceipt, { receiptId })).rejects.toThrow(
      ConvexError,
    );
    await expect(
      s.as.mutation(api.receipts.linkReceipt, { receiptId, transactionId: txn }),
    ).rejects.toThrow(ConvexError);
    // The role gate runs BEFORE the empty-batch short-circuit, so even a
    // no-op call still requires bookkeeper+.
    await expect(
      s.as.mutation(api.receipts.submitUploadedReceipts, { storageIds: [] }),
    ).rejects.toThrow(ConvexError);
  });

  test("a plain viewer grant is still below bookkeeper for a write", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const person = await seedPerson(s);
    await grantRole(s, person, "viewer");
    const txn = await seedTxn(s);
    const receiptId = await newUploadReceipt(s);

    // Reads gated at bookkeeper+ also reject a viewer.
    await expect(s.as.query(api.receipts.listReceipts, {})).rejects.toThrow(ConvexError);
    await expect(
      s.as.mutation(api.receipts.linkReceipt, { receiptId, transactionId: txn }),
    ).rejects.toThrow(ConvexError);
  });

  test("a bookkeeper grant passes every gate", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);

    await expect(s.as.query(api.receipts.listReceipts, {})).resolves.toEqual([]);
    await expect(
      s.as.mutation(api.receipts.submitUploadedReceipts, { storageIds: [] }),
    ).resolves.toEqual([]);
  });
});

// ── listReceipts filters ─────────────────────────────────────────────────────
describe("listReceipts", () => {
  test("unlinked/linked/all filters partition correctly, newest first", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);

    const unlinked = await newUploadReceipt(s);
    const linked = await newUploadReceipt(s);
    const txn = await seedTxn(s);
    await run(t, (ctx) =>
      linkReceiptToTransaction(ctx, { receiptId: linked, transactionId: txn, source: "manual" }),
    );

    const all = await s.as.query(api.receipts.listReceipts, { filter: "all" });
    expect(all.map((r) => r._id).sort()).toEqual([unlinked, linked].sort());

    const unlinkedRows = await s.as.query(api.receipts.listReceipts, { filter: "unlinked" });
    expect(unlinkedRows.map((r) => r._id)).toEqual([unlinked]);
    expect(unlinkedRows[0].linkCount).toBe(0);
    expect(unlinkedRows[0].url).not.toBeNull();

    const linkedRows = await s.as.query(api.receipts.listReceipts, { filter: "linked" });
    expect(linkedRows.map((r) => r._id)).toEqual([linked]);
    expect(linkedRows[0].linkCount).toBe(1);
  });

  test("is chapter-scoped: another chapter's receipts never appear", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "a@publicworship.life", chapterName: "NY" });
    const other = await setupChapter(t, { email: "b@publicworship.life", chapterName: "LA" });
    await seedBookkeeper(s);
    await seedBookkeeper(other);
    await newUploadReceipt(other);

    const rows = await s.as.query(api.receipts.listReceipts, {});
    expect(rows).toEqual([]);
  });
});

// ── softDuplicate flag ───────────────────────────────────────────────────────
describe("softDuplicate", () => {
  test("two receipts sharing amount+date flag each other; a third with a different amount doesn't", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const day = Date.now();

    const a = await newUploadReceipt(s, { amountCents: 4210, receiptDate: day });
    const b = await newUploadReceipt(s, { amountCents: 4210, receiptDate: day });
    const c = await newUploadReceipt(s, { amountCents: 999, receiptDate: day });

    const rows = await s.as.query(api.receipts.listReceipts, {});
    const byId = new Map(rows.map((r) => [r._id, r]));
    expect(byId.get(a)?.softDuplicate).toBe(true);
    expect(byId.get(b)?.softDuplicate).toBe(true);
    expect(byId.get(c)?.softDuplicate).toBe(false);

    const detail = await s.as.query(api.receipts.getReceipt, { receiptId: a });
    expect(detail?.softDuplicate).toBe(true);
  });
});

// ── updateReceiptFields ──────────────────────────────────────────────────────
describe("updateReceiptFields", () => {
  test("edits canonical fields, leaves ocr* untouched, and stamps the corrector", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const bookkeeper = await seedBookkeeper(s);
    const receiptId = await newUploadReceipt(s, { amountCents: 4210, receiptDate: Date.now() });
    // Seed an OCR provenance value distinct from what we'll correct to.
    await run(t, (ctx) =>
      ctx.db.patch(receiptId, { ocrAmountCents: 4210, ocrMerchant: "Home Depot" }),
    );

    await s.as.mutation(api.receipts.updateReceiptFields, {
      receiptId,
      amountCents: 5000,
      merchant: "Costco",
      note: "Split with the youth budget",
    });

    const row = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(row?.amountCents).toBe(5000);
    expect(row?.merchant).toBe("Costco");
    expect(row?.note).toBe("Split with the youth budget");
    // OCR provenance is immutable — untouched by the correction.
    expect(row?.ocrAmountCents).toBe(4210);
    expect(row?.ocrMerchant).toBe("Home Depot");
    expect(row?.correctedByPersonId).toBe(bookkeeper);
    expect(row?.correctedAt).toBeDefined();
  });

  test("null clears a field; a non-positive amount is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const receiptId = await newUploadReceipt(s, { amountCents: 4210 });

    await s.as.mutation(api.receipts.updateReceiptFields, { receiptId, merchant: null });
    let row = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(row?.merchant).toBeUndefined();

    await expect(
      s.as.mutation(api.receipts.updateReceiptFields, { receiptId, amountCents: 0 }),
    ).rejects.toThrow(ConvexError);
    await expect(
      s.as.mutation(api.receipts.updateReceiptFields, { receiptId, amountCents: -100 }),
    ).rejects.toThrow(ConvexError);
    row = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(row?.amountCents).toBe(4210); // unchanged by the rejected calls
  });
});

// ── linkReceipt / unlinkReceipt (public mutations) ───────────────────────────
describe("linkReceipt / unlinkReceipt", () => {
  test("linking through the public mutation updates the denorm cache + linkCount", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const txn = await seedTxn(s, { status: "categorized" });
    const receiptId = await newUploadReceipt(s);
    const receiptDoc = await run(t, (ctx) => ctx.db.get(receiptId));

    const res = await s.as.mutation(api.receipts.linkReceipt, {
      receiptId,
      transactionId: txn,
    });
    expect(res).toEqual({ linked: true, reconciled: true });

    const txnRow = await run(t, (ctx) => ctx.db.get(txn));
    expect(txnRow?.receiptStorageId).toBe(receiptDoc?.storageId);
    expect(txnRow?.status).toBe("reconciled");
    const receiptRow = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(receiptRow?.linkCount).toBe(1);

    const links = await run(t, (ctx) => ctx.db.query("receiptLinks").collect());
    expect(links).toHaveLength(1);
    expect(links[0].source).toBe("manual");

    // Unlinking clears the cache back off the txn and never touches status.
    const unlinkRes = await s.as.mutation(api.receipts.unlinkReceipt, {
      receiptId,
      transactionId: txn,
    });
    expect(unlinkRes).toEqual({ unlinked: true });
    const txnAfter = await run(t, (ctx) => ctx.db.get(txn));
    expect(txnAfter?.receiptStorageId).toBeUndefined();
    expect(txnAfter?.status).toBe("reconciled"); // unlink never re-decides status
  });

  test("rejects a receipt or transaction outside the caller's chapter", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "a@publicworship.life", chapterName: "NY" });
    const other = await setupChapter(t, { email: "b@publicworship.life", chapterName: "LA" });
    await seedBookkeeper(s);
    const otherTxn = await seedTxn(other);
    const receiptId = await newUploadReceipt(s);

    await expect(
      s.as.mutation(api.receipts.linkReceipt, { receiptId, transactionId: otherTxn }),
    ).rejects.toThrow(ConvexError);
  });
});

// ── submitUploadedReceipts: exact-dupe short-circuit ─────────────────────────
describe("submitUploadedReceipts", () => {
  test("rejects a batch over the cap", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const storageIds = await Promise.all(
      Array.from({ length: 26 }, (_, i) => storeBlobWithContent(s, `f${i}`)),
    );
    await expect(
      s.as.mutation(api.receipts.submitUploadedReceipts, { storageIds }),
    ).rejects.toThrow(ConvexError);
  });

  test("two uploads of the IDENTICAL bytes: the second is flagged a duplicate and never scheduled for processing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const bytes = "the exact same receipt photo bytes";
    const idA = await storeBlobWithContent(s, bytes);
    const idB = await storeBlobWithContent(s, bytes); // same content → same sha256, different storageId
    const idC = await storeBlobWithContent(s, "totally different bytes");

    const results = await s.as.mutation(api.receipts.submitUploadedReceipts, {
      storageIds: [idA, idB, idC],
    });
    expect(results).toHaveLength(3);
    expect(results[0].duplicate).toBe(false);
    expect(results[1].duplicate).toBe(true);
    expect(results[2].duplicate).toBe(false);

    const dupRow = await run(t, (ctx) => ctx.db.get(results[1].receiptId));
    expect(dupRow?.duplicateOfReceiptId).toBe(results[0].receiptId);
    expect(dupRow?.fileSha256).toBeDefined();
    const firstRow = await run(t, (ctx) => ctx.db.get(results[0].receiptId));
    expect(firstRow?.fileSha256).toBe(dupRow?.fileSha256);

    // Only the non-duplicate rows (A, C) were scheduled for OCR/matching.
    const jobs = (await scheduledJobs(s)).filter((j) =>
      j.name.includes("processUploadedReceipt"),
    );
    expect(jobs).toHaveLength(2);
  });
});

// ── processUploadedReceipt: keyless path ─────────────────────────────────────
describe("processUploadedReceipt (no OPENROUTER key)", () => {
  test("skips OCR, leaves the receipt unlinked with no candidates, and never crashes", async () => {
    const savedKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      await seedBookkeeper(s);
      await seedTxn(s, { amountCents: 4210, status: "categorized" });
      const storageId = await storeBlobWithContent(s, "a photographed receipt");

      const results = await s.as.mutation(api.receipts.submitUploadedReceipts, {
        storageIds: [storageId],
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const row = await run(t, (ctx) => ctx.db.get(results[0].receiptId));
      expect(row?.ocrAmountCents).toBeUndefined();
      expect(row?.amountCents).toBeUndefined();
      expect(row?.candidateTransactionIds ?? []).toEqual([]);
      expect(row?.linkCount).toBe(0);
    } finally {
      vi.useRealTimers();
      if (savedKey !== undefined) process.env.OPENROUTER_API_KEY = savedKey;
    }
  });
});

// ── applyUploadOcrAndAttach: the matching/attach policy ──────────────────────
describe("applyUploadOcrAndAttach", () => {
  test("a unique untouched candidate auto-attaches and reconciles a categorized charge", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const postedAt = Date.now();
    const txn = await seedTxn(s, { amountCents: 4210, postedAt, status: "categorized" });
    const storageId = await storeBlobWithContent(s, "x");
    const receiptId = await run(t, (ctx) =>
      createReceipt(ctx, { chapterId: s.chapterId, storageId, source: "upload" }),
    );

    await t.mutation(internal.receipts.applyUploadOcrAndAttach, {
      receiptId,
      ocrAmountCents: 4210,
      ocrDate: postedAt,
      ocrMerchant: "Office Depot",
      candidateTransactionIds: [txn],
    });

    const row = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(row?.candidateTransactionIds).toEqual([txn]);
    expect(row?.linkCount).toBe(1);
    expect(row?.amountCents).toBe(4210); // canonical seeded from the OCR read
    const txnRow = await run(t, (ctx) => ctx.db.get(txn));
    expect(txnRow?.status).toBe("reconciled");
    const links = await run(t, (ctx) => ctx.db.query("receiptLinks").collect());
    expect(links).toHaveLength(1);
    expect(links[0].source).toBe("upload");
  });

  test("a unique candidate that ALREADY has a receipt is NOT auto-attached — flagged for review instead", async () => {
    // Simulates the real race: `runUploadPipeline` computed this candidate
    // list in a QUERY (its own transaction) before another receipt from the
    // same batch attached to the SAME transaction in a separate, earlier
    // mutation — so by the time this write lands, the candidate is stale.
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const postedAt = Date.now();
    const txn = await seedTxn(s, { amountCents: 4210, postedAt, status: "categorized" });
    // Land an EARLIER receipt on this same txn first.
    const earlier = await newUploadReceipt(s);
    await run(t, (ctx) =>
      linkReceiptToTransaction(ctx, { receiptId: earlier, transactionId: txn, source: "manual" }),
    );

    const storageId = await storeBlobWithContent(s, "y");
    const receiptId = await run(t, (ctx) =>
      createReceipt(ctx, { chapterId: s.chapterId, storageId, source: "upload" }),
    );
    await t.mutation(internal.receipts.applyUploadOcrAndAttach, {
      receiptId,
      ocrAmountCents: 4210,
      ocrDate: postedAt,
      candidateTransactionIds: [txn], // stale — txn is already receipted
    });

    const row = await run(t, (ctx) => ctx.db.get(receiptId));
    // Candidate is stored so the review UI can show it...
    expect(row?.candidateTransactionIds).toEqual([txn]);
    // ...but NEVER auto-attached (a likely duplicate submission).
    expect(row?.linkCount).toBe(0);
    expect(row?.note).toContain("already has a receipt");
    const links = await run(t, (ctx) =>
      ctx.db.query("receiptLinks").withIndex("by_receipt", (q) => q.eq("receiptId", receiptId)).collect(),
    );
    expect(links).toHaveLength(0);
  });
});
