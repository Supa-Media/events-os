import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { internal } from "../_generated/api";
import { newT, run, storeBlob, type TestConvex } from "./setup.helpers";
import type { Doc, Id } from "../_generated/dataModel";
import {
  CLEANUP_NEW_TXNS,
  CLEANUP_PATCHES,
  CLEANUP_CATEGORIES,
  CLEANUP_EXCEPTIONS,
  CLEANUP_DELETIONS,
  CLEANUP_RECEIPTS_ONLY,
  OWNER_GIFT_REDUCTION_CENTS,
} from "../lib/seed/historical/genesisCleanup2026";
import { cleanupExternalId } from "../genesisCleanup";

/**
 * Genesis cleanup: the second ops pass over the owner-paid rows.
 *
 * Covers: dataset integrity; dry run writes nothing but predicts the counts; execute
 * deletes the $700 and reduces the owner's gift by exactly $700 (carrying the donor
 * rollup with it); new rows land coded to a resolved budget AND category; the Zoom
 * patch absorbs its two per-item rows; an unresolvable budget name is REPORTED rather
 * than silently miscoded; exceptions are FILED as pending and never self-approved;
 * a row that already has a receipt gets no exception; idempotency; and that evidence
 * is attached to the exception rather than written as a receipt.
 */

const NY_SLUG = "new-york";
const GIFT_REF = "genesis:gear2024";
const GEAR_GIFT_CENTS = 444691;

type S = {
  t: TestConvex;
  chapterId: Id<"chapters">;
  userId: Id<"users">;
  donorId: Id<"donors">;
  giftId: Id<"gifts">;
  budgets: Map<string, Id<"budgets">>;
  cats: Map<string, Id<"budgetCategories">>;
};

/** Every budget label and category name the dataset names, so nothing is unresolved
 *  by accident — the unresolved path gets its own test with a deliberate gap. */
const BUDGET_LABELS = [
  "Equipment Repairs & Upgrades",
  "Eden · June 2025",
  "PW's First Event",
  "Love Thy Neighbor 2025",
  "Worship in Public - Social Media Growth Strategy",
];
const CATEGORY_NAMES = [
  "Equipment",
  "Supplies",
  "Transportation",
  "Food & Meals",
  "Professional Services",
];

async function setup(opts: { skipBudget?: string } = {}): Promise<S> {
  const t = newT();
  const ids = await run(t, async (ctx) => {
    const chapterId = await ctx.db.insert("chapters", {
      name: "New York", slug: NY_SLUG, isActive: true, createdAt: Date.now(),
    });
    const userId = await ctx.db.insert("users", { email: "owner@publicworship.life" });
    const fundId = await ctx.db.insert("funds", {
      chapterId, name: "General", restriction: "unrestricted", sortOrder: 0,
      isActive: true, createdAt: Date.now(),
    });
    const budgets = new Map<string, Id<"budgets">>();
    for (const label of BUDGET_LABELS) {
      if (opts.skipBudget === label) continue;
      budgets.set(label, await ctx.db.insert("budgets", {
        chapterId, label, amountCents: 500000, cadence: "yearly", year: 2025,
        createdAt: Date.now(),
      }));
    }
    const cats = new Map<string, Id<"budgetCategories">>();
    for (const name of CATEGORY_NAMES) {
      cats.set(name, await ctx.db.insert("budgetCategories", {
        chapterId, fundId, name, kind: "category", createdAt: Date.now(),
      }));
    }

    /** A genesis row in the shape the previous passes left behind. */
    const genesis = async (externalId: string, amountCents: number, postedAt: number) =>
      ctx.db.insert("transactions", {
        chapterId, source: "manual", flow: "outflow", amountCents, currency: "usd",
        postedAt, description: externalId, note: "genesis", status: "categorized",
        fundId, budgetId: budgets.get("Equipment Repairs & Upgrades")!,
        externalId, createdAt: Date.now(),
      });

    for (const d of CLEANUP_DELETIONS) await genesis(d.externalId, 70000, Date.UTC(2024, 10, 3));
    for (const p of CLEANUP_PATCHES) {
      await genesis(p.externalId, 1000, Date.UTC(2025, 0, 1));
      for (const m of p.mergeExternalIds ?? []) await genesis(m, 500, Date.UTC(2025, 0, 1));
    }
    for (const c of CLEANUP_CATEGORIES) {
      const seen = await ctx.db
        .query("transactions")
        .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", chapterId))
        .collect();
      if (!seen.some((t) => t.externalId === c.externalId)) {
        await genesis(c.externalId, 2500, Date.UTC(2025, 0, 1));
      }
    }
    for (const e of CLEANUP_EXCEPTIONS) {
      const seen = await ctx.db
        .query("transactions")
        .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", chapterId))
        .collect();
      if (!seen.some((t) => t.externalId === e.externalId)) {
        await genesis(e.externalId, 4000, Date.UTC(2025, 2, 15));
      }
    }
    for (const r of CLEANUP_RECEIPTS_ONLY) {
      const seen = await ctx.db
        .query("transactions")
        .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", chapterId))
        .collect();
      if (!seen.some((t) => t.externalId === r.externalId)) {
        await genesis(r.externalId, 3000, Date.UTC(2025, 3, 1));
      }
    }

    const donorId = await ctx.db.insert("donors", {
      scope: chapterId, kind: "individual", name: "Oluseyi Olujide", status: "active",
      lifetimeCents: GEAR_GIFT_CENTS, giftCount: 1, createdAt: Date.now(),
    });
    const giftId = await ctx.db.insert("gifts", {
      donorId, scope: chapterId, amountCents: GEAR_GIFT_CENTS, currency: "usd",
      receivedAt: Date.UTC(2024, 11, 31), method: "in_kind", externalRef: GIFT_REF,
      note: "In-kind: 2024 gear.", createdAt: Date.now(),
    });
    // Maps are not a Convex value — hand back pairs and rebuild outside `run`.
    return {
      chapterId, userId, donorId, giftId,
      budgetPairs: [...budgets.entries()],
      catPairs: [...cats.entries()],
    };
  });
  return {
    t,
    chapterId: ids.chapterId,
    userId: ids.userId,
    donorId: ids.donorId,
    giftId: ids.giftId,
    budgets: new Map(ids.budgetPairs),
    cats: new Map(ids.catPairs),
  };
}

const txns = (s: S): Promise<Doc<"transactions">[]> =>
  run(s.t, (ctx) => ctx.db
    .query("transactions")
    .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", s.chapterId))
    .collect());

const RUN = internal.genesisCleanup.runGenesisCleanup;

describe("cleanup dataset", () => {
  test("new rows are positive integer cents with a budget and a category", () => {
    expect(CLEANUP_NEW_TXNS.length).toBe(16);
    const slugs = new Set(CLEANUP_NEW_TXNS.map((r) => r.slug));
    expect(slugs.size).toBe(CLEANUP_NEW_TXNS.length);
    for (const r of CLEANUP_NEW_TXNS) {
      expect(Number.isInteger(r.amountCents)).toBe(true);
      expect(r.amountCents).toBeGreaterThan(0);
      expect(BUDGET_LABELS).toContain(r.budgetLabel);
      expect(CATEGORY_NAMES).toContain(r.categoryName);
    }
  });

  test("every named budget and category is one the dataset can actually resolve", () => {
    for (const p of CLEANUP_PATCHES) {
      if (p.budgetLabel) expect(BUDGET_LABELS).toContain(p.budgetLabel);
    }
    for (const c of CLEANUP_CATEGORIES) expect(CATEGORY_NAMES).toContain(c.categoryName);
  });

  test("the upload script's document table matches the dataset", () => {
    // The script can't import TS, so it duplicates the key→file mapping. This is the
    // guard that the copy never drifts — every document the dataset names must be
    // uploadable, and the script must carry no rows the dataset doesn't have.
    const src = readFileSync(
      join(__dirname, "../../../scripts/upload-cleanup-docs.mjs"),
      "utf8",
    );
    const expected: [string, string][] = [
      ...CLEANUP_NEW_TXNS.map((r) => [cleanupExternalId(r.slug), r.receiptFile] as [string, string]),
      ...CLEANUP_PATCHES.filter((p) => p.receiptFile).map((p) => [p.externalId, p.receiptFile!] as [string, string]),
      ...CLEANUP_RECEIPTS_ONLY.map((r) => [r.externalId, r.receiptFile] as [string, string]),
      ...CLEANUP_EXCEPTIONS.filter((e) => e.evidenceFile).map((e) => [e.externalId, e.evidenceFile!] as [string, string]),
    ];
    for (const [key, file] of expected) {
      expect(src).toContain(`["${key}", "${file}"]`);
    }
    const pairs = src.match(/\["genesis-[^"]+", "[^"]+"\]/g) ?? [];
    expect(pairs).toHaveLength(expected.length);
  });

  test("exceptions are 'lost', never 'no_receipt_issued'", () => {
    // A store, a restaurant and Instacart all issue receipts — claiming none was
    // issued would overstate how unavoidable the gap was.
    for (const e of CLEANUP_EXCEPTIONS) {
      expect(e.reason).toBe("lost");
      expect(e.note.length).toBeGreaterThan(60);
    }
  });
});

describe("runGenesisCleanup", () => {
  test("dry run predicts counts and writes nothing", async () => {
    const s = await setup();
    const before = (await txns(s)).length;
    const res = await s.t.mutation(RUN, { editedBy: s.userId });
    expect(res.dryRun).toBe(true);
    expect(res.unresolved).toEqual([]);
    expect(res.counts.deleted).toBe(1);
    expect(res.counts.created).toBe(16);
    expect(res.counts.giftReducedCents).toBe(OWNER_GIFT_REDUCTION_CENTS);
    expect((await txns(s)).length).toBe(before);
    const gift = await run(s.t, (ctx) => ctx.db.get(s.giftId));
    expect(gift?.amountCents).toBe(GEAR_GIFT_CENTS);
  });

  test("execute deletes the $700 and cuts the owner's gift by exactly $700", async () => {
    const s = await setup();
    await s.t.mutation(RUN, { editedBy: s.userId, execute: true });

    const rows = await txns(s);
    expect(rows.some((r) => r.externalId === CLEANUP_DELETIONS[0].externalId)).toBe(false);

    const gift = await run(s.t, (ctx) => ctx.db.get(s.giftId));
    expect(gift?.amountCents).toBe(GEAR_GIFT_CENTS - 70000);
    // The rollup must move with it — the reason this goes through `editGiftRow`.
    const donor = await run(s.t, (ctx) => ctx.db.get(s.donorId));
    expect(donor?.lifetimeCents).toBe(GEAR_GIFT_CENTS - 70000);
    expect(donor?.giftCount).toBe(1);
  });

  test("new rows land coded to a real budget and category", async () => {
    const s = await setup();
    await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    const rows = await txns(s);
    for (const r of CLEANUP_NEW_TXNS) {
      const row = rows.find((t) => t.externalId === cleanupExternalId(r.slug))!;
      expect(row).toBeDefined();
      expect(row.amountCents).toBe(r.amountCents);
      expect(row.budgetId).toBe(s.budgets.get(r.budgetLabel));
      expect(row.categoryId).toBe(s.cats.get(r.categoryName));
      expect(row.flow).toBe("outflow");
    }
  });

  test("the Zoom patch absorbs its two per-item rows", async () => {
    const s = await setup();
    const zoom = CLEANUP_PATCHES.find((p) => p.mergeExternalIds?.length)!;
    await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    const rows = await txns(s);
    const kept = rows.find((r) => r.externalId === zoom.externalId)!;
    expect(kept.amountCents).toBe(zoom.amountCents);
    expect(kept.postedAt).toBe(zoom.dateMs);
    for (const m of zoom.mergeExternalIds!) {
      expect(rows.some((r) => r.externalId === m)).toBe(false);
    }
  });

  test("a misfiled central budget is MOVED to the chapter, not reached into", async () => {
    // Production shape, and the reason `CLEANUP_BUDGET_MOVES` exists: "Worship in
    // Public - Social Media Growth Strategy" was created on `central` while its
    // project and all its transactions are New York's. The fix is to reparent it —
    // teaching the resolver to read central would have papered over the misfiling.
    const label = "Worship in Public - Social Media Growth Strategy";
    const s = await setup({ skipBudget: label });
    const budgetId = await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: "central" as const, label,
        amountCents: 300000, cadence: "yearly", year: 2025, createdAt: Date.now(),
      }),
    );

    const dry = await s.t.mutation(RUN, { editedBy: s.userId });
    expect(dry.counts.budgetsMoved).toBe(1);
    expect(dry.unresolved).toEqual([]); // a dry run must not misreport it as unresolved
    expect((await run(s.t, (ctx) => ctx.db.get(budgetId)))!.chapterId).toBe("central");

    const res = await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    expect(res.counts.budgetsMoved).toBe(1);
    expect(res.unresolved).toEqual([]);
    expect((await run(s.t, (ctx) => ctx.db.get(budgetId)))!.chapterId).toBe(s.chapterId);

    // …and the row that needed it lands on that budget.
    const zoom = CLEANUP_PATCHES.find((p) => p.mergeExternalIds?.length)!;
    const rows = await txns(s);
    expect(rows.find((r) => r.externalId === zoom.externalId)!.budgetId).toBe(budgetId);

    // Idempotent: nothing left on central to move.
    const again = await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    expect(again.counts.budgetsMoved).toBe(0);
  });

  test("central budgets this cleanup does NOT name are left alone", async () => {
    // Two other central budgets have some New York rows but are genuinely shared and
    // are live 2026 spend. Moving them would pull money out of central's reporting.
    const s = await setup();
    const shared = await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: "central" as const, label: "Renegade Evergreen (EP)",
        amountCents: 300000, cadence: "yearly", year: 2026, createdAt: Date.now(),
      }),
    );
    await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    expect((await run(s.t, (ctx) => ctx.db.get(shared)))!.chapterId).toBe("central");
  });

  test("an unresolvable budget is reported, not silently miscoded", async () => {
    const s = await setup({ skipBudget: "Eden · June 2025" });
    const res = await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    expect(res.unresolved.length).toBeGreaterThan(0);
    expect(res.unresolved.join(" ")).toContain("Eden · June 2025");
    // The Eden rows are skipped entirely rather than landing on a wrong budget.
    const rows = await txns(s);
    const eden = CLEANUP_NEW_TXNS.filter((r) => r.budgetLabel === "Eden · June 2025");
    for (const r of eden) {
      expect(rows.some((t) => t.externalId === cleanupExternalId(r.slug))).toBe(false);
    }
  });

  test("exceptions are filed as pending, never self-approved", async () => {
    const s = await setup();
    const res = await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    expect(res.counts.exceptionsFiled).toBe(CLEANUP_EXCEPTIONS.length);
    const ex = await run(s.t, (ctx) => ctx.db.query("receiptExceptions").collect());
    expect(ex).toHaveLength(CLEANUP_EXCEPTIONS.length);
    // Approving a no-receipt claim is a human judgement; the migration only attests.
    expect(ex.every((e) => e.status === "pending")).toBe(true);
    expect(ex.every((e) => e.reason === "lost")).toBe(true);
  });

  test("no exception is filed for a row that already has a receipt", async () => {
    const s = await setup();
    const target = CLEANUP_EXCEPTIONS[0].externalId;
    const storageId = await storeBlob(s.t);
    await run(s.t, async (ctx) => {
      const rows = await ctx.db
        .query("transactions")
        .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", s.chapterId))
        .collect();
      const t = rows.find((r) => r.externalId === target)!;
      await ctx.db.patch(t._id, { receiptStorageId: storageId });
    });
    const res = await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    expect(res.counts.exceptionsFiled).toBe(CLEANUP_EXCEPTIONS.length - 1);
  });

  test("second run is idempotent", async () => {
    const s = await setup();
    await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    const after = (await txns(s)).length;
    const again = await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    expect(again.counts.created).toBe(0);
    expect(again.counts.deleted).toBe(0);
    expect(again.counts.categorised).toBe(0);
    expect(again.counts.exceptionsFiled).toBe(0);
    expect(again.counts.giftReducedCents).toBe(0);
    expect((await txns(s)).length).toBe(after);
    const gift = await run(s.t, (ctx) => ctx.db.get(s.giftId));
    expect(gift?.amountCents).toBe(GEAR_GIFT_CENTS - 70000); // not reduced twice
  });
});

describe("attachCleanupDocuments", () => {
  const ATTACH = internal.genesisCleanup.attachCleanupDocuments;

  test("evidence lands on the exception, never as a receipt", async () => {
    const s = await setup();
    await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    const withEvidence = CLEANUP_EXCEPTIONS.find((e) => e.evidenceFile)!;
    const storageId = await storeBlob(s.t);

    const res = await s.t.mutation(ATTACH, {
      uploads: [{ key: withEvidence.externalId, storageId, filename: "applecash.png" }],
      execute: true,
    });
    expect(res.evidenceAttached).toBe(1);
    expect(res.receiptsAttached).toBe(0);

    // The distinction that matters: it is NOT a receipt and must not become one.
    expect(await run(s.t, (ctx) => ctx.db.query("receipts").collect())).toHaveLength(0);
    const rows = await txns(s);
    const t = rows.find((r) => r.externalId === withEvidence.externalId)!;
    expect(t.receiptStorageId).toBeUndefined();
    const ex = await run(s.t, (ctx) => ctx.db.query("receiptExceptions").collect());
    const target = ex.find((e) => e.transactionId === t._id)!;
    expect(target.evidenceStorageIds).toEqual([storageId]);
  });

  test("a real receipt attaches and links normally", async () => {
    const s = await setup();
    await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    const key = CLEANUP_RECEIPTS_ONLY[0].externalId;
    const storageId = await storeBlob(s.t);
    const res = await s.t.mutation(ATTACH, {
      uploads: [{ key, storageId, filename: "receipt.png" }],
      execute: true,
    });
    expect(res.receiptsAttached).toBe(1);
    expect(await run(s.t, (ctx) => ctx.db.query("receipts").collect())).toHaveLength(1);
    const rows = await txns(s);
    expect(rows.find((r) => r.externalId === key)!.receiptStorageId).toBe(storageId);
  });

  test("an unknown key is reported, not thrown", async () => {
    const s = await setup();
    await s.t.mutation(RUN, { editedBy: s.userId, execute: true });
    const storageId = await storeBlob(s.t);
    const res = await s.t.mutation(ATTACH, {
      uploads: [{ key: "genesis-cleanup:nope", storageId, filename: "x.png" }],
      execute: true,
    });
    expect(res.unmatched).toEqual(["genesis-cleanup:nope"]);
  });
});
