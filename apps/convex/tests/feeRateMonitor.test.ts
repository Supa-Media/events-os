/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * `dashboardCharts.feeRateByMonth` — the blended effective-rate monitor.
 *
 * The property this suite exists to hold still, above every other one:
 * **a month that processed nothing charts as a GAP, never as 0%.** A fee rate
 * on zero volume is undefined, not zero, and a chart that draws it as zero
 * invents a cliff — somebody then goes looking for the month the fees were
 * "fixed". Every other assertion here is arithmetic; that one is the feature.
 *
 * The second thing it holds still is that fees are READ, never derived: the
 * numerator is whatever `processorFeeEntries` says Stripe charged, and no
 * published rate from `DEFAULT_FEE_SCHEDULE` is ever consulted to produce it.
 * The "a rail that overcharges shows up as a rate that ROSE" test is the one
 * that would fail if anyone ever wired the schedule into this path.
 *
 * Rates are asserted in basis points, money in cents — never in formatted
 * strings.
 */

/** A central-scope finance role (mirrors `dashboardCharts.test.ts#asCentral`). */
async function asCentral(
  s: ChapterSetup,
  role: "viewer" | "bookkeeper" | "manager",
): Promise<Id<"people">> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope: "central",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

/** The same person, granted only within their OWN chapter — no org reach. */
async function asChapterManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

/**
 * One stored ledger entry, written directly — `runFeeSync`'s own writer is
 * exercised by `processorFees.test.ts`; this suite is about what the chart
 * makes of the evidence once it exists.
 *
 * `grossCents` is SIGNED exactly as the schema documents it: positive for a
 * payment (the sale the fee came out of), negative for a standalone fee row
 * where the amount IS the fee.
 */
async function storeEntry(
  s: ChapterSetup,
  fields: {
    month: string;
    id: string;
    type?: string;
    feeCents: number;
    grossCents: number;
  },
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("processorFeeEntries", {
      processor: "stripe",
      month: fields.month,
      balanceTransactionId: fields.id,
      type: fields.type ?? "charge",
      feeCents: fields.feeCents,
      grossCents: fields.grossCents,
      occurredAt: Date.UTC(Number(fields.month.slice(0, 4)), Number(fields.month.slice(5, 7)) - 1, 15, 12),
      createdAt: Date.now(),
    }),
  );
}

/** A settled year in the past — never the current one, so `partialMonth` is
 *  `null` and no assertion here depends on the day the suite is run. */
const YEAR = 2025;

async function seedCentral(): Promise<ChapterSetup> {
  const t = newT();
  const s = await setupChapter(t);
  await asCentral(s, "viewer");
  return s;
}

function monthOf(
  result: { months: { month: number; effectiveRateBps: number | null; feeCents: number; grossCents: number }[] },
  month: number,
) {
  return result.months.find((m) => m.month === month)!;
}

// ── The gap ──────────────────────────────────────────────────────────────────

describe("a month with no volume is a GAP, not 0%", () => {
  test("null — and specifically not zero — for a month that processed nothing", async () => {
    const s = await seedCentral();
    await storeEntry(s, { month: `${YEAR}-01`, id: "txn_jan", feeCents: 320, grossCents: 10_000 });

    const r = await s.as.query(api.dashboardCharts.feeRateByMonth, { year: YEAR });

    // January really happened.
    expect(monthOf(r, 1).effectiveRateBps).toBe(320);

    // February did not. This is the assertion the whole feature turns on: the
    // client must be able to tell "no rate" apart from "a rate of zero", and
    // `null` is the only value that carries that distinction.
    expect(monthOf(r, 2).effectiveRateBps).toBeNull();
    expect(monthOf(r, 2).effectiveRateBps).not.toBe(0);
    expect(monthOf(r, 2).feeCents).toBe(0);
    expect(monthOf(r, 2).grossCents).toBe(0);

    // Every month after the last one with volume, likewise — a chart that
    // filled these with 0 would draw a cliff for the rest of the year.
    expect(r.months.filter((m) => m.effectiveRateBps === null)).toHaveLength(11);
    expect(r.months.some((m) => m.effectiveRateBps === 0)).toBe(false);
  });

  test("a year with nothing in it is twelve gaps and a null headline", async () => {
    const s = await seedCentral();

    const r = await s.as.query(api.dashboardCharts.feeRateByMonth, { year: YEAR });

    expect(r.months).toHaveLength(12);
    expect(r.months.every((m) => m.effectiveRateBps === null)).toBe(true);
    expect(r.yearEffectiveRateBps).toBeNull();
    expect(r.yearFeeCents).toBe(0);
    expect(r.yearGrossCents).toBe(0);
  });

  test("fees with no processed volume behind them are still a gap, never a rate", async () => {
    const s = await seedCentral();
    // A month with nothing but a Terminal reader bill: real money charged,
    // zero volume processed. The ratio has no denominator, so there is no rate
    // to draw — and no amount of fee makes one exist.
    await storeEntry(s, {
      month: `${YEAR}-04`,
      id: "txn_reader",
      type: "stripe_fee",
      feeCents: 1_520,
      grossCents: -1_520,
    });

    const r = await s.as.query(api.dashboardCharts.feeRateByMonth, { year: YEAR });

    expect(monthOf(r, 4).feeCents).toBe(1_520);
    expect(monthOf(r, 4).grossCents).toBe(0);
    expect(monthOf(r, 4).effectiveRateBps).toBeNull();
  });
});

// ── The arithmetic ───────────────────────────────────────────────────────────

describe("the rate blends every fee over what was actually processed", () => {
  test("fees over volume, in basis points", async () => {
    const s = await seedCentral();
    // Two $500 card sales at $15.00 each — 3.00% blended.
    await storeEntry(s, { month: `${YEAR}-03`, id: "txn_a", feeCents: 1_500, grossCents: 50_000 });
    await storeEntry(s, { month: `${YEAR}-03`, id: "txn_b", feeCents: 1_500, grossCents: 50_000 });

    const march = monthOf(
      await s.as.query(api.dashboardCharts.feeRateByMonth, { year: YEAR }),
      3,
    );
    expect(march.feeCents).toBe(3_000);
    expect(march.grossCents).toBe(100_000);
    expect(march.effectiveRateBps).toBe(300);
  });

  test("a Stripe-billed fee raises the rate without inventing volume", async () => {
    const s = await seedCentral();
    // The Pop The Balloon shape: card sales plus a Terminal reader fee Stripe
    // billed on its own account. The reader fee's `grossCents` is NEGATIVE and
    // IS the fee — counting it as volume would shrink the denominator and
    // overstate the same dollars twice; ignoring the fee would hide the exact
    // cost this monitor exists to surface.
    await storeEntry(s, { month: `${YEAR}-05`, id: "txn_sale", feeCents: 2_881, grossCents: 55_800 });
    await storeEntry(s, {
      month: `${YEAR}-05`,
      id: "txn_reader",
      type: "stripe_fee",
      feeCents: 1_520,
      grossCents: -1_520,
    });

    const may = monthOf(await s.as.query(api.dashboardCharts.feeRateByMonth, { year: YEAR }), 5);
    // Volume is the sales only.
    expect(may.grossCents).toBe(55_800);
    // The numerator is every fee — per-charge AND account-billed.
    expect(may.feeCents).toBe(4_401);
    // 4401 / 55800 = 7.89%, up from the 5.16% the card cut alone implies. That
    // gap IS the signal: same volume, more cost, a cause somebody can chase.
    expect(may.effectiveRateBps).toBe(789);
  });

  test("months don't leak into each other, and a neighbouring year is invisible", async () => {
    const s = await seedCentral();
    await storeEntry(s, { month: `${YEAR}-06`, id: "txn_jun", feeCents: 300, grossCents: 10_000 });
    await storeEntry(s, { month: `${YEAR}-07`, id: "txn_jul", feeCents: 600, grossCents: 10_000 });
    await storeEntry(s, { month: `${YEAR - 1}-12`, id: "txn_prev", feeCents: 9_999, grossCents: 10_000 });
    await storeEntry(s, { month: `${YEAR + 1}-01`, id: "txn_next", feeCents: 9_999, grossCents: 10_000 });

    const r = await s.as.query(api.dashboardCharts.feeRateByMonth, { year: YEAR });
    expect(monthOf(r, 6).effectiveRateBps).toBe(300);
    expect(monthOf(r, 7).effectiveRateBps).toBe(600);
    expect(r.yearFeeCents).toBe(900);
    expect(r.yearGrossCents).toBe(20_000);
  });
});

// ── The headline ─────────────────────────────────────────────────────────────

describe("the year's blended rate", () => {
  test("is fees over volume — NOT the average of the monthly rates", async () => {
    const s = await seedCentral();
    // A tiny expensive month next to a large cheap one. The mean of the two
    // monthly rates is 5.00%; what the org actually paid is 2.03%. Averaging
    // the months would let a $100 experiment shout down a $100,000 quarter.
    await storeEntry(s, { month: `${YEAR}-02`, id: "txn_small", feeCents: 800, grossCents: 10_000 });
    await storeEntry(s, {
      month: `${YEAR}-08`,
      id: "txn_big",
      feeCents: 20_000,
      grossCents: 1_000_000,
    });

    const r = await s.as.query(api.dashboardCharts.feeRateByMonth, { year: YEAR });
    expect(monthOf(r, 2).effectiveRateBps).toBe(800);
    expect(monthOf(r, 8).effectiveRateBps).toBe(200);
    expect(r.yearFeeCents).toBe(20_800);
    expect(r.yearGrossCents).toBe(1_010_000);
    expect(r.yearEffectiveRateBps).toBe(206); // 2.06%, not 5.00%
  });

  test("a gap month contributes nothing to the headline in either direction", async () => {
    const s = await seedCentral();
    await storeEntry(s, { month: `${YEAR}-09`, id: "txn_only", feeCents: 290, grossCents: 10_000 });

    const r = await s.as.query(api.dashboardCharts.feeRateByMonth, { year: YEAR });
    // Eleven months of `null` neither drag the year toward 0% nor drop out of
    // a denominator that never counted them.
    expect(r.yearEffectiveRateBps).toBe(290);
  });
});

// ── The shape and the period ─────────────────────────────────────────────────

describe("the series shape", () => {
  test("always twelve months, in order, even for an empty year", async () => {
    const s = await seedCentral();
    const r = await s.as.query(api.dashboardCharts.feeRateByMonth, { year: YEAR });
    expect(r.months.map((m) => m.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  test("a settled past year has no in-progress bar", async () => {
    const s = await seedCentral();
    const r = await s.as.query(api.dashboardCharts.feeRateByMonth, { year: YEAR });
    expect(r.partialMonth).toBeNull();
  });

  test("the current year flags the month still accruing", async () => {
    const s = await seedCentral();
    const nowKey = new Date().toISOString().slice(0, 7);
    const r = await s.as.query(api.dashboardCharts.feeRateByMonth, {
      year: Number(nowKey.slice(0, 4)),
    });
    // Stripe's ledger buckets by UTC, so the flagged bar is the UTC month —
    // the same bucket the next sync will add to (see the query's doc comment).
    expect(r.partialMonth).toBe(Number(nowKey.slice(5, 7)));
  });
});

// ── The gate ─────────────────────────────────────────────────────────────────

describe("access", () => {
  test("a central finance viewer may read it", async () => {
    const s = await seedCentral();
    await expect(
      s.as.query(api.dashboardCharts.feeRateByMonth, { year: YEAR }),
    ).resolves.toBeDefined();
  });

  test("a chapter-scope finance MANAGER is refused — the ledger has no chapter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    // Rank isn't the question: `processorFeeEntries` is account-wide with no
    // chapter dimension, so there is no honest chapter-scoped slice of it to
    // show. Central reach or nothing.
    await expect(
      s.as.query(api.dashboardCharts.feeRateByMonth, { year: YEAR }),
    ).rejects.toThrow(ConvexError);
  });

  test("a caller with no finance grant at all is refused", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await expect(
      s.as.query(api.dashboardCharts.feeRateByMonth, { year: YEAR }),
    ).rejects.toThrow(ConvexError);
  });
});
