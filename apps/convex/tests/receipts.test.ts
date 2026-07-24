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

  // FIX 3: "possible duplicate" is actionable — getReceipt surfaces exactly
  // WHY a receipt is flagged (the other receipt(s) it collides with).
  test("getReceipt surfaces the other colliding receipt(s) as duplicateMatches", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const day = Date.now();

    const a = await newUploadReceipt(s, { amountCents: 4210, receiptDate: day });
    const b = await newUploadReceipt(s, { amountCents: 4210, receiptDate: day });
    const c = await newUploadReceipt(s, { amountCents: 999, receiptDate: day });

    const detailA = await s.as.query(api.receipts.getReceipt, { receiptId: a });
    expect(detailA?.softDuplicate).toBe(true);
    expect(detailA?.duplicateMatches.map((m) => m._id)).toEqual([b]);

    // A receipt with no collision gets an empty list, not a stale one.
    const detailC = await s.as.query(api.receipts.getReceipt, { receiptId: c });
    expect(detailC?.softDuplicate).toBe(false);
    expect(detailC?.duplicateMatches).toEqual([]);
  });

  test("duplicateMatches excludes the receipt's own exact-file (sha256) group", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const day = Date.now();

    // Two receipts from the SAME uploaded bytes (an exact-file dupe) that
    // ALSO happen to share amount+date with a third, genuinely different
    // receipt — the exact-file sibling should never show up in
    // `duplicateMatches` (it already has its own `duplicateOf` callout).
    const storageId = await storeBlobWithContent(s, "same-bytes");
    const original = await run(s.t, (ctx) =>
      createReceipt(ctx, {
        chapterId: s.chapterId,
        storageId,
        source: "upload",
        ocrAmountCents: 4210,
        ocrDate: day,
        fileSha256: "same-hash",
      }),
    );
    const exactDupe = await run(s.t, (ctx) =>
      createReceipt(ctx, {
        chapterId: s.chapterId,
        storageId,
        source: "upload",
        ocrAmountCents: 4210,
        ocrDate: day,
        fileSha256: "same-hash",
        duplicateOfReceiptId: original,
      }),
    );
    const different = await newUploadReceipt(s, { amountCents: 4210, receiptDate: day });

    const detail = await s.as.query(api.receipts.getReceipt, { receiptId: original });
    const matchIds = detail?.duplicateMatches.map((m) => m._id) ?? [];
    expect(matchIds).toContain(different);
    expect(matchIds).not.toContain(exactDupe);
  });
});

// ── dismissDuplicateFlag ──────────────────────────────────────────────────────
describe("dismissDuplicateFlag", () => {
  test("flips softDuplicate off for THIS receipt only — an undismissed sibling keeps flagging", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const day = Date.now();

    const a = await newUploadReceipt(s, { amountCents: 4210, receiptDate: day });
    const b = await newUploadReceipt(s, { amountCents: 4210, receiptDate: day });

    await s.as.mutation(api.receipts.dismissDuplicateFlag, { receiptId: a });

    const rows = await s.as.query(api.receipts.listReceipts, {});
    const byId = new Map(rows.map((r) => [r._id, r]));
    expect(byId.get(a)?.softDuplicate).toBe(false);
    // b never dismissed its own flag — still flagged (dismissal isn't a
    // group-wide mute).
    expect(byId.get(b)?.softDuplicate).toBe(true);

    const detailA = await s.as.query(api.receipts.getReceipt, { receiptId: a });
    expect(detailA?.softDuplicate).toBe(false);

    const row = await run(t, (ctx) => ctx.db.get(a));
    expect(row?.duplicateDismissed).toBe(true);
  });

  test("requires bookkeeper+ and chapter ownership", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const other = await setupChapter(t, { email: "other@publicworship.life", chapterName: "LA" });
    await seedBookkeeper(other);
    const receiptId = await newUploadReceipt(s, { amountCents: 4210, receiptDate: Date.now() });

    // No bookkeeper grant in `s` at all → role gate rejects.
    await expect(
      s.as.mutation(api.receipts.dismissDuplicateFlag, { receiptId }),
    ).rejects.toThrow(ConvexError);

    // A bookkeeper in a DIFFERENT chapter can't touch this receipt.
    await expect(
      other.as.mutation(api.receipts.dismissDuplicateFlag, { receiptId }),
    ).rejects.toThrow(ConvexError);
  });
});

// ── markAsDuplicate / unmarkDuplicate + hide-by-default ──────────────────────
// Owner ask (2026-07-24): "when something is confirmed duplicate I cannot
// merge it — we shouldn't delete the duplicate, just mark it as such, point
// to the primary receipt, and hide it in the UI."
describe("markAsDuplicate", () => {
  test("sets the pointer + confirmation stamps, and hides the receipt from the default listReceipts filters", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const bookkeeper = await seedBookkeeper(s);
    const primary = await newUploadReceipt(s, { amountCents: 5000 });
    const dupe = await newUploadReceipt(s, { amountCents: 6000 }); // different amount — not a soft dupe

    await s.as.mutation(api.receipts.markAsDuplicate, {
      receiptId: dupe,
      primaryReceiptId: primary,
    });

    const row = await run(t, (ctx) => ctx.db.get(dupe));
    expect(row?.duplicateOfReceiptId).toBe(primary);
    expect(row?.duplicateConfirmedByPersonId).toBe(bookkeeper);
    expect(row?.duplicateConfirmedAt).toBeDefined();

    // Nothing is DELETED — the row still exists and is readable directly.
    expect(row).not.toBeNull();

    // Hidden from "all"/"unlinked"/"linked" by default...
    const all = await s.as.query(api.receipts.listReceipts, { filter: "all" });
    expect(all.map((r) => r._id)).not.toContain(dupe);
    expect(all.map((r) => r._id)).toContain(primary);
    const unlinked = await s.as.query(api.receipts.listReceipts, { filter: "unlinked" });
    expect(unlinked.map((r) => r._id)).not.toContain(dupe);

    // ...but still reachable via the "duplicates" filter.
    const dupFilter = await s.as.query(api.receipts.listReceipts, { filter: "duplicates" });
    expect(dupFilter.map((r) => r._id)).toEqual([dupe]);
  });

  // BUG 2 REPRO (owner ask 2026-07-24 — "This is a duplicate does nothing"):
  // the real-world case is two receipts that DO share amount+date (the soft-
  // duplicate signal that surfaces the "This is a duplicate" button in the
  // UI's `duplicateMatches` list in the first place) — not two receipts with
  // deliberately different amounts. Confirms the backend end-to-end for the
  // EXACT repro shape before looking at the UI.
  test("same-amount+date receipts: marking one a duplicate excludes it from 'all', includes it in 'duplicates'", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const day = Date.now();

    const a = await newUploadReceipt(s, { amountCents: 4210, receiptDate: day });
    const b = await newUploadReceipt(s, { amountCents: 4210, receiptDate: day });

    await s.as.mutation(api.receipts.markAsDuplicate, {
      receiptId: a,
      primaryReceiptId: b,
    });

    const row = await run(t, (ctx) => ctx.db.get(a));
    expect(row?.duplicateOfReceiptId).toBe(b);

    const all = await s.as.query(api.receipts.listReceipts, { filter: "all" });
    expect(all.map((r) => r._id)).not.toContain(a);
    expect(all.map((r) => r._id)).toContain(b);

    const dupFilter = await s.as.query(api.receipts.listReceipts, { filter: "duplicates" });
    expect(dupFilter.map((r) => r._id)).toContain(a);
  });

  test("getReceipt on the primary surfaces its confirmed duplicate", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const primary = await newUploadReceipt(s, { amountCents: 5000 });
    const dupe = await newUploadReceipt(s, { amountCents: 6000 });

    await s.as.mutation(api.receipts.markAsDuplicate, {
      receiptId: dupe,
      primaryReceiptId: primary,
    });

    const detail = await s.as.query(api.receipts.getReceipt, { receiptId: primary });
    expect(detail?.duplicates.map((d) => d._id)).toEqual([dupe]);

    const dupeDetail = await s.as.query(api.receipts.getReceipt, { receiptId: dupe });
    expect(dupeDetail?.duplicateOf?._id).toBe(primary);
    expect(dupeDetail?.duplicateConfirmedByPersonId).toBeDefined();
  });

  test("existing receiptLinks on the confirmed duplicate are left alone (never silently unlinked)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const primary = await newUploadReceipt(s, { amountCents: 5000 });
    const dupe = await newUploadReceipt(s, { amountCents: 6000 });
    const txn = await seedTxn(s, { amountCents: 6000 });
    await run(t, (ctx) =>
      linkReceiptToTransaction(ctx, { receiptId: dupe, transactionId: txn, source: "manual" }),
    );

    await s.as.mutation(api.receipts.markAsDuplicate, {
      receiptId: dupe,
      primaryReceiptId: primary,
    });

    const links = await run(t, (ctx) =>
      ctx.db.query("receiptLinks").withIndex("by_receipt", (q) => q.eq("receiptId", dupe)).collect(),
    );
    expect(links).toHaveLength(1);
    const row = await run(t, (ctx) => ctx.db.get(dupe));
    expect(row?.linkCount).toBe(1);
  });

  test("rejects marking a receipt a duplicate of itself", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const receiptId = await newUploadReceipt(s);

    await expect(
      s.as.mutation(api.receipts.markAsDuplicate, {
        receiptId,
        primaryReceiptId: receiptId,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("gates below bookkeeper+ and rejects a receipt outside the caller's chapter", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "a@publicworship.life", chapterName: "NY" });
    const other = await setupChapter(t, { email: "b@publicworship.life", chapterName: "LA" });
    await seedBookkeeper(other);
    const primary = await newUploadReceipt(s);
    const dupe = await newUploadReceipt(s);

    // No bookkeeper grant in `s` → role gate rejects.
    await expect(
      s.as.mutation(api.receipts.markAsDuplicate, { receiptId: dupe, primaryReceiptId: primary }),
    ).rejects.toThrow(ConvexError);

    // A bookkeeper in a DIFFERENT chapter can't touch either receipt.
    await expect(
      other.as.mutation(api.receipts.markAsDuplicate, { receiptId: dupe, primaryReceiptId: primary }),
    ).rejects.toThrow(ConvexError);
  });
});

describe("unmarkDuplicate", () => {
  test("clears a HUMAN-confirmed duplicate pointer", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const primary = await newUploadReceipt(s, { amountCents: 5000 });
    const dupe = await newUploadReceipt(s, { amountCents: 6000 });
    await s.as.mutation(api.receipts.markAsDuplicate, {
      receiptId: dupe,
      primaryReceiptId: primary,
    });

    await s.as.mutation(api.receipts.unmarkDuplicate, { receiptId: dupe });

    const row = await run(t, (ctx) => ctx.db.get(dupe));
    expect(row?.duplicateOfReceiptId).toBeUndefined();
    expect(row?.duplicateConfirmedByPersonId).toBeUndefined();
    expect(row?.duplicateConfirmedAt).toBeUndefined();

    // Back in the default "all" listing.
    const all = await s.as.query(api.receipts.listReceipts, { filter: "all" });
    expect(all.map((r) => r._id)).toContain(dupe);
  });

  test("refuses to clear a DERIVED (sha256 exact-file) duplicate — that's not a human assertion to retract", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const storageId = await storeBlobWithContent(s, "same-bytes-again");
    const original = await run(s.t, (ctx) =>
      createReceipt(ctx, {
        chapterId: s.chapterId,
        storageId,
        source: "upload",
        fileSha256: "hash-x",
      }),
    );
    const exactDupe = await run(s.t, (ctx) =>
      createReceipt(ctx, {
        chapterId: s.chapterId,
        storageId,
        source: "upload",
        fileSha256: "hash-x",
        duplicateOfReceiptId: original,
      }),
    );

    await expect(
      s.as.mutation(api.receipts.unmarkDuplicate, { receiptId: exactDupe }),
    ).rejects.toThrow(ConvexError);

    // Still flagged — refused, not silently no-op'd.
    const row = await run(t, (ctx) => ctx.db.get(exactDupe));
    expect(row?.duplicateOfReceiptId).toBe(original);
  });

  test("is a no-op on a receipt that isn't flagged a duplicate at all", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const receiptId = await newUploadReceipt(s);

    await expect(
      s.as.mutation(api.receipts.unmarkDuplicate, { receiptId }),
    ).resolves.toBeNull();
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

  // RECEIPT QUALITY PR (per-field retry fix): `applyUploadOcrAndAttach`
  // shares the SAME per-field seeding rule as `applyRetryExtraction` — a
  // still-blank canonical field fills in from the fresh OCR read regardless
  // of `correctedAt`; a field that already holds a value is preserved.
  test("fills only the BLANK canonical fields on a receipt that already has correctedAt set", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const bookkeeper = await seedBookkeeper(s);
    const storageId = await storeBlobWithContent(s, "z");
    const receiptId = await run(t, (ctx) =>
      createReceipt(ctx, { chapterId: s.chapterId, storageId, source: "upload" }),
    );
    // A human corrected the MERCHANT only, stamping correctedAt — amount and
    // date are still blank.
    await run(t, (ctx) =>
      ctx.db.patch(receiptId, {
        merchant: "Costco",
        correctedByPersonId: bookkeeper,
        correctedAt: Date.now(),
      }),
    );

    await t.mutation(internal.receipts.applyUploadOcrAndAttach, {
      receiptId,
      ocrAmountCents: 1234,
      ocrDate: Date.now(),
      ocrMerchant: "Some Other Store",
      candidateTransactionIds: [],
    });

    const row = await run(t, (ctx) => ctx.db.get(receiptId));
    // Blank fields filled from the fresh read...
    expect(row?.amountCents).toBe(1234);
    expect(row?.receiptDate).toBeDefined();
    // ...but the human-corrected merchant is untouched, never overwritten by
    // the fresh OCR merchant read.
    expect(row?.merchant).toBe("Costco");
    // The immutable OCR provenance still refreshed regardless.
    expect(row?.ocrMerchant).toBe("Some Other Store");
  });
});
