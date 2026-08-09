import { describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  createReceipt,
  linkReceiptToTransaction,
  findDuplicateReceiptBySha256,
} from "../lib/receiptLinks";
import { transactionMatchesSearch } from "../receipts";
import { CENTRAL } from "@events-os/shared";

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
    merchantName?: string;
    flow?: "outflow" | "inflow" | "transfer";
    /** The cardholder this charge belongs to — what makes it "their own
     *  charge" for the suggestion gate (`lib/receiptSuggestionAccess.ts`). */
    personId?: Id<"people">;
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
      flow: opts.flow ?? "outflow",
      amountCents: opts.amountCents ?? 4210,
      postedAt: opts.postedAt ?? Date.now(),
      merchantName: opts.merchantName ?? "Office Depot",
      status: opts.status ?? "unreviewed",
      receiptStorageId: storageId,
      ...(opts.personId ? { personId: opts.personId } : {}),
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

  // REPLACES "is chapter-scoped: another chapter's receipts never appear"
  // (founder decision, 2026-07-24 — receipts are org-wide provenance-tagged
  // documents now; the old assertion pinned the behavior that made a
  // shared-inbox receipt unmatchable).
  test("is org-wide: another chapter's receipts DO appear, tagged with their origin", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "a@publicworship.life", chapterName: "NY" });
    const other = await setupChapter(t, { email: "b@publicworship.life", chapterName: "LA" });
    await seedBookkeeper(s);
    await seedBookkeeper(other);
    const theirs = await newUploadReceipt(other);

    const rows = await s.as.query(api.receipts.listReceipts, {});
    expect(rows.map((r) => r._id)).toEqual([theirs]);
    expect(rows[0].chapterName).toBe("LA");
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

  test("requires bookkeeper+, but no longer chapter ownership", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const other = await setupChapter(t, { email: "other@publicworship.life", chapterName: "LA" });
    await seedBookkeeper(other);
    const receiptId = await newUploadReceipt(s, { amountCents: 4210, receiptDate: Date.now() });

    // No bookkeeper grant in `s` at all → role gate still rejects.
    await expect(
      s.as.mutation(api.receipts.dismissDuplicateFlag, { receiptId }),
    ).rejects.toThrow(ConvexError);

    // A bookkeeper in a DIFFERENT chapter CAN act on it now: receipts are
    // org-wide, and the finance ROLE is the only remaining gate.
    await expect(
      other.as.mutation(api.receipts.dismissDuplicateFlag, { receiptId }),
    ).resolves.toBeNull();
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

    // THE ACTUAL BUG (founder, 2026-07-24): before the fix, `b` (the PRIMARY)
    // kept showing `softDuplicate: true` forever — `a` never stopped counting
    // toward the {a, b} collision group just because it got marked/archived.
    // Confirm the primary's flag actually clears, in both `listReceipts` and
    // `getReceipt` — the exact gap the earlier assertions above never covered.
    const byId = new Map(all.map((r) => [r._id, r]));
    expect(byId.get(b)?.softDuplicate).toBe(false);

    const primaryDetail = await s.as.query(api.receipts.getReceipt, { receiptId: b });
    expect(primaryDetail?.softDuplicate).toBe(false);
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

  test("gates below bookkeeper+, but a receipt's chapter no longer matters", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "a@publicworship.life", chapterName: "NY" });
    const other = await setupChapter(t, { email: "b@publicworship.life", chapterName: "LA" });
    await seedBookkeeper(other);
    const primary = await newUploadReceipt(s);
    const dupe = await newUploadReceipt(s);

    // No bookkeeper grant in `s` → role gate still rejects.
    await expect(
      s.as.mutation(api.receipts.markAsDuplicate, { receiptId: dupe, primaryReceiptId: primary }),
    ).rejects.toThrow(ConvexError);

    // A bookkeeper in a DIFFERENT chapter CAN resolve them: two copies of the
    // same document reaching the shared inbox from different chapters is
    // precisely the duplicate this flow exists to merge (founder decision,
    // 2026-07-24 — receipts are org-wide).
    await expect(
      other.as.mutation(api.receipts.markAsDuplicate, { receiptId: dupe, primaryReceiptId: primary }),
    ).resolves.not.toThrow();
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

    // markAsDuplicate archived it too — confirm before undoing.
    const archivedRow = await run(t, (ctx) => ctx.db.get(dupe));
    expect(archivedRow?.archived).toBe(true);

    await s.as.mutation(api.receipts.unmarkDuplicate, { receiptId: dupe });

    const row = await run(t, (ctx) => ctx.db.get(dupe));
    expect(row?.duplicateOfReceiptId).toBeUndefined();
    expect(row?.duplicateConfirmedByPersonId).toBeUndefined();
    expect(row?.duplicateConfirmedAt).toBeUndefined();
    // Same coherent undo clears the archive stamps it set alongside them.
    expect(row?.archived).toBeUndefined();
    expect(row?.archivedAt).toBeUndefined();
    expect(row?.archivedByPersonId).toBeUndefined();

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

// ── archiveReceipt / unarchiveReceipt (founder ask, 2026-07-24) ──────────────
// "when you have nonsense receipts and duplicates, I think we should just
// have a concept of archiving receipt entries, and the ability to
// unarchive." `markAsDuplicate`/`unmarkDuplicate` now drive the SAME fields
// (see those suites above for the combined behavior); this suite covers the
// standalone mutations and the reader exclusions they drive everywhere else
// in the file.
describe("archiveReceipt / unarchiveReceipt", () => {
  test("requires bookkeeper+", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const person = await seedPerson(s);
    await grantRole(s, person, "viewer");
    const receiptId = await newUploadReceipt(s);

    await expect(
      s.as.mutation(api.receipts.archiveReceipt, { receiptId }),
    ).rejects.toThrow(ConvexError);
    await expect(
      s.as.mutation(api.receipts.unarchiveReceipt, { receiptId }),
    ).rejects.toThrow(ConvexError);
  });

  test("sets archived fields, hides from all/unlinked/linked, surfaces in 'archived' — links survive untouched", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const bookkeeper = await seedBookkeeper(s);
    const receiptId = await newUploadReceipt(s, { amountCents: 500 });
    const txn = await seedTxn(s, { amountCents: 500 });
    await run(t, (ctx) =>
      linkReceiptToTransaction(ctx, { receiptId, transactionId: txn, source: "manual" }),
    );

    await s.as.mutation(api.receipts.archiveReceipt, { receiptId });

    const row = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(row?.archived).toBe(true);
    expect(row?.archivedAt).toBeDefined();
    expect(row?.archivedByPersonId).toBe(bookkeeper);
    // Never deleted, never unlinked — archiving is a visibility decision only.
    expect(row).not.toBeNull();
    expect(row?.linkCount).toBe(1);

    const all = await s.as.query(api.receipts.listReceipts, { filter: "all" });
    expect(all.map((r) => r._id)).not.toContain(receiptId);
    const linked = await s.as.query(api.receipts.listReceipts, { filter: "linked" });
    expect(linked.map((r) => r._id)).not.toContain(receiptId);
    const unlinked = await s.as.query(api.receipts.listReceipts, { filter: "unlinked" });
    expect(unlinked.map((r) => r._id)).not.toContain(receiptId);

    const archived = await s.as.query(api.receipts.listReceipts, { filter: "archived" });
    expect(archived.map((r) => r._id)).toEqual([receiptId]);
    expect(archived[0]?.archived).toBe(true);
  });

  test("unarchiveReceipt restores a hand-archived receipt to the default listing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const receiptId = await newUploadReceipt(s);
    await s.as.mutation(api.receipts.archiveReceipt, { receiptId });

    await s.as.mutation(api.receipts.unarchiveReceipt, { receiptId });

    const row = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(row?.archived).toBeUndefined();
    expect(row?.archivedAt).toBeUndefined();
    expect(row?.archivedByPersonId).toBeUndefined();

    const all = await s.as.query(api.receipts.listReceipts, { filter: "all" });
    expect(all.map((r) => r._id)).toContain(receiptId);
  });

  test("unarchiving a HUMAN-confirmed duplicate also clears the duplicate fields — one coherent undo", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const primary = await newUploadReceipt(s, { amountCents: 5000 });
    const dupe = await newUploadReceipt(s, { amountCents: 6000 });
    await s.as.mutation(api.receipts.markAsDuplicate, { receiptId: dupe, primaryReceiptId: primary });

    await s.as.mutation(api.receipts.unarchiveReceipt, { receiptId: dupe });

    const row = await run(t, (ctx) => ctx.db.get(dupe));
    expect(row?.archived).toBeUndefined();
    expect(row?.duplicateOfReceiptId).toBeUndefined();
    expect(row?.duplicateConfirmedByPersonId).toBeUndefined();
    expect(row?.duplicateConfirmedAt).toBeUndefined();
  });

  test("unarchiving a DERIVED (sha256) duplicate leaves that pointer alone — the bytes are still identical", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const storageId = await storeBlobWithContent(s, "same-bytes-archived");
    const original = await run(s.t, (ctx) =>
      createReceipt(ctx, { chapterId: s.chapterId, storageId, source: "upload", fileSha256: "hash-y" }),
    );
    const exactDupe = await run(s.t, (ctx) =>
      createReceipt(ctx, {
        chapterId: s.chapterId,
        storageId,
        source: "upload",
        fileSha256: "hash-y",
        duplicateOfReceiptId: original,
      }),
    );
    await s.as.mutation(api.receipts.archiveReceipt, { receiptId: exactDupe });

    await s.as.mutation(api.receipts.unarchiveReceipt, { receiptId: exactDupe });

    const row = await run(t, (ctx) => ctx.db.get(exactDupe));
    expect(row?.archived).toBeUndefined();
    expect(row?.duplicateOfReceiptId).toBe(original);
  });

  // THE FOUNDER'S CORE COMPLAINT: "when you mark something as duplicate the
  // original still shows the duplicate warning." markAsDuplicate now archives
  // the duplicate, and `computeSoftDuplicates` drops archived rows before
  // grouping — so the primary stops colliding with it entirely.
  test("markAsDuplicate archives the duplicate; the primary's softDuplicate flag clears", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const day = Date.now();
    const a = await newUploadReceipt(s, { amountCents: 4210, receiptDate: day });
    const b = await newUploadReceipt(s, { amountCents: 4210, receiptDate: day });

    // Before marking: both collide, both flagged.
    const before = await s.as.query(api.receipts.listReceipts, { filter: "all" });
    const beforeById = new Map(before.map((r) => [r._id, r]));
    expect(beforeById.get(a)?.softDuplicate).toBe(true);
    expect(beforeById.get(b)?.softDuplicate).toBe(true);

    await s.as.mutation(api.receipts.markAsDuplicate, { receiptId: a, primaryReceiptId: b });

    const row = await run(t, (ctx) => ctx.db.get(a));
    expect(row?.archived).toBe(true);

    const after = await s.as.query(api.receipts.listReceipts, { filter: "all" });
    const afterById = new Map(after.map((r) => [r._id, r]));
    expect(afterById.get(b)?.softDuplicate).toBe(false);

    const primaryDetail = await s.as.query(api.receipts.getReceipt, { receiptId: b });
    expect(primaryDetail?.softDuplicate).toBe(false);
  });

  test("a plain hand-archive (no duplicate confirmation) of one colliding receipt also clears the other's softDuplicate flag and duplicateMatches", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const day = Date.now();
    const a = await newUploadReceipt(s, { amountCents: 777, receiptDate: day });
    const b = await newUploadReceipt(s, { amountCents: 777, receiptDate: day });

    await s.as.mutation(api.receipts.archiveReceipt, { receiptId: a });

    const detailB = await s.as.query(api.receipts.getReceipt, { receiptId: b });
    expect(detailB?.softDuplicate).toBe(false);
    expect(detailB?.duplicateMatches).toEqual([]);
  });

  test("excludes archived receipts from listInboundQueue's per-email receipts[] — drops the row when that was the only one", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const inboundReceiptId = await run(t, (ctx) =>
      ctx.db.insert("inboundReceipts", {
        emailId: `e_${Math.random()}`,
        status: "needs_review",
        fromEmail: "sender@x.com",
        chapterId: s.chapterId,
        receivedAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const storageId = await storeBlobWithContent(s, `email-${Math.random()}`);
    const receiptId = await run(t, (ctx) =>
      createReceipt(ctx, {
        chapterId: s.chapterId,
        storageId,
        source: "email",
        inboundReceiptId,
        ocrAmountCents: 1200,
      }),
    );

    await s.as.mutation(api.receipts.archiveReceipt, { receiptId });

    const queue = await s.as.query(api.receipts.listInboundQueue, {});
    expect(queue.map((r) => r._id)).not.toContain(inboundReceiptId);
  });

  test("excludes archived receipts from findNextFailedReceipt and failedExtractionStatus's count", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const storageId = await storeBlobWithContent(s, "failed-and-archived");
    const receiptId = await run(t, (ctx) =>
      createReceipt(ctx, {
        chapterId: s.chapterId,
        storageId,
        source: "upload",
        ocrError: "no text found",
      }),
    );

    const before = await t.query(internal.receipts.findNextFailedReceipt, {
      chapterId: s.chapterId,
    });
    expect(before?._id).toBe(receiptId);
    const statusBefore = await s.as.query(api.receipts.failedExtractionStatus, {});
    expect(statusBefore.failedCount).toBe(1);

    await s.as.mutation(api.receipts.archiveReceipt, { receiptId });

    const after = await t.query(internal.receipts.findNextFailedReceipt, {
      chapterId: s.chapterId,
    });
    expect(after).toBeNull();
    const statusAfter = await s.as.query(api.receipts.failedExtractionStatus, {});
    expect(statusAfter.failedCount).toBe(0);
  });

  // findDuplicateReceiptBySha256 must NOT exclude archived rows — a re-upload
  // of an archived file's exact bytes is still a real duplicate submission.
  test("sha256 re-upload of an archived file's bytes still gets caught as a duplicate", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const storageId = await storeBlobWithContent(s, "archived-bytes");
    const original = await run(s.t, (ctx) =>
      createReceipt(ctx, {
        chapterId: s.chapterId,
        storageId,
        source: "upload",
        fileSha256: "hash-archived",
      }),
    );
    await s.as.mutation(api.receipts.archiveReceipt, { receiptId: original });

    const hit = await run(t, (ctx) =>
      findDuplicateReceiptBySha256(ctx, s.chapterId, "hash-archived"),
    );
    expect(hit).toBe(original);
  });
});

// ── getReceipt: duplicateStillLinked (BUG FIX) ────────────────────────────────
// `markAsDuplicate` deliberately never touches existing `receiptLinks` — money
// records don't change silently. That means a confirmed duplicate CAN end up
// still attached to a transaction, with nothing surfacing that loose end. The
// fix: `getReceipt` now flags it explicitly so the UI can warn + offer an
// unlink affordance instead of the money-adjacent state staying invisible.
describe("getReceipt — duplicateStillLinked", () => {
  test("flags a confirmed duplicate that still carries a receiptLink", async () => {
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

    const detail = await s.as.query(api.receipts.getReceipt, { receiptId: dupe });
    expect(detail?.duplicateStillLinked).toBe(true);
    expect(detail?.linkCount).toBe(1);
  });

  test("is false for a confirmed duplicate with no links, and for a non-duplicate receipt", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const primary = await newUploadReceipt(s, { amountCents: 5000 });
    const dupe = await newUploadReceipt(s, { amountCents: 6000 });

    await s.as.mutation(api.receipts.markAsDuplicate, {
      receiptId: dupe,
      primaryReceiptId: primary,
    });

    const dupeDetail = await s.as.query(api.receipts.getReceipt, { receiptId: dupe });
    expect(dupeDetail?.duplicateStillLinked).toBe(false);

    const primaryDetail = await s.as.query(api.receipts.getReceipt, { receiptId: primary });
    expect(primaryDetail?.duplicateStillLinked).toBe(false);
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

  // Founder feedback (2026-07-24): while viewing the Reconcile grid's Central
  // toggle, the "attach existing receipt" picker couldn't find (or link) a
  // receipt sitting right there in the CENTRAL-owned bucket — `listReceipts`/
  // `linkReceipt` were hard-scoped to the caller's own chapter regardless of
  // what the page was viewing. These pin the fix: central reach can link a
  // CENTRAL txn to a CENTRAL receipt, and a caller WITHOUT central reach
  // can't reach a central txn just because it's also their home chapter.
  test("central reach links a CENTRAL-owned receipt to a CENTRAL-owned transaction", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const person = await seedPerson(s);
    await grantRole(s, person, "bookkeeper");
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId: person,
        role: "bookkeeper",
        scope: "central",
        createdAt: Date.now(),
      }),
    );
    const centralTxn = await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: CENTRAL,
        source: "manual",
        flow: "outflow",
        amountCents: 5000,
        postedAt: Date.now(),
        merchantName: "Central Vendor",
        status: "categorized",
        createdAt: Date.now(),
      }),
    );
    const storageId = await storeBlobWithContent(s, `central-receipt-${Math.random()}`);
    const centralReceiptId = await run(s.t, (ctx) =>
      createReceipt(ctx, { chapterId: CENTRAL, storageId, source: "upload" }),
    );

    const res = await s.as.mutation(api.receipts.linkReceipt, {
      receiptId: centralReceiptId,
      transactionId: centralTxn,
    });
    expect(res).toEqual({ linked: true, reconciled: true });
  });

  test("a chapter-only bookkeeper (no central reach) can't link a CENTRAL-owned transaction", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s); // chapter-scoped grant only — no central reach
    const centralTxn = await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: CENTRAL,
        source: "manual",
        flow: "outflow",
        amountCents: 5000,
        postedAt: Date.now(),
        merchantName: "Central Vendor",
        status: "categorized",
        createdAt: Date.now(),
      }),
    );
    const receiptId = await newUploadReceipt(s); // chapter-scoped receipt

    await expect(
      s.as.mutation(api.receipts.linkReceipt, { receiptId, transactionId: centralTxn }),
    ).rejects.toThrow(ConvexError);
  });
});

// ── Receipts are ORG-WIDE (founder decision, 2026-07-24) ─────────────────────
/** Seed a receipt with NO chapter at all — the unknown-sender email case that
 *  used to be invisible to every chapter-scoped read in the system. */
async function newChapterlessReceipt(s: ChapterSetup): Promise<Id<"receipts">> {
  const storageId = await storeBlobWithContent(s, `chapterless-${Math.random()}`);
  return await run(s.t, (ctx) => createReceipt(ctx, { storageId, source: "upload" }));
}

describe("listReceipts is org-wide", () => {
  test("a chapter bookkeeper sees other chapters' receipts AND chapterless ones", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "a@publicworship.life", chapterName: "NY" });
    const other = await setupChapter(t, { email: "b@publicworship.life", chapterName: "Boston" });
    await seedBookkeeper(s);

    const mine = await newUploadReceipt(s);
    const theirs = await newUploadReceipt(other);
    const chapterless = await newChapterlessReceipt(s);

    const rows = await s.as.query(api.receipts.listReceipts, {});
    const ids = rows.map((r) => r._id);
    // The whole point of de-scoping: nothing is hidden from anyone.
    expect(ids).toContain(mine);
    expect(ids).toContain(theirs);
    expect(ids).toContain(chapterless);
  });

  test("provenance is returned so the UI can label where a receipt came from", async () => {
    const t = newT();
    const s = await setupChapter(t, { chapterName: "NY" });
    await seedBookkeeper(s);
    const mine = await newUploadReceipt(s);
    const chapterless = await newChapterlessReceipt(s);

    const rows = await s.as.query(api.receipts.listReceipts, {});
    const byId = new Map(rows.map((r) => [r._id, r]));
    expect(byId.get(mine)?.chapterName).toBe("NY");
    // A chapterless row reports null rather than vanishing — the UI shows
    // "Unassigned" instead of the row being invisible everywhere.
    expect(byId.get(chapterless)?.chapterId).toBeNull();
    expect(byId.get(chapterless)?.chapterName).toBeNull();
  });

  test("rankForTransactionId floats same-chapter first, then chapterless — hiding nothing", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "a@publicworship.life", chapterName: "NY" });
    const other = await setupChapter(t, { email: "b@publicworship.life", chapterName: "Boston" });
    await seedBookkeeper(s);

    // Created oldest → newest, so the UNRANKED (newest-first) order would be
    // exactly the reverse of the ranking we expect — proving ranking ran.
    const nyReceipt = await newUploadReceipt(s);
    const chapterless = await newChapterlessReceipt(s);
    const bostonReceipt = await newUploadReceipt(other);

    const nyTxn = await seedTxn(s);
    const unranked = await s.as.query(api.receipts.listReceipts, { filter: "unlinked" });
    expect(unranked.map((r) => r._id)).toEqual([bostonReceipt, chapterless, nyReceipt]);

    const ranked = await s.as.query(api.receipts.listReceipts, {
      filter: "unlinked",
      rankForTransactionId: nyTxn,
    });
    expect(ranked.map((r) => r._id)).toEqual([nyReceipt, chapterless, bostonReceipt]);
  });
});

describe("linking is gated on the transaction, not the receipt's chapter", () => {
  test("a chapterless (unknown-sender) receipt can be linked — the founder's stuck case", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const txn = await seedTxn(s, { status: "categorized" });
    const chapterless = await newChapterlessReceipt(s);

    const res = await s.as.mutation(api.receipts.linkReceipt, {
      receiptId: chapterless,
      transactionId: txn,
    });
    expect(res).toEqual({ linked: true, reconciled: true });
  });

  test("a receipt whose provenance is ANOTHER chapter still links (provenance is a hint)", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "a@publicworship.life", chapterName: "NY" });
    const other = await setupChapter(t, { email: "b@publicworship.life", chapterName: "Boston" });
    await seedBookkeeper(s);
    const txn = await seedTxn(s, { status: "categorized" });
    const bostonReceipt = await newUploadReceipt(other);

    const res = await s.as.mutation(api.receipts.linkReceipt, {
      receiptId: bostonReceipt,
      transactionId: txn,
    });
    expect(res).toEqual({ linked: true, reconciled: true });
  });

  test("but the TRANSACTION is still gated — no linking onto another chapter's charge", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "a@publicworship.life", chapterName: "NY" });
    const other = await setupChapter(t, { email: "b@publicworship.life", chapterName: "Boston" });
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

// ── Upload progress: the row says what's happening to it ────────────────────
// A mass upload staggers its extractions `THROTTLE_MS` apart, so the last
// file in a 25-photo drop waits minutes for its turn. Before `extraction`,
// every one of those rows looked identical to a receipt whose read had
// already finished and found nothing — an empty card with no explanation.
describe("submitUploadedReceipts — extraction progress", () => {
  test("each scheduled upload is stamped queued with the time its turn comes", async () => {
    vi.useFakeTimers();
    try {
      const t = newT();
      const s = await setupChapter(t);
      await seedBookkeeper(s);
      const a = await storeBlobWithContent(s, "receipt one");
      const b = await storeBlobWithContent(s, "receipt two");

      const results = await s.as.mutation(api.receipts.submitUploadedReceipts, {
        storageIds: [a, b],
      });

      const rows = await Promise.all(
        results.map((r) => run(t, (ctx) => ctx.db.get(r.receiptId))),
      );
      for (const row of rows) {
        expect(row?.extraction?.status).toBe("queued");
        expect(row?.extraction?.nextAttemptAt).toBeGreaterThanOrEqual(row!.extraction!.since);
      }
      // The SECOND file waits behind the first — that stagger is the whole
      // reason the row needs to say when its turn is.
      expect(rows[1]!.extraction!.nextAttemptAt!).toBeGreaterThan(
        rows[0]!.extraction!.nextAttemptAt!,
      );

      // Once processing runs (no engine key here → a clean no-key outcome),
      // nothing is pending and the row stops claiming to be busy.
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      for (const r of results) {
        const done = await run(t, (ctx) => ctx.db.get(r.receiptId));
        expect(done?.extraction).toBeUndefined();
      }
    } finally {
      vi.useRealTimers();
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

// ── suggestMatches — dateless receipts (the "$16.36 didn't auto-match" fix) ──
// A receipt whose OCR read a total but NO date must still surface a unique
// exact-amount charge, however old — the modal's suggestions and the auto-match
// pipeline share this matcher, so a fabricated createdAt date used to hide the
// only matching charge behind the ±14-day window.
describe("suggestMatches — no-date matching", () => {
  const DAY = 24 * 60 * 60 * 1000;
  test("a receipt with an amount but NO date surfaces a unique months-old exact-amount charge", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const now = Date.now();
    // The only unreceipted $16.36 charge is 6 months old.
    const txn = await seedTxn(s, { amountCents: 1636, postedAt: now - 180 * DAY });
    await seedTxn(s, { amountCents: 999, postedAt: now }); // wrong amount, ignore
    const storageId = await storeBlobWithContent(s, "audible");
    // ocrAmountCents seeds canonical amountCents; ocrDate omitted → receiptDate null.
    const receiptId = await run(t, (ctx) =>
      createReceipt(ctx, {
        chapterId: s.chapterId,
        storageId,
        source: "upload",
        ocrAmountCents: 1636,
      }),
    );

    const matches = await s.as.query(api.receipts.suggestMatches, { receiptId });
    expect(matches.map((m) => m.transactionId)).toEqual([txn]);
  });
});

// ── searchUnreceiptedTransactions (item 4: search a txn to match to) ──────────
describe("transactionMatchesSearch", () => {
  const audible = { merchantName: "Audible", description: null, amountCents: 1636 };
  const costco = { merchantName: "Costco", description: "warehouse run", amountCents: 4210 };

  test("empty query matches everything", () => {
    expect(transactionMatchesSearch(audible, "")).toBe(true);
    expect(transactionMatchesSearch(audible, "   ")).toBe(true);
  });
  test("matches merchant or description, case-insensitively", () => {
    expect(transactionMatchesSearch(audible, "aud")).toBe(true);
    expect(transactionMatchesSearch(costco, "COSTCO")).toBe(true);
    expect(transactionMatchesSearch(costco, "warehouse")).toBe(true);
    expect(transactionMatchesSearch(audible, "costco")).toBe(false);
  });
  test("matches amount as dollars, with $, or raw cents", () => {
    expect(transactionMatchesSearch(audible, "16.36")).toBe(true);
    expect(transactionMatchesSearch(audible, "$16.36")).toBe(true);
    expect(transactionMatchesSearch(audible, "1636")).toBe(true);
    expect(transactionMatchesSearch(audible, "16.37")).toBe(false);
  });
});

// FOUNDER FIX (2026-07-24): "it doesn't let me search transactions that
// already have receipts, but some transactions may need multiple receipts
// associated." Receipted transactions are now INCLUDED in every search here
// (never excluded), tagged `hasReceipt` so the UI can badge them instead of
// hiding them — a bookkeeper can knowingly attach a second receipt.
describe("searchUnreceiptedTransactions", () => {
  test("finds spend by merchant or amount, excludes non-spend, tags receipted results with hasReceipt", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const now = Date.now();
    const audible = await seedTxn(s, { merchantName: "Audible", amountCents: 1636, postedAt: now });
    await seedTxn(s, { merchantName: "Costco", amountCents: 4210, postedAt: now });
    // A transaction may need a SECOND receipt — no longer excluded, just tagged.
    const audibleReceipted = await seedTxn(s, {
      merchantName: "Audible",
      amountCents: 1636,
      postedAt: now,
      hasReceipt: true,
    });
    // Still excluded: a non-spend inflow, regardless of receipt state.
    await seedTxn(s, { merchantName: "Audible", amountCents: 1636, postedAt: now, flow: "inflow" });

    const byName = await s.as.query(api.receipts.searchUnreceiptedTransactions, { query: "audible" });
    const byNameId = new Map(byName.map((r) => [r.transactionId, r]));
    expect(byNameId.size).toBe(2);
    expect(byNameId.get(audible)?.hasReceipt).toBe(false);
    expect(byNameId.get(audibleReceipted)?.hasReceipt).toBe(true);

    const byAmount = await s.as.query(api.receipts.searchUnreceiptedTransactions, { query: "$16.36" });
    expect(byAmount.map((r) => r.transactionId).sort()).toEqual([audible, audibleReceipted].sort());
  });

  test("a viewer can't search (bookkeeper+ gate)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const person = await seedPerson(s);
    await grantRole(s, person, "viewer");
    await expect(
      s.as.query(api.receipts.searchUnreceiptedTransactions, {}),
    ).rejects.toThrow(ConvexError);
  });

  test("empty query returns the chapter's spend, receipted and unreceipted alike", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const a = await seedTxn(s, { merchantName: "A", amountCents: 100 });
    const b = await seedTxn(s, { merchantName: "B", amountCents: 200 });
    const c = await seedTxn(s, { merchantName: "C", amountCents: 300, hasReceipt: true }); // now included
    const all = await s.as.query(api.receipts.searchUnreceiptedTransactions, {});
    expect(all.map((r) => r.transactionId).sort()).toEqual([a, b, c].sort());
    expect(all.find((r) => r.transactionId === c)?.hasReceipt).toBe(true);
    expect(all.find((r) => r.transactionId === a)?.hasReceipt).toBe(false);
  });
});

// ── listInboundQueue: hiding confirmed/exact duplicates (BUG FIX) ────────────
// Confirming a receipt as a duplicate (`markAsDuplicate`) already hides it
// from the library's default views, but the SAME resolved receipt used to
// keep sitting in the inbox's per-email `receipts[]` list — badged
// "Duplicate", but never actually going away — so a resolved email kept
// demanding attention forever. The fix: `listInboundQueue` excludes any
// receipt with `duplicateOfReceiptId` set from that list, and drops the whole
// inbound row when EVERY extracted receipt turned out to be a duplicate.
describe("listInboundQueue — duplicate hiding", () => {
  async function seedInboundRow(
    s: ChapterSetup,
    opts: { status?: "needs_review" | "no_match" | "error" } = {},
  ): Promise<Id<"inboundReceipts">> {
    return await run(s.t, (ctx) =>
      ctx.db.insert("inboundReceipts", {
        emailId: `e_${Math.random()}`,
        status: opts.status ?? "needs_review",
        fromEmail: "sender@x.com",
        chapterId: s.chapterId,
        receivedAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
  }

  test("excludes a confirmed-duplicate receipt from its email's receipts[] list", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const inboundReceiptId = await seedInboundRow(s);
    const primary = await newUploadReceipt(s, { amountCents: 5000 });

    const storageId = await storeBlobWithContent(s, `email-${Math.random()}`);
    const dupe = await run(t, (ctx) =>
      createReceipt(ctx, {
        chapterId: s.chapterId,
        storageId,
        source: "email",
        inboundReceiptId,
        ocrAmountCents: 5000,
      }),
    );
    const otherStorageId = await storeBlobWithContent(s, `other-${Math.random()}`);
    const clean = await run(t, (ctx) =>
      createReceipt(ctx, {
        chapterId: s.chapterId,
        storageId: otherStorageId,
        source: "email",
        inboundReceiptId,
        ocrAmountCents: 1200,
      }),
    );
    await s.as.mutation(api.receipts.markAsDuplicate, {
      receiptId: dupe,
      primaryReceiptId: primary,
    });

    const rows = await s.as.query(api.receipts.listInboundQueue, {});
    const row = rows.find((r) => r._id === inboundReceiptId);
    expect(row).toBeDefined();
    const receiptIds = row!.receipts.map((r) => r._id);
    expect(receiptIds).toContain(clean);
    expect(receiptIds).not.toContain(dupe);
  });

  test("drops the whole inbound row once EVERY extracted receipt is a confirmed duplicate", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const inboundReceiptId = await seedInboundRow(s);
    const primary = await newUploadReceipt(s, { amountCents: 5000 });

    const storageId = await storeBlobWithContent(s, `email-${Math.random()}`);
    const onlyReceipt = await run(t, (ctx) =>
      createReceipt(ctx, {
        chapterId: s.chapterId,
        storageId,
        source: "email",
        inboundReceiptId,
        ocrAmountCents: 5000,
      }),
    );
    await s.as.mutation(api.receipts.markAsDuplicate, {
      receiptId: onlyReceipt,
      primaryReceiptId: primary,
    });

    const rows = await s.as.query(api.receipts.listInboundQueue, {});
    expect(rows.map((r) => r._id)).not.toContain(inboundReceiptId);
  });

  test("never drops a row that legitimately has no extracted receipts (e.g. an OCR failure)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const inboundReceiptId = await seedInboundRow(s, { status: "error" });

    const rows = await s.as.query(api.receipts.listInboundQueue, { status: "error" });
    expect(rows.map((r) => r._id)).toContain(inboundReceiptId);
  });
});

// ── suggestedForTransaction / confirmSuggestedReceipt ────────────────────────
/**
 * The CAPTURE-AND-SUGGEST surface (owner decision, 2026-08-08): the inbound
 * pipelines stopped auto-attaching, so a receipt waits unlinked in its
 * sender's library until the person coding the charge confirms it. These two
 * functions are the ONLY ones in `receipts.ts` a non-bookkeeper may call, so
 * the gate (`lib/receiptSuggestionAccess.ts`) gets as much attention as the
 * ranking.
 */
describe("suggestedForTransaction / confirmSuggestedReceipt", () => {
  const DAY = 24 * 60 * 60 * 1000;

  /** A person who is NOT the caller — used for "somebody else's receipt". */
  async function seedOtherPerson(s: ChapterSetup): Promise<Id<"people">> {
    return await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Someone Else",
        createdAt: Date.now(),
      }),
    );
  }

  async function seedCapturedReceipt(
    s: ChapterSetup,
    opts: {
      uploadedByPersonId?: Id<"people">;
      inboundReceiptId?: Id<"inboundReceipts">;
      amountCents?: number;
      receiptDate?: number;
      merchant?: string;
      candidateTransactionIds?: Id<"transactions">[];
    },
  ): Promise<Id<"receipts">> {
    const storageId = await storeBlobWithContent(s, `captured-${Math.random()}`);
    return await run(s.t, (ctx) =>
      createReceipt(ctx, {
        chapterId: s.chapterId,
        storageId,
        source: "email",
        uploadedByPersonId: opts.uploadedByPersonId,
        inboundReceiptId: opts.inboundReceiptId,
        ocrAmountCents: opts.amountCents,
        ocrDate: opts.receiptDate,
        ocrMerchant: opts.merchant,
        candidateTransactionIds: opts.candidateTransactionIds,
      }),
    );
  }

  test("the cardholder — with NO finance role at all — sees their own unlinked receipts ranked against their own charge", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // The caller's own person row, deliberately ungranted: this is the whole
    // point of the new gate (every other read here is bookkeeper+).
    const me = await seedPerson(s);
    const postedAt = Date.now();
    const txn = await seedTxn(s, {
      amountCents: 4210,
      postedAt,
      personId: me,
      merchantName: "Office Depot",
    });

    // Exact amount + same day + merchant overlap.
    const exact = await seedCapturedReceipt(s, {
      uploadedByPersonId: me,
      amountCents: 4210,
      receiptDate: postedAt,
      merchant: "Office Depot",
    });
    // The pipeline already put THIS charge on its shortlist when it arrived —
    // outranks a bare exact-amount match even with a different total.
    const shortlisted = await seedCapturedReceipt(s, {
      uploadedByPersonId: me,
      amountCents: 5000,
      receiptDate: postedAt - DAY,
      candidateTransactionIds: [txn],
    });
    // Unrelated amount, no shortlist, no merchant overlap → never offered.
    await seedCapturedReceipt(s, {
      uploadedByPersonId: me,
      amountCents: 999,
      receiptDate: postedAt,
      merchant: "Some Diner",
    });

    const rows = await s.as.query(api.receipts.suggestedForTransaction, {
      transactionId: txn,
    });
    expect(rows.map((r) => r.receiptId)).toEqual([shortlisted, exact]);

    // Everything a human needs to decide, without opening both records.
    const top = rows[0];
    expect(top.match.pipelineSuggested).toBe(true);
    expect(top.match.amountExact).toBe(false);
    expect(top.match.amountDeltaCents).toBe(790);
    expect(top.match.daysApart).toBe(1);
    expect(top.url).not.toBeNull();
    // `contentType` rides along so the viewer knows whether to render an
    // image, a PDF, or an email body. convex-test's storage shim records no
    // content type on the `_storage` system row, so it reads null here —
    // exactly the "legacy row with no storage metadata" contract the library
    // projection already documents.
    expect(top.contentType).toBeNull();

    const second = rows[1];
    expect(second.match.amountExact).toBe(true);
    expect(second.match.amountDeltaCents).toBe(0);
    expect(second.match.daysApart).toBe(0);
    expect(second.match.merchantOverlap).toBe(true);
    expect(second.amountCents).toBe(4210);
    expect(second.ocrAmountCents).toBe(4210);
    expect(second.score).toBeLessThan(top.score);
  });

  test("a LEGACY captured receipt (no uploadedByPersonId) is attributed through its inbound row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedPerson(s);
    const txn = await seedTxn(s, { amountCents: 4210, personId: me });

    const inboundReceiptId = await run(t, (ctx) =>
      ctx.db.insert("inboundReceipts", {
        emailId: "legacy_1",
        status: "needs_review",
        fromEmail: "me@example.com",
        receivedAt: Date.now(),
        personId: me,
        chapterId: s.chapterId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const legacy = await seedCapturedReceipt(s, {
      inboundReceiptId,
      amountCents: 4210,
      receiptDate: Date.now(),
    });

    const rows = await s.as.query(api.receipts.suggestedForTransaction, {
      transactionId: txn,
    });
    expect(rows.map((r) => r.receiptId)).toEqual([legacy]);
  });

  test("somebody else's receipt is never suggested, however well it matches", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedPerson(s);
    const other = await seedOtherPerson(s);
    const postedAt = Date.now();
    const txn = await seedTxn(s, { amountCents: 4210, postedAt, personId: me });
    await seedCapturedReceipt(s, {
      uploadedByPersonId: other,
      amountCents: 4210,
      receiptDate: postedAt,
      merchant: "Office Depot",
    });

    const rows = await s.as.query(api.receipts.suggestedForTransaction, {
      transactionId: txn,
    });
    expect(rows).toEqual([]);
  });

  test("a member with no finance role is refused on somebody ELSE's charge", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPerson(s);
    const other = await seedOtherPerson(s);
    const txn = await seedTxn(s, { amountCents: 4210, personId: other });

    await expect(
      s.as.query(api.receipts.suggestedForTransaction, { transactionId: txn }),
    ).rejects.toThrow(ConvexError);
  });

  test("a bookkeeper sees the cardholder's receipts on the cardholder's charge", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // The caller is a bookkeeper; the charge (and the receipt) are someone
    // else's — the "coding on their behalf" case.
    await seedBookkeeper(s);
    const cardholder = await seedOtherPerson(s);
    const postedAt = Date.now();
    const txn = await seedTxn(s, { amountCents: 4210, postedAt, personId: cardholder });
    const theirs = await seedCapturedReceipt(s, {
      uploadedByPersonId: cardholder,
      amountCents: 4210,
      receiptDate: postedAt,
    });

    const rows = await s.as.query(api.receipts.suggestedForTransaction, {
      transactionId: txn,
    });
    expect(rows.map((r) => r.receiptId)).toEqual([theirs]);
  });

  test("confirming a suggestion links it through the single writer (linkCount, denorm, reconcile)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedPerson(s);
    const postedAt = Date.now();
    const txn = await seedTxn(s, {
      amountCents: 4210,
      postedAt,
      personId: me,
      status: "categorized",
    });
    const receiptId = await seedCapturedReceipt(s, {
      uploadedByPersonId: me,
      amountCents: 4210,
      receiptDate: postedAt,
    });

    const result = await s.as.mutation(api.receipts.confirmSuggestedReceipt, {
      receiptId,
      transactionId: txn,
    });
    expect(result).toEqual({ linked: true, reconciled: true });

    const receipt = await run(t, (ctx) => ctx.db.get(receiptId));
    expect(receipt?.linkCount).toBe(1);
    const txnRow = await run(t, (ctx) => ctx.db.get(txn));
    expect(txnRow?.status).toBe("reconciled");
    expect(txnRow?.receiptStorageId).toBe(receipt?.storageId);
    const links = await run(t, (ctx) => ctx.db.query("receiptLinks").take(5));
    expect(links).toHaveLength(1);
    // A human picked it — provenance says so.
    expect(links[0].source).toBe("manual");
    expect(links[0].linkedByPersonId).toBe(me);

    // And it drops off the suggestion list, since it's no longer unlinked.
    const after = await s.as.query(api.receipts.suggestedForTransaction, {
      transactionId: txn,
    });
    expect(after).toEqual([]);
  });

  test("a cardholder cannot staple somebody else's receipt onto their own charge", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedPerson(s);
    const other = await seedOtherPerson(s);
    const txn = await seedTxn(s, { amountCents: 4210, personId: me });
    const notMine = await seedCapturedReceipt(s, {
      uploadedByPersonId: other,
      amountCents: 4210,
      receiptDate: Date.now(),
    });

    await expect(
      s.as.mutation(api.receipts.confirmSuggestedReceipt, {
        receiptId: notMine,
        transactionId: txn,
      }),
    ).rejects.toThrow(ConvexError);
    const links = await run(t, (ctx) => ctx.db.query("receiptLinks").take(5));
    expect(links).toHaveLength(0);
  });

  test("an ALREADY-LINKED receipt is refused — re-using one is a bookkeeper's call", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const me = await seedPerson(s);
    const first = await seedTxn(s, { amountCents: 4210, personId: me });
    const second = await seedTxn(s, { amountCents: 4210, personId: me });
    const receiptId = await seedCapturedReceipt(s, {
      uploadedByPersonId: me,
      amountCents: 4210,
      receiptDate: Date.now(),
    });
    await s.as.mutation(api.receipts.confirmSuggestedReceipt, {
      receiptId,
      transactionId: first,
    });

    await expect(
      s.as.mutation(api.receipts.confirmSuggestedReceipt, {
        receiptId,
        transactionId: second,
      }),
    ).rejects.toThrow(ConvexError);
  });
});
