/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter } from "./setup.helpers";
import { internal } from "../_generated/api";
import { NEW_YORK_CHAPTER_SLUG } from "../lib/seed/historical/mapping";
import type { Id } from "../_generated/dataModel";

/**
 * `upsertSales` re-visiting a charge it has already imported.
 *
 * THE DEFECT THIS SUITE EXISTS TO PREVENT is double-counted revenue — the single most
 * common way this codebase has broken money. The sync is idempotent on
 * `stripeChargeId`, and adding the ability to WRITE to an existing row is exactly the
 * kind of change that quietly turns "skip it" into "insert it again". So the assertions
 * below are about what must NOT move: one row per charge, forever, with its gross, its
 * fee, its timestamp and its event untouched by any number of re-runs.
 *
 * The second property is that enrichment is one-directional. A run that resolves LESS
 * than a previous run (Stripe unreachable, a price deleted) must leave the row alone
 * rather than replacing a good breakdown with a blank — otherwise a nightly sync would
 * slowly erode the very data it was added to supply.
 *
 * The fixture is the real thing: the five 2026-08-08 charges that sit in production
 * today with `itemSource: "unresolved"` and $170 of tee money already correctly booked.
 */

const CHARGES = [
  { id: "ch_3U2GadQv9S5xW6eK06WCzxum", gross: 3000, fee: 122, tee: true },
  { id: "ch_3U2G9CQv9S5xW6eK14uuL8gg", gross: 3000, fee: 122, tee: true },
  { id: "ch_3U2FKMQv9S5xW6eK1QRdmRG7", gross: 3000, fee: 122, tee: true },
  { id: "ch_3U2EgzQv9S5xW6eK00dIIcJ9", gross: 5000, fee: 200, tee: false },
  { id: "ch_3U2EgHQv9S5xW6eK1uZ52Ctz", gross: 3000, fee: 122, tee: true },
] as const;

const SOLD_AT = Date.UTC(2026, 7, 8, 20, 11, 35);
const TEE_ITEM = {
  label: "PW Tee",
  quantity: 1,
  unitPriceCents: 3000,
  candidates: ["PW Tee"],
};

/** What a fresh sync would hand `upsertSales` for that day, now that it reads the
 *  charges' own evidence: four tees named by Stripe, one still unlabelled. */
const rowsFromStripe = () =>
  CHARGES.map((c, i) => ({
    stripeChargeId: c.id,
    soldAt: SOLD_AT + i * 1000,
    grossCents: c.gross,
    feeCents: c.fee,
    dayISO: "2026-08-08",
    eventName: null,
    items: c.tee ? [TEE_ITEM] : [],
    itemSource: (c.tee ? "stripe_line_items" : "unresolved") as
      | "stripe_line_items"
      | "unresolved",
  }));

async function seedUnresolvedSales(t: ReturnType<typeof newT>) {
  const s = await setupChapter(t);
  await run(t, async (ctx) => {
    await ctx.db.patch(s.chapterId, { slug: NEW_YORK_CHAPTER_SLUG });
    // The rows exactly as production holds them: revenue right, breakdown missing.
    for (const [i, c] of CHARGES.entries()) {
      await ctx.db.insert("sales", {
        chapterId: s.chapterId,
        stripeChargeId: c.id,
        soldAt: SOLD_AT + i * 1000,
        grossCents: c.gross,
        feeCents: c.fee,
        items: [],
        itemSource: "unresolved",
        channel: "in_person",
        createdAt: Date.now(),
      });
    }
  });
  return s;
}

const allSales = (t: ReturnType<typeof newT>) =>
  run(t, (ctx) => ctx.db.query("sales").collect());

describe("upsertSales — a re-run enriches, it never re-imports", () => {
  test("the five sales stay five, and every cent stays where it was", async () => {
    const t = newT();
    await seedUnresolvedSales(t);
    const before = await allSales(t);

    const r = await t.mutation(internal.salesSync.upsertSales, {
      rows: rowsFromStripe(),
      execute: true,
    });

    expect(r.created).toBe(0);
    expect(r.alreadyPresent).toBe(5);
    expect(r.enriched).toBe(4);
    // Nothing was IMPORTED, so this run brought in no money — the counters that report
    // "what a run adds to the books" must read zero even though four rows changed.
    expect(r.grossCents).toBe(0);
    expect(r.feeCents).toBe(0);

    const after = await allSales(t);
    expect(after).toHaveLength(5);
    expect(after.reduce((a, s) => a + s.grossCents, 0)).toBe(17000);
    expect(after.reduce((a, s) => a + s.feeCents, 0)).toBe(688);

    // Field by field: the ONLY things allowed to differ are items and itemSource.
    for (const b of before) {
      const a = after.find((s) => s._id === b._id)!;
      expect(a.stripeChargeId).toBe(b.stripeChargeId);
      expect(a.grossCents).toBe(b.grossCents);
      expect(a.feeCents).toBe(b.feeCents);
      expect(a.soldAt).toBe(b.soldAt);
      expect(a.chapterId).toBe(b.chapterId);
      expect(a.eventId).toBe(b.eventId);
      expect(a.channel).toBe(b.channel);
      expect(a.createdAt).toBe(b.createdAt);
    }
  });

  test("the four tees gain their breakdown; the $50 stays honestly blank", async () => {
    const t = newT();
    await seedUnresolvedSales(t);
    await t.mutation(internal.salesSync.upsertSales, {
      rows: rowsFromStripe(),
      execute: true,
    });

    const after = await allSales(t);
    const tees = after.filter((s) => s.itemSource === "stripe_line_items");
    expect(tees).toHaveLength(4);
    for (const s of tees) {
      expect(s.items).toEqual([TEE_ITEM]);
      // Each line still adds back to exactly what the customer paid.
      expect(s.items.reduce((a, i) => a + i.quantity * i.unitPriceCents, 0)).toBe(s.grossCents);
    }

    const blank = after.filter((s) => s.itemSource === "unresolved");
    expect(blank).toHaveLength(1);
    expect(blank[0].grossCents).toBe(5000);
    expect(blank[0].items).toEqual([]);
  });

  test("a dry run reports the enrichment it would do and writes nothing", async () => {
    const t = newT();
    await seedUnresolvedSales(t);

    const r = await t.mutation(internal.salesSync.upsertSales, { rows: rowsFromStripe() });
    expect(r.enriched).toBe(4);
    expect(r.created).toBe(0);

    const after = await allSales(t);
    expect(after.every((s) => s.itemSource === "unresolved")).toBe(true);
    expect(after.every((s) => s.items.length === 0)).toBe(true);
  });

  test("running it twice changes nothing the second time", async () => {
    const t = newT();
    await seedUnresolvedSales(t);
    await t.mutation(internal.salesSync.upsertSales, { rows: rowsFromStripe(), execute: true });
    const once = await allSales(t);

    const second = await t.mutation(internal.salesSync.upsertSales, {
      rows: rowsFromStripe(),
      execute: true,
    });
    expect(second.created).toBe(0);
    // Already at the top of the ladder — there is nothing left to improve.
    expect(second.enriched).toBe(0);

    const twice = await allSales(t);
    expect(twice).toHaveLength(5);
    expect(twice.map((s) => s.grossCents).sort()).toEqual(once.map((s) => s.grossCents).sort());
  });

  test("a WORSE reading cannot overwrite a good breakdown", async () => {
    // Stripe unreachable on a later run, or a price since deleted: the sync falls back
    // to `unresolved` for a charge it previously itemised. The row must not lose what
    // it already knows.
    const t = newT();
    await seedUnresolvedSales(t);
    await t.mutation(internal.salesSync.upsertSales, { rows: rowsFromStripe(), execute: true });

    const degraded = rowsFromStripe().map((r) => ({
      ...r,
      items: [],
      itemSource: "unresolved" as const,
    }));
    const r = await t.mutation(internal.salesSync.upsertSales, {
      rows: degraded,
      execute: true,
    });
    expect(r.enriched).toBe(0);

    const after = await allSales(t);
    expect(after.filter((s) => s.itemSource === "stripe_line_items")).toHaveLength(4);
  });

  test("a decomposed guess is upgraded when Stripe later names the product", async () => {
    // The Eden case: rows imported by the old amount-only path carry a price-point
    // reading. When a re-sync finds the charge's own price id, the better evidence wins.
    const t = newT();
    const s = await setupChapter(t);
    let saleId!: Id<"sales">;
    await run(t, async (ctx) => {
      await ctx.db.patch(s.chapterId, { slug: NEW_YORK_CHAPTER_SLUG });
      saleId = await ctx.db.insert("sales", {
        chapterId: s.chapterId,
        stripeChargeId: "ch_eden_guess",
        soldAt: SOLD_AT,
        grossCents: 3000,
        feeCents: 122,
        items: [{ label: "$30 item", quantity: 1, unitPriceCents: 3000, candidates: ["PW Tee", "Hoodie"] }],
        itemSource: "amount_decomposition",
        channel: "in_person",
        createdAt: Date.now(),
      });
    });

    const r = await t.mutation(internal.salesSync.upsertSales, {
      rows: [
        {
          stripeChargeId: "ch_eden_guess",
          soldAt: SOLD_AT,
          grossCents: 3000,
          feeCents: 122,
          dayISO: "2026-08-08",
          eventName: null,
          items: [TEE_ITEM],
          itemSource: "stripe_line_items" as const,
        },
      ],
      execute: true,
    });
    expect(r.enriched).toBe(1);

    const after = await run(t, (ctx) => ctx.db.get(saleId));
    expect(after!.itemSource).toBe("stripe_line_items");
    // The ambiguous two-candidate line is replaced by the product Stripe named.
    expect(after!.items).toEqual([TEE_ITEM]);
    expect(after!.grossCents).toBe(3000);
    expect(after!.feeCents).toBe(122);
  });
});
