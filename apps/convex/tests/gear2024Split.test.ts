import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { internal } from "../_generated/api";
import { newT, run, storeBlob, type TestConvex } from "./setup.helpers";
import type { Doc, Id } from "../_generated/dataModel";
import {
  GEAR_2024_ORDER_ROWS,
  GEAR_2024_TOTAL_CENTS,
} from "../lib/seed/historical/gear2024Orders";
import { gear2024Description, gear2024ExternalId } from "../gear2024Split";

/**
 * 2024 gear split: the ops-only runner that replaces the single lumped
 * `genesis-inkind-exp:gear2024` transaction ($3,729.40, no receipt, transcribed
 * from a Notion table) with the 18 receipt-backed Amazon/Sweetwater orders it was
 * really made of, and restates the mirrored in-kind gift to match.
 *
 * Covers: dataset integrity (unique order refs, positive integer cents, 2024 dates,
 * and the derived total); the description elision boundary; dry run writes nothing
 * but predicts the counts; execute inserts all 18, deletes the lump, and restates the
 * gift to the same figure the expense leg now totals; fund/budget/status attribution
 * is INHERITED from the lump rather than dropped; a second execute run is fully
 * idempotent; a resumed run (lump already gone) still inherits coding from a prior
 * split row; the runner REFUSES to move the expense leg when the mirrored gift is
 * missing; receipts attach and link, skip an already-receipted transaction, and
 * report an unknown order ref instead of throwing; and the upload script's
 * (orderRef → file) table matches the dataset it stands in for.
 */

const NY_SLUG = "new-york";
const LUMP_EXTERNAL_ID = "genesis-inkind-exp:gear2024";
const GIFT_EXTERNAL_REF = "genesis:gear2024";
const LUMP_CENTS = 372940;

type Setup = {
  t: TestConvex;
  chapterId: Id<"chapters">;
  userId: Id<"users">;
  fundId: Id<"funds">;
  budgetId: Id<"budgets">;
  donorId: Id<"donors">;
  giftId: Id<"gifts">;
};

/**
 * The NY chapter in the exact state production is in before this migration: the lump
 * transaction, coded to a fund and a budget (a human coded it after the original
 * genesis backfill, which is why the split must inherit rather than re-derive), plus
 * the mirrored in-kind gift from the owner for the identical amount.
 *
 * `opts.withLump` / `opts.withGift` drop one of those to reproduce a resumed run and
 * the refuse-to-half-apply guard.
 */
async function setup(
  opts: { withLump?: boolean; withGift?: boolean } = {},
): Promise<Setup> {
  const withLump = opts.withLump ?? true;
  const withGift = opts.withGift ?? true;
  const t = newT();
  const ids = await run(t, async (ctx) => {
    const chapterId = await ctx.db.insert("chapters", {
      name: "New York",
      slug: NY_SLUG,
      isActive: true,
      createdAt: Date.now(),
    });
    // The operator the gift restatement is attributed to (`editGiftRow` stamps it).
    const userId = await ctx.db.insert("users", {
      email: "owner@publicworship.life",
    });
    const fundId = await ctx.db.insert("funds", {
      chapterId,
      name: "General",
      restriction: "unrestricted",
      sortOrder: 0,
      isActive: true,
      createdAt: Date.now(),
    });
    const budgetId = await ctx.db.insert("budgets", {
      chapterId,
      label: "2024 Music Ministry",
      amountCents: 500000,
      cadence: "yearly",
      year: 2024,
      createdAt: Date.now(),
    });
    if (withLump) {
      await ctx.db.insert("transactions", {
        chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: LUMP_CENTS,
        currency: "usd",
        postedAt: Date.UTC(2024, 11, 31),
        description: "2024 music-ministry gear, 33 items bought personally",
        note: "paid personally by Oluseyi Olujide; mirrors in-kind gift genesis:gear2024",
        status: "categorized",
        fundId,
        budgetId,
        externalId: LUMP_EXTERNAL_ID,
        createdAt: Date.now(),
      });
    }
    let giftId: Id<"gifts"> | null = null;
    let donorId: Id<"donors"> | null = null;
    if (withGift) {
      donorId = await ctx.db.insert("donors", {
        scope: chapterId,
        kind: "individual",
        name: "Oluseyi Olujide",
        status: "active",
        lifetimeCents: LUMP_CENTS,
        giftCount: 1,
        createdAt: Date.now(),
      });
      giftId = await ctx.db.insert("gifts", {
        donorId,
        scope: chapterId,
        amountCents: LUMP_CENTS,
        currency: "usd",
        receivedAt: Date.UTC(2024, 11, 31),
        method: "in_kind",
        externalRef: GIFT_EXTERNAL_REF,
        note: "In-kind: 2024 music-ministry gear, 33 items bought personally",
        createdAt: Date.now(),
      });
    }
    return { chapterId, userId, fundId, budgetId, donorId, giftId };
  });
  return {
    t,
    ...ids,
    donorId: ids.donorId as Id<"donors">,
    giftId: ids.giftId as Id<"gifts">,
  };
}

function chapterTxns(s: Setup): Promise<Doc<"transactions">[]> {
  return run(s.t, (ctx) =>
    ctx.db
      .query("transactions")
      .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", s.chapterId))
      .collect(),
  );
}

describe("gear2024 dataset", () => {
  test("18 orders, unique refs, positive integer cents, all dated 2024", () => {
    expect(GEAR_2024_ORDER_ROWS).toHaveLength(18);
    const refs = new Set(GEAR_2024_ORDER_ROWS.map((r) => r.orderRef));
    expect(refs.size).toBe(GEAR_2024_ORDER_ROWS.length);
    for (const row of GEAR_2024_ORDER_ROWS) {
      expect(Number.isInteger(row.amountCents)).toBe(true);
      expect(row.amountCents).toBeGreaterThan(0);
      expect(new Date(row.dateMs).getUTCFullYear()).toBe(2024);
      expect(row.items.length).toBeGreaterThan(0);
      expect(row.receiptFile).toMatch(/\.png$/);
    }
  });

  test("total is $4,446.91 — the figure both legs are restated to", () => {
    expect(GEAR_2024_TOTAL_CENTS).toBe(444691);
    // The restatement is an INCREASE over the lump; a regression that silently
    // shrank the dataset would otherwise still look self-consistent.
    expect(GEAR_2024_TOTAL_CENTS - LUMP_CENTS).toBe(71751);
  });

  test("description elides past four items and keeps the count honest", () => {
    const big = GEAR_2024_ORDER_ROWS.find((r) => r.items.length === 10);
    expect(big).toBeDefined();
    expect(gear2024Description(big!)).toContain("+6 more");
    const small = GEAR_2024_ORDER_ROWS.find((r) => r.items.length === 1);
    expect(gear2024Description(small!)).not.toContain("more");
  });

  test("upload script's file table matches the dataset", () => {
    // The script can't import the TS dataset, so it duplicates the mapping. This is
    // the guard that the copy never drifts.
    const src = readFileSync(
      join(__dirname, "../../../scripts/upload-gear2024-receipts.mjs"),
      "utf8",
    );
    for (const row of GEAR_2024_ORDER_ROWS) {
      expect(src).toContain(`["${row.orderRef}", "${row.receiptFile}"]`);
    }
    // …and carries no rows the dataset doesn't have.
    const pairs = src.match(/\["[^"]+", "Screenshot[^"]+"\]/g) ?? [];
    expect(pairs).toHaveLength(GEAR_2024_ORDER_ROWS.length);
  });
});

describe("runGear2024Split", () => {
  test("dry run predicts the counts and writes nothing", async () => {
    const s = await setup();
    const res = await s.t.mutation(internal.gear2024Split.runGear2024Split, { editedBy: s.userId });
    expect(res.dryRun).toBe(true);
    expect(res.counts.inserted).toBe(18);
    expect(res.counts.alreadyPresent).toBe(0);
    expect(res.counts.lumpDeleted).toBe(true);
    expect(res.counts.giftRestated).toBe(true);
    expect(res.counts.totalCents).toBe(444691);
    expect(res.counts.previousTotalCents).toBe(LUMP_CENTS);

    const rows = await chapterTxns(s);
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe(LUMP_EXTERNAL_ID);
    const gift = await run(s.t, (ctx) => ctx.db.get(s.giftId));
    expect(gift?.amountCents).toBe(LUMP_CENTS);
  });

  test("execute replaces the lump with 18 receipt-ready orders totalling the same as the restated gift", async () => {
    const s = await setup();
    const res = await s.t.mutation(internal.gear2024Split.runGear2024Split, {
      editedBy: s.userId,
      execute: true,
    });
    expect(res.dryRun).toBe(false);
    expect(res.counts.inserted).toBe(18);

    const rows = await chapterTxns(s);
    expect(rows).toHaveLength(18);
    expect(rows.some((r) => r.externalId === LUMP_EXTERNAL_ID)).toBe(false);

    const sum = rows.reduce((acc, r) => acc + r.amountCents, 0);
    expect(sum).toBe(444691);
    for (const r of rows) {
      expect(r.flow).toBe("outflow");
      expect(r.source).toBe("manual");
      expect(r.note).toContain("mirrors in-kind gift genesis:gear2024");
      expect(r.receiptStorageId).toBeUndefined();
    }

    // The two legs agree — the whole reason the runner touches the gift at all.
    const gift = await run(s.t, (ctx) => ctx.db.get(s.giftId));
    expect(gift?.amountCents).toBe(sum);
    expect(gift?.note).toContain("Restated");
  });

  test("restating the gift carries the donor's lifetime rollup with it", async () => {
    // The reason the runner goes through `editGiftRow` instead of patching
    // `gifts.amountCents`: a raw patch leaves `donors.lifetimeCents` (and the scope
    // rollup behind it) reading the old $3,729.40 forever.
    const s = await setup();
    await s.t.mutation(internal.gear2024Split.runGear2024Split, {
      editedBy: s.userId,
      execute: true,
    });
    const donor = await run(s.t, (ctx) => ctx.db.get(s.donorId));
    expect(donor?.lifetimeCents).toBe(444691);
    expect(donor?.giftCount).toBe(1); // still ONE gift — only its amount moved
    const gift = await run(s.t, (ctx) => ctx.db.get(s.giftId));
    expect(gift?.editedBy).toBe(s.userId);
    expect(gift?.editedAt).toBeGreaterThan(0);
  });

  test("split rows inherit the lump's fund, budget and status", async () => {
    const s = await setup();
    await s.t.mutation(internal.gear2024Split.runGear2024Split, { editedBy: s.userId, execute: true });
    const rows = await chapterTxns(s);
    for (const r of rows) {
      expect(r.fundId).toBe(s.fundId);
      expect(r.budgetId).toBe(s.budgetId);
      expect(r.status).toBe("categorized");
    }
  });

  test("second execute run is idempotent", async () => {
    const s = await setup();
    await s.t.mutation(internal.gear2024Split.runGear2024Split, { editedBy: s.userId, execute: true });
    const again = await s.t.mutation(internal.gear2024Split.runGear2024Split, {
      editedBy: s.userId,
      execute: true,
    });
    expect(again.counts.inserted).toBe(0);
    expect(again.counts.alreadyPresent).toBe(18);
    expect(again.counts.lumpDeleted).toBe(false);
    expect(again.counts.giftRestated).toBe(false);
    expect(await chapterTxns(s)).toHaveLength(18);
  });

  test("a resumed run inherits coding from a prior split row when the lump is gone", async () => {
    const s = await setup();
    await s.t.mutation(internal.gear2024Split.runGear2024Split, { editedBy: s.userId, execute: true });
    // Simulate a run that died partway: drop half the split rows, lump already gone.
    await run(s.t, async (ctx) => {
      const rows = await ctx.db
        .query("transactions")
        .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", s.chapterId))
        .collect();
      for (const r of rows.slice(0, 9)) await ctx.db.delete(r._id);
    });
    const res = await s.t.mutation(internal.gear2024Split.runGear2024Split, {
      editedBy: s.userId,
      execute: true,
    });
    expect(res.counts.inserted).toBe(9);
    expect(res.counts.alreadyPresent).toBe(9);
    const rows = await chapterTxns(s);
    expect(rows).toHaveLength(18);
    for (const r of rows) expect(r.budgetId).toBe(s.budgetId);
  });

  test("refuses to split the expense leg when the mirrored gift is missing", async () => {
    const s = await setup({ withGift: false });
    await expect(
      s.t.mutation(internal.gear2024Split.runGear2024Split, { editedBy: s.userId, execute: true }),
    ).rejects.toThrow(/GIFT_NOT_FOUND|not found/);
    // Nothing moved — the lump is still the only row.
    expect(await chapterTxns(s)).toHaveLength(1);
  });

  test("throws when there is no lump and no split row to inherit coding from", async () => {
    const s = await setup({ withLump: false });
    await expect(
      s.t.mutation(internal.gear2024Split.runGear2024Split, { editedBy: s.userId, execute: true }),
    ).rejects.toThrow(/NO_ATTRIBUTION_SOURCE|nothing to inherit/);
  });
});

describe("attachGear2024Receipts", () => {
  /** Split first (the attach runner resolves rows by the ids the split creates),
   *  then hand it a storage blob per order. */
  async function splitThenUpload(s: Setup, orderRefs: string[]) {
    await s.t.mutation(internal.gear2024Split.runGear2024Split, { editedBy: s.userId, execute: true });
    const uploads = [];
    for (const orderRef of orderRefs) {
      const storageId = await storeBlob(s.t);
      uploads.push({ orderRef, storageId, filename: `${orderRef}.png` });
    }
    return uploads;
  }

  test("creates and links a receipt per order, and reconciles nothing it shouldn't", async () => {
    const s = await setup();
    const refs = GEAR_2024_ORDER_ROWS.map((r) => r.orderRef);
    const uploads = await splitThenUpload(s, refs);

    const res = await s.t.mutation(internal.gear2024Split.attachGear2024Receipts, {
      uploads,
      execute: true,
    });
    expect(res.attached).toBe(18);
    expect(res.alreadyLinked).toBe(0);
    expect(res.unmatched).toEqual([]);

    const rows = await chapterTxns(s);
    expect(rows.every((r) => r.receiptStorageId != null)).toBe(true);

    const receipts = await run(s.t, (ctx) => ctx.db.query("receipts").collect());
    expect(receipts).toHaveLength(18);
    for (const r of receipts) {
      expect(r.source).toBe("upload");
      expect(r.linkCount).toBe(1);
      // Canonical + provenance seeded from the ORDER, which a human read off the
      // document — never a fabricated total.
      expect(r.amountCents).toBeGreaterThan(0);
      expect(r.ocrModel).toBe("manual-backfill:gear2024");
      expect(new Date(r.receiptDate!).getUTCFullYear()).toBe(2024);
    }
    const links = await run(s.t, (ctx) => ctx.db.query("receiptLinks").collect());
    expect(links).toHaveLength(18);
    expect(links.every((l) => l.source === "backfill")).toBe(true);

    // Each receipt's amount matches its own order, not just "some" order.
    const byExternalId = new Map(rows.map((r) => [r.externalId!, r]));
    for (const row of GEAR_2024_ORDER_ROWS) {
      const txn = byExternalId.get(gear2024ExternalId(row.orderRef))!;
      const receipt = receipts.find((rc) => rc.storageId === txn.receiptStorageId)!;
      expect(receipt.amountCents).toBe(row.amountCents);
      expect(receipt.merchant).toBe(row.merchant);
    }
  });

  test("dry run writes no receipts", async () => {
    const s = await setup();
    const uploads = await splitThenUpload(s, ["114-9890645-7982630"]);
    const res = await s.t.mutation(internal.gear2024Split.attachGear2024Receipts, {
      uploads,
    });
    expect(res.dryRun).toBe(true);
    expect(res.attached).toBe(1);
    expect(await run(s.t, (ctx) => ctx.db.query("receipts").collect())).toHaveLength(0);
  });

  test("skips a transaction that already carries a receipt", async () => {
    const s = await setup();
    const uploads = await splitThenUpload(s, ["114-9890645-7982630"]);
    await s.t.mutation(internal.gear2024Split.attachGear2024Receipts, {
      uploads,
      execute: true,
    });
    const again = await s.t.mutation(internal.gear2024Split.attachGear2024Receipts, {
      uploads,
      execute: true,
    });
    expect(again.attached).toBe(0);
    expect(again.alreadyLinked).toBe(1);
    expect(await run(s.t, (ctx) => ctx.db.query("receipts").collect())).toHaveLength(1);
  });

  test("reports an unknown order ref instead of throwing", async () => {
    const s = await setup();
    const uploads = await splitThenUpload(s, ["114-9890645-7982630"]);
    const storageId = uploads[0].storageId;
    const res = await s.t.mutation(internal.gear2024Split.attachGear2024Receipts, {
      uploads: [...uploads, { orderRef: "not-an-order", storageId, filename: "x.png" }],
      execute: true,
    });
    expect(res.attached).toBe(1);
    expect(res.unmatched).toEqual(["not-an-order"]);
  });
});
