/// <reference types="vite/client" />
import { afterEach, describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { NEW_YORK_CHAPTER_SLUG } from "../lib/seed/historical/mapping";
import { feeBudgetNotes } from "../processorFees";

/**
 * Processor fees — the monthly Stripe fee row, its evidence, and its budget.
 *
 * The three things this suite exists to hold still, all of them owner
 * complaints from 2026-08-08:
 *  1. the row must never be dated in the future,
 *  2. the figure must be checkable — the stored entries have to ADD UP to it,
 *  3. it must find its way into a budget without anyone bypassing approval.
 *
 * Money math is asserted in cents, never in formatted strings.
 */

type NySetup = ChapterSetup & {
  fundId: Id<"funds">;
  categoryId: Id<"budgetCategories">;
};

/**
 * The NY chapter as `upsertFeeRows` expects to find it: resolved by SLUG (which
 * `setupChapter` doesn't set) and carrying the seeded "Bank & Fees" category
 * under a General Fund.
 */
async function seedNy(): Promise<NySetup> {
  const t = newT();
  const s = await setupChapter(t);
  const ids = await run(t, async (ctx) => {
    await ctx.db.patch(s.chapterId, { slug: NEW_YORK_CHAPTER_SLUG });
    const fundId = await ctx.db.insert("funds", {
      chapterId: s.chapterId,
      name: "General Fund",
      restriction: "unrestricted",
      sortOrder: 0,
      isActive: true,
      createdAt: Date.now(),
    });
    const categoryId = await ctx.db.insert("budgetCategories", {
      chapterId: s.chapterId,
      fundId,
      name: "Bank & Fees",
      kind: "category",
      sortOrder: 0,
      isActive: true,
      createdAt: Date.now(),
    });
    return { fundId, categoryId };
  });
  return { ...s, ...ids };
}

/** A finance-graded caller (roster person + grant), for the read-side query. */
async function grantFinance(
  s: ChapterSetup,
  role: "viewer" | "bookkeeper" | "manager",
): Promise<Id<"people">> {
  return await run(s.t, async (ctx) => {
    const personId = await ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    });
    await ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope: "chapter",
      createdAt: Date.now(),
    });
    return personId;
  });
}

/** Last day of `month` (YYYY-MM) at UTC noon — a CLOSED month's posting date. */
function monthEnd(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return Date.UTC(y, m, 0, 12);
}

function entry(
  id: string,
  type: string,
  feeCents: number,
  opts: { grossCents?: number; sourceId?: string; description?: string } = {},
) {
  return {
    balanceTransactionId: id,
    type,
    feeCents,
    grossCents: opts.grossCents ?? 0,
    occurredAt: Date.UTC(2026, 6, 15, 12),
    ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
    ...(opts.description ? { description: opts.description } : {}),
  };
}

/** One closed month: $50.00 of fees over three ledger entries. */
const JULY = {
  month: "2026-07",
  feeCents: 5000,
  entryCount: 3,
  byType: [
    { type: "charge", feeCents: 3000, count: 2 },
    { type: "stripe_fee", feeCents: 2000, count: 1 },
  ],
  postedAt: monthEnd("2026-07"),
};

const JULY_ENTRIES = [
  entry("txn_a", "charge", 1500, { grossCents: 50000, sourceId: "ch_a" }),
  entry("txn_b", "charge", 1500, { grossCents: 50000, sourceId: "ch_b" }),
  entry("txn_c", "stripe_fee", 2000, {
    grossCents: -2000,
    description: "Terminal reader fee",
  }),
];

async function feeRow(s: ChapterSetup, month: string) {
  return await run(s.t, async (ctx) =>
    ctx.db
      .query("transactions")
      .withIndex("by_external_id", (q) => q.eq("externalId", `stripe-fees:${month}`))
      .first(),
  );
}

async function budgets(s: ChapterSetup) {
  return await run(s.t, (ctx) => ctx.db.query("budgets").collect());
}

// ── The evidence table ───────────────────────────────────────────────────────

describe("upsertFeeEntries", () => {
  test("a dry run writes nothing", async () => {
    const s = await seedNy();
    const r = await s.t.mutation(internal.processorFees.upsertFeeEntries, {
      month: "2026-07",
      entries: JULY_ENTRIES,
    });
    expect(r).toEqual({ inserted: 0, updated: 0, removed: 0 });
    const stored = await run(s.t, (ctx) => ctx.db.query("processorFeeEntries").collect());
    expect(stored).toHaveLength(0);
  });

  test("inserts once, then re-reads are no-ops", async () => {
    const s = await seedNy();
    const first = await s.t.mutation(internal.processorFees.upsertFeeEntries, {
      month: "2026-07",
      entries: JULY_ENTRIES,
      execute: true,
    });
    expect(first).toEqual({ inserted: 3, updated: 0, removed: 0 });

    const second = await s.t.mutation(internal.processorFees.upsertFeeEntries, {
      month: "2026-07",
      entries: JULY_ENTRIES,
      execute: true,
    });
    expect(second).toEqual({ inserted: 0, updated: 0, removed: 0 });

    const stored = await run(s.t, (ctx) => ctx.db.query("processorFeeEntries").collect());
    expect(stored).toHaveLength(3);
    expect(stored.every((e) => e.processor === "stripe" && e.month === "2026-07")).toBe(true);
    expect(stored.find((e) => e.balanceTransactionId === "txn_a")?.sourceId).toBe("ch_a");
    expect(stored.find((e) => e.balanceTransactionId === "txn_c")?.description).toBe(
      "Terminal reader fee",
    );
  });

  test("a month is REPLACED, so an entry the sweep no longer sees is dropped", async () => {
    const s = await seedNy();
    await s.t.mutation(internal.processorFees.upsertFeeEntries, {
      month: "2026-07",
      entries: JULY_ENTRIES,
      execute: true,
    });
    // The sweep now reports only two of the three, and one has a corrected fee.
    const r = await s.t.mutation(internal.processorFees.upsertFeeEntries, {
      month: "2026-07",
      entries: [
        entry("txn_a", "charge", 1600, { grossCents: 50000, sourceId: "ch_a" }),
        JULY_ENTRIES[1],
      ],
      execute: true,
    });
    expect(r).toEqual({ inserted: 0, updated: 1, removed: 1 });
    const stored = await run(s.t, (ctx) => ctx.db.query("processorFeeEntries").collect());
    expect(stored.map((e) => e.balanceTransactionId).sort()).toEqual(["txn_a", "txn_b"]);
    expect(stored.reduce((sum, e) => sum + e.feeCents, 0)).toBe(3100);
  });

  test("months don't leak into each other", async () => {
    const s = await seedNy();
    await s.t.mutation(internal.processorFees.upsertFeeEntries, {
      month: "2026-06",
      entries: [entry("txn_june", "charge", 900)],
      execute: true,
    });
    await s.t.mutation(internal.processorFees.upsertFeeEntries, {
      month: "2026-07",
      entries: JULY_ENTRIES,
      execute: true,
    });
    const stored = await run(s.t, (ctx) => ctx.db.query("processorFeeEntries").collect());
    expect(stored.filter((e) => e.month === "2026-06")).toHaveLength(1);
    expect(stored.filter((e) => e.month === "2026-07")).toHaveLength(3);
  });
});

// ── The monthly row ──────────────────────────────────────────────────────────

describe("upsertFeeRows — the row", () => {
  test("books one row whose note carries the per-type breakdown", async () => {
    const s = await seedNy();
    const r = await s.t.mutation(internal.processorFees.upsertFeeRows, {
      months: [JULY],
      execute: true,
    });
    expect(r.created).toBe(1);
    expect(r.totalFeeCents).toBe(5000);

    const row = await feeRow(s, "2026-07");
    expect(row?.amountCents).toBe(5000);
    expect(row?.postedAt).toBe(monthEnd("2026-07"));
    expect(row?.categoryId).toBe(s.categoryId);
    // The breakdown is the whole point — a treasurer must be able to read what
    // the figure is made of without opening anything.
    expect(row?.note).toContain("card processing $30.00 (2)");
    expect(row?.note).toContain("Stripe-billed fees $20.00 (1)");
    expect(row?.note).toContain("3 ledger entries");
  });

  test("a re-run with the same sweep changes nothing", async () => {
    const s = await seedNy();
    await s.t.mutation(internal.processorFees.upsertFeeRows, { months: [JULY], execute: true });
    const again = await s.t.mutation(internal.processorFees.upsertFeeRows, {
      months: [JULY],
      execute: true,
    });
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
  });

  test("a row written before the breakdown existed has its note refreshed", async () => {
    const s = await seedNy();
    await s.t.mutation(internal.processorFees.upsertFeeRows, { months: [JULY], execute: true });
    const row = await feeRow(s, "2026-07");
    await run(s.t, (ctx) => ctx.db.patch(row!._id, { note: "Stripe fees for 2026-07, across 3 balance-transaction entries." }));

    const r = await s.t.mutation(internal.processorFees.upsertFeeRows, {
      months: [JULY],
      execute: true,
    });
    expect(r.updated).toBe(1);
    expect((await feeRow(s, "2026-07"))?.note).toContain("card processing $30.00 (2)");
  });

  test("a month with no fees books nothing", async () => {
    const s = await seedNy();
    const r = await s.t.mutation(internal.processorFees.upsertFeeRows, {
      months: [{ ...JULY, feeCents: 0, entryCount: 0, byType: [] }],
      execute: true,
    });
    expect(r).toMatchObject({ created: 0, totalFeeCents: 0 });
    expect(await feeRow(s, "2026-07")).toBeNull();
  });
});

// ── The budget ───────────────────────────────────────────────────────────────

describe("upsertFeeRows — the budget", () => {
  test("proposes a DRAFT yearly budget and refuses to attribute to it", async () => {
    const s = await seedNy();
    const r = await s.t.mutation(internal.processorFees.upsertFeeRows, {
      months: [JULY],
      execute: true,
    });
    expect(r.budgets).toEqual([
      { year: 2026, label: "Processor fees 2026", status: "draft", createdNow: true, attachedRows: 0 },
    ]);

    const [b] = await budgets(s);
    expect(b).toMatchObject({
      chapterId: s.chapterId,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      categoryId: s.categoryId,
      fundId: s.fundId,
      approvalStatus: "draft",
    });
    // Proposed at what the year has already cost, rounded up to $100.
    expect(b.amountCents).toBe(10_000);
    expect(b.createdBy).toBeUndefined();

    // A draft is a proposal, not authority — the row stays in Needs budget.
    expect((await feeRow(s, "2026-07"))?.budgetId).toBeUndefined();
  });

  test("attributes as soon as a human approves, and says how many rows moved", async () => {
    const s = await seedNy();
    await s.t.mutation(internal.processorFees.upsertFeeRows, { months: [JULY], execute: true });
    const [b] = await budgets(s);
    await run(s.t, (ctx) => ctx.db.patch(b._id, { approvalStatus: "approved" }));

    const r = await s.t.mutation(internal.processorFees.upsertFeeRows, {
      months: [JULY],
      execute: true,
    });
    expect(r.budgets[0]).toMatchObject({ status: "approved", createdNow: false, attachedRows: 1 });
    const row = await feeRow(s, "2026-07");
    expect(row?.budgetId).toBe(b._id);
    expect(row?.fundId).toBe(s.fundId);

    // And the next run has nothing left to do.
    const settled = await s.t.mutation(internal.processorFees.upsertFeeRows, {
      months: [JULY],
      execute: true,
    });
    expect(settled).toMatchObject({ unchanged: 1 });
    expect(settled.budgets[0].attachedRows).toBe(0);
  });

  test("adopts a treasurer's own yearly Bank & Fees budget rather than making a second", async () => {
    const s = await seedNy();
    const mine = await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 250_00,
        label: "Card fees",
        type: "recurring",
        cadence: "yearly",
        year: 2026,
        fundId: s.fundId,
        categoryId: s.categoryId,
        approvalStatus: "approved",
        createdAt: Date.now(),
      }),
    );
    const r = await s.t.mutation(internal.processorFees.upsertFeeRows, {
      months: [JULY],
      execute: true,
    });
    expect(await budgets(s)).toHaveLength(1);
    expect(r.budgets[0]).toMatchObject({ label: "Card fees", createdNow: false, attachedRows: 1 });
    expect((await feeRow(s, "2026-07"))?.budgetId).toBe(mine);
  });

  test("never argues with a cap a human set", async () => {
    const s = await seedNy();
    await s.t.mutation(internal.processorFees.upsertFeeRows, { months: [JULY], execute: true });
    const [b] = await budgets(s);
    await run(s.t, (ctx) => ctx.db.patch(b._id, { amountCents: 1_000_00 }));

    await s.t.mutation(internal.processorFees.upsertFeeRows, {
      months: [{ ...JULY, feeCents: 900_00 }],
      execute: true,
    });
    expect((await budgets(s))[0].amountCents).toBe(1_000_00);
  });

  test("never re-points a row somebody already coded elsewhere", async () => {
    const s = await seedNy();
    await s.t.mutation(internal.processorFees.upsertFeeRows, { months: [JULY], execute: true });
    const [b] = await budgets(s);
    await run(s.t, (ctx) => ctx.db.patch(b._id, { approvalStatus: "approved" }));

    const otherBudget = await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 100_00,
        label: "Somewhere else",
        type: "recurring",
        cadence: "yearly",
        year: 2026,
        approvalStatus: "approved",
        createdAt: Date.now(),
      }),
    );
    const row = await feeRow(s, "2026-07");
    await run(s.t, (ctx) => ctx.db.patch(row!._id, { budgetId: otherBudget }));

    await s.t.mutation(internal.processorFees.upsertFeeRows, { months: [JULY], execute: true });
    expect((await feeRow(s, "2026-07"))?.budgetId).toBe(otherBudget);
  });

  test("one budget per calendar year — a 2025 fee row can't count against 2026", async () => {
    const s = await seedNy();
    const june2025 = { ...JULY, month: "2025-06", postedAt: monthEnd("2025-06") };
    const r = await s.t.mutation(internal.processorFees.upsertFeeRows, {
      months: [june2025, JULY],
      execute: true,
    });
    expect(r.budgets.map((b) => b.year)).toEqual([2025, 2026]);
    expect(await budgets(s)).toHaveLength(2);
  });

  test("without a Bank & Fees category there is nothing to identify, so nothing is created", async () => {
    const s = await seedNy();
    await run(s.t, (ctx) => ctx.db.delete(s.categoryId));
    const r = await s.t.mutation(internal.processorFees.upsertFeeRows, {
      months: [JULY],
      execute: true,
    });
    expect(r.budgets).toEqual([]);
    expect(await budgets(s)).toHaveLength(0);
    expect(r.created).toBe(1);
  });

  test("a dry run proposes nothing", async () => {
    const s = await seedNy();
    const r = await s.t.mutation(internal.processorFees.upsertFeeRows, { months: [JULY] });
    expect(r.created).toBe(1);
    expect(await budgets(s)).toHaveLength(0);
    expect(await feeRow(s, "2026-07")).toBeNull();
  });
});

// ── The sweep ────────────────────────────────────────────────────────────────

describe("runFeeSync (mocked Stripe)", () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.STRIPE_SECRET_KEY;
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = realKey;
  });

  /** A minimal Response stand-in — the sweep only touches `ok` and `json`. */
  function jsonResponse(body: unknown): unknown {
    return { ok: true, status: 200, json: async () => body };
  }

  function mockLedger(data: Record<string, unknown>[]): void {
    process.env.STRIPE_SECRET_KEY = "sk_test_mock";
    globalThis.fetch = (async () =>
      jsonResponse({ data, has_more: false })) as unknown as typeof fetch;
  }

  const secs = (ms: number) => Math.floor(ms / 1000);

  test("the month's amount IS the sum of the entries it stores", async () => {
    const s = await seedNy();
    const july = Date.UTC(2026, 6, 10, 12);
    mockLedger([
      { id: "txn_1", type: "charge", amount: 50000, fee: 1500, created: secs(july), source: "ch_1" },
      { id: "txn_2", type: "charge", amount: 50000, fee: 1500, created: secs(july), source: "ch_2" },
      {
        id: "txn_3",
        type: "stripe_fee",
        amount: -2000,
        fee: 0,
        created: secs(july),
        description: "Terminal reader fee",
      },
      // Not a fee at all — a payout must never be counted as one.
      { id: "txn_4", type: "payout", amount: -90000, fee: 0, created: secs(july) },
    ]);

    const r = await s.t.action(internal.processorFees.syncStripeFeesOps, { execute: true });
    expect(r.totalFeeCents).toBe(5000);
    expect(r.entriesRecorded).toBe(3);

    const stored = await run(s.t, (ctx) => ctx.db.query("processorFeeEntries").collect());
    expect(stored.reduce((sum, e) => sum + e.feeCents, 0)).toBe(
      (await feeRow(s, "2026-07"))!.amountCents,
    );
    expect(stored.map((e) => e.balanceTransactionId).sort()).toEqual([
      "txn_1",
      "txn_2",
      "txn_3",
    ]);
    expect(stored.find((e) => e.balanceTransactionId === "txn_3")?.description).toBe(
      "Terminal reader fee",
    );
  });

  test("the still-running month is never dated in the future", async () => {
    const s = await seedNy();
    const now = Date.now();
    mockLedger([
      { id: "txn_now", type: "charge", amount: 10000, fee: 320, created: secs(now), source: "ch_n" },
    ]);
    await s.t.action(internal.processorFees.syncStripeFeesOps, { execute: true });

    const month = new Date(now).toISOString().slice(0, 7);
    const row = await feeRow(s, month);
    expect(row?.postedAt).toBeLessThanOrEqual(Date.now());
    expect(row?.postedAt).toBeGreaterThan(now - 60_000);
  });

  test("a dry run reads Stripe and writes nothing", async () => {
    const s = await seedNy();
    mockLedger([
      {
        id: "txn_1",
        type: "charge",
        amount: 50000,
        fee: 1500,
        created: secs(Date.UTC(2026, 6, 10, 12)),
      },
    ]);
    const r = await s.t.action(internal.processorFees.syncStripeFeesOps, {});
    expect(r.dryRun).toBe(true);
    expect(r.totalFeeCents).toBe(1500);
    expect(await run(s.t, (ctx) => ctx.db.query("processorFeeEntries").collect())).toHaveLength(0);
    expect(await feeRow(s, "2026-07")).toBeNull();
  });
});

// ── The drill-in ─────────────────────────────────────────────────────────────

describe("feeRowDetail", () => {
  test("returns null for anything that isn't a fee rollup", async () => {
    const s = await seedNy();
    await grantFinance(s, "viewer");
    const other = await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 100,
        postedAt: Date.now(),
        status: "unreviewed",
        createdAt: Date.now(),
      }),
    );
    expect(
      await s.as.query(api.processorFees.feeRowDetail, { transactionId: other }),
    ).toBeNull();
  });

  test("hands back every entry, and a total summed independently of the row", async () => {
    const s = await seedNy();
    await grantFinance(s, "viewer");
    await s.t.mutation(internal.processorFees.upsertFeeEntries, {
      month: "2026-07",
      entries: JULY_ENTRIES,
      execute: true,
    });
    await s.t.mutation(internal.processorFees.upsertFeeRows, { months: [JULY], execute: true });

    const row = await feeRow(s, "2026-07");
    const detail = await s.as.query(api.processorFees.feeRowDetail, {
      transactionId: row!._id,
    });
    expect(detail).not.toBeNull();
    expect(detail!.month).toBe("2026-07");
    expect(detail!.entryCount).toBe(3);
    expect(detail!.totalCents).toBe(5000);
    expect(detail!.rowAmountCents).toBe(5000);
    expect(detail!.truncated).toBe(false);
    expect(detail!.byType).toEqual([
      { type: "charge", label: "card processing", feeCents: 3000, count: 2 },
      { type: "stripe_fee", label: "Stripe-billed fees", feeCents: 2000, count: 1 },
    ]);
    expect(detail!.entries.map((e) => e.balanceTransactionId).sort()).toEqual([
      "txn_a",
      "txn_b",
      "txn_c",
    ]);
    expect(detail!.entries.find((e) => e.balanceTransactionId === "txn_a")?.sourceId).toBe("ch_a");
  });

  test("a caller with no finance access is refused", async () => {
    const s = await seedNy();
    await s.t.mutation(internal.processorFees.upsertFeeRows, { months: [JULY], execute: true });
    const row = await feeRow(s, "2026-07");
    await expect(
      s.t.query(api.processorFees.feeRowDetail, { transactionId: row!._id }),
    ).rejects.toThrow(ConvexError);
  });
});

// ── What the morning run says ────────────────────────────────────────────────

describe("feeBudgetNotes", () => {
  test("announces a budget it just drafted", () => {
    expect(
      feeBudgetNotes([
        { year: 2026, label: "Processor fees 2026", status: "draft", createdNow: true, attachedRows: 0 },
      ])[0],
    ).toContain('created a DRAFT "Processor fees 2026"');
  });

  test("keeps asking while it sits unapproved", () => {
    expect(
      feeBudgetNotes([
        { year: 2026, label: "Processor fees 2026", status: "submitted", createdNow: false, attachedRows: 0 },
      ])[0],
    ).toContain("Needs budget until it's approved");
  });

  test("says nothing once everything is approved and attached", () => {
    expect(
      feeBudgetNotes([
        { year: 2026, label: "Processor fees 2026", status: "approved", createdNow: false, attachedRows: 0 },
      ]),
    ).toEqual([]);
  });
});
