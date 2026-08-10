/// <reference types="vite/client" />
import { afterEach, describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { NEW_YORK_CHAPTER_SLUG } from "../lib/seed/historical/mapping";
import { isSpend, needsBudget } from "../finances";
import { normalizeGivebutterFee } from "../givebutterSync";

/**
 * Processor fees — the monthly Stripe fee row and its evidence.
 *
 * The three things this suite exists to hold still, all of them owner
 * complaints from 2026-08-08:
 *  1. the row must never be dated in the future,
 *  2. the figure must be checkable — the stored entries have to ADD UP to it,
 *  3. it must NEVER be asked which budget it belongs to — a fee is charged,
 *     not chosen, so there is no decision for a budget to control
 *     (owner, 2026-08-09).
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
/** The fee rows this suite writes — the `stripe-fees:` externalId is the key. */
async function feeRows(t: ReturnType<typeof newT>) {
  const all = await run(t, (ctx) => ctx.db.query("transactions").collect());
  return all.filter((r) => r.externalId?.startsWith("stripe-fees:"));
}

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
      processor: "stripe",
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
      processor: "stripe",
      month: "2026-07",
      entries: JULY_ENTRIES,
      execute: true,
    });
    expect(first).toEqual({ inserted: 3, updated: 0, removed: 0 });

    const second = await s.t.mutation(internal.processorFees.upsertFeeEntries, {
      processor: "stripe",
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
      processor: "stripe",
      month: "2026-07",
      entries: JULY_ENTRIES,
      execute: true,
    });
    // The sweep now reports only two of the three, and one has a corrected fee.
    const r = await s.t.mutation(internal.processorFees.upsertFeeEntries, {
      processor: "stripe",
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
      processor: "stripe",
      month: "2026-06",
      entries: [entry("txn_june", "charge", 900)],
      execute: true,
    });
    await s.t.mutation(internal.processorFees.upsertFeeEntries, {
      processor: "stripe",
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
      processor: "stripe",
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
    await s.t.mutation(internal.processorFees.upsertFeeRows, { processor: "stripe", months: [JULY], execute: true });
    const again = await s.t.mutation(internal.processorFees.upsertFeeRows, {
      processor: "stripe",
      months: [JULY],
      execute: true,
    });
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
  });

  test("a row written before the breakdown existed has its note refreshed", async () => {
    const s = await seedNy();
    await s.t.mutation(internal.processorFees.upsertFeeRows, { processor: "stripe", months: [JULY], execute: true });
    const row = await feeRow(s, "2026-07");
    await run(s.t, (ctx) => ctx.db.patch(row!._id, { note: "Stripe fees for 2026-07, across 3 balance-transaction entries." }));

    const r = await s.t.mutation(internal.processorFees.upsertFeeRows, {
      processor: "stripe",
      months: [JULY],
      execute: true,
    });
    expect(r.updated).toBe(1);
    expect((await feeRow(s, "2026-07"))?.note).toContain("card processing $30.00 (2)");
  });

  test("a month with no fees books nothing", async () => {
    const s = await seedNy();
    const r = await s.t.mutation(internal.processorFees.upsertFeeRows, {
      processor: "stripe",
      months: [{ ...JULY, feeCents: 0, entryCount: 0, byType: [] }],
      execute: true,
    });
    expect(r).toMatchObject({ created: 0, totalFeeCents: 0 });
    expect(await feeRow(s, "2026-07")).toBeNull();
  });
});

// ── The budget ───────────────────────────────────────────────────────────────

// ── The sweep ────────────────────────────────────────────────────────────────

describe("upsertFeeRows — a fee is never asked which budget it belongs to", () => {
  test("a new fee row is stamped non-discretionary, and reads as NOT needing a budget", async () => {
    const s = await seedNy();

    const r = await s.t.mutation(internal.processorFees.upsertFeeRows, {
      processor: "stripe",
      months: [JULY],
      execute: true,
    });
    expect(r.created).toBe(1);
    expect(r.marked).toBe(1);

    const row = (await feeRows(s.t))[0];
    expect(row.feeOrigin).toBe("stripe_processing");
    // Coded, and counted as spend — the money really left.
    expect(row.categoryId).toBe(s.categoryId);
    expect(row.flow).toBe("outflow");
    expect(isSpend(row)).toBe(true);
    // But never attributed, and never asked to be.
    expect(row.budgetId).toBeUndefined();
    expect(needsBudget(row)).toBe(false);
  });

  test("a row written before the marker existed is back-filled by the next sync", async () => {
    const s = await seedNy();
    await s.t.mutation(internal.processorFees.upsertFeeRows, { processor: "stripe", months: [JULY], execute: true });

    // Strip the marker, reproducing one of the 8 rows stuck in "Needs budget".
    const before = (await feeRows(s.t))[0];
    await run(s.t, (ctx) => ctx.db.patch(before._id, { feeOrigin: undefined }));
    expect(needsBudget((await feeRows(s.t))[0])).toBe(true);

    const r = await s.t.mutation(internal.processorFees.upsertFeeRows, {
      processor: "stripe",
      months: [JULY],
      execute: true,
    });
    expect(r.marked).toBe(1);
    expect(r.updated).toBe(1);
    const after = (await feeRows(s.t))[0];
    expect(after.feeOrigin).toBe("stripe_processing");
    expect(needsBudget(after)).toBe(false);
    // Nothing else moved.
    expect(after.amountCents).toBe(before.amountCents);
    expect(after._id).toBe(before._id);
  });

  test("a settled run is unchanged — the back-fill doesn't re-fire every night", async () => {
    const s = await seedNy();
    await s.t.mutation(internal.processorFees.upsertFeeRows, { processor: "stripe", months: [JULY], execute: true });
    const again = await s.t.mutation(internal.processorFees.upsertFeeRows, {
      processor: "stripe",
      months: [JULY],
      execute: true,
    });
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 1, marked: 0 });
  });

  test("THE LINE: a discretionary cost in the SAME category still needs a budget", async () => {
    const s = await seedNy();
    await s.t.mutation(internal.processorFees.upsertFeeRows, { processor: "stripe", months: [JULY], execute: true });

    // A paid platform tier — booked to Bank & Fees, exactly like the fee row,
    // but somebody CHOSE it. The exemption is by fee origin, never by category.
    const subscriptionId = await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 4_900,
        postedAt: Date.UTC(2026, 6, 15, 12),
        description: "Givebutter Plus — monthly",
        status: "categorized",
        categoryId: s.categoryId,
        createdAt: Date.now(),
      }),
    );

    const subscription = await run(s.t, (ctx) => ctx.db.get(subscriptionId));
    expect(subscription!.feeOrigin).toBeUndefined();
    expect(needsBudget(subscription!)).toBe(true);

    const fee = (await feeRows(s.t))[0];
    expect(fee.categoryId).toBe(subscription!.categoryId);
    expect(needsBudget(fee)).toBe(false);
  });

  test("nothing is proposed, created or approved — no budget row is ever written", async () => {
    const s = await seedNy();
    await s.t.mutation(internal.processorFees.upsertFeeRows, {
      processor: "stripe",
      months: [JULY, { ...JULY, month: "2025-12", postedAt: Date.UTC(2025, 11, 31, 12) }],
      execute: true,
    });
    expect(await run(s.t, (ctx) => ctx.db.query("budgets").collect())).toHaveLength(0);
  });

  test("a dry run still writes nothing", async () => {
    const s = await seedNy();
    const r = await s.t.mutation(internal.processorFees.upsertFeeRows, { processor: "stripe", months: [JULY] });
    expect(r.created).toBe(1);
    expect(r.marked).toBe(0);
    expect(await feeRows(s.t)).toHaveLength(0);
  });
});

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
      processor: "stripe",
      month: "2026-07",
      entries: JULY_ENTRIES,
      execute: true,
    });
    await s.t.mutation(internal.processorFees.upsertFeeRows, { processor: "stripe", months: [JULY], execute: true });

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
    await s.t.mutation(internal.processorFees.upsertFeeRows, { processor: "stripe", months: [JULY], execute: true });
    const row = await feeRow(s, "2026-07");
    await expect(
      s.t.query(api.processorFees.feeRowDetail, { transactionId: row!._id }),
    ).rejects.toThrow(ConvexError);
  });
});

// ── What the morning run says ────────────────────────────────────────────────


// ── Givebutter's fee (2026-08-10) ────────────────────────────────────────────
//
// Booked from `amount - payout`, both Givebutter's own per-transaction figures.
// The module header forbids inferring a fee by subtracting OUR revenue from
// THEIR deposits; these hold the line that this is the other subtraction, and
// that the two rails never contaminate each other's evidence.

describe("normalizeGivebutterFee", () => {
  const base = {
    id: 4030672614,
    status: "succeeded",
    transacted_at: "2026-01-26T15:04:05Z",
  };

  test("the giver covering the fee books nothing", () => {
    // 262 of this deployment's 263 succeeded transactions look like this.
    expect(
      normalizeGivebutterFee({ ...base, amount: 50, payout: 50 }),
    ).toBeNull();
  });

  test("the one uncovered fee is the $29.30 on a $1,000 gift", () => {
    // Payout RX3CUU, 2025-06-05 — the whole of this deployment's Givebutter
    // fee expense, and the reason the reconciliation gap read $29.30 short.
    const e = normalizeGivebutterFee({
      ...base,
      amount: 1000,
      payout: 970.7,
      transacted_at: "2025-06-05T12:00:00Z",
    });
    expect(e?.feeCents).toBe(2930);
    expect(e?.grossCents).toBe(100000);
    expect(e?.month).toBe("2025-06");
  });

  test("cents are differenced as integers, not floats", () => {
    // 1000 - 970.7 === 29.299999999999955 in float. Rounding each side to
    // cents FIRST is what keeps that out of the ledger.
    const e = normalizeGivebutterFee({ ...base, amount: 1000, payout: 970.7 });
    expect(Number.isInteger(e?.feeCents)).toBe(true);
    expect(e?.feeCents).toBe(2930);
  });

  test("decimal-string amounts parse the same as numbers", () => {
    const e = normalizeGivebutterFee({
      ...base,
      amount: "100.00",
      payout: "97.10",
    });
    expect(e?.feeCents).toBe(290);
  });

  test("a non-succeeded transaction books nothing", () => {
    // A refund had its fee returned; a pending charge has not settled. Neither
    // is a cost the org has borne. Same status rule the balance sweep uses.
    for (const status of ["refunded", "pending", "failed"]) {
      expect(
        normalizeGivebutterFee({ ...base, status, amount: 100, payout: 97 }),
      ).toBeNull();
    }
  });

  test("a negative difference never becomes a credit", () => {
    // Givebutter remitting MORE than the giver paid is not a thing we book as
    // negative spend; it would be a finding, not an expense.
    expect(
      normalizeGivebutterFee({ ...base, amount: 50, payout: 55 }),
    ).toBeNull();
  });

  test("a fee with no readable date is skipped, not filed under today", () => {
    expect(
      normalizeGivebutterFee({
        id: 1,
        status: "succeeded",
        amount: 100,
        payout: 97,
      }),
    ).toBeNull();
  });

  test("the id is gb-prefixed so it cannot collide with a Stripe txn id", () => {
    const e = normalizeGivebutterFee({ ...base, amount: 100, payout: 97 });
    expect(e?.transactionId).toBe("gb:4030672614");
  });

  test("the giver's name rides along as the entry's description", () => {
    const e = normalizeGivebutterFee({
      ...base,
      amount: 100,
      payout: 97,
      first_name: "Jocelyn",
      last_name: "Naranjo",
    });
    expect(e?.description).toBe("Jocelyn Naranjo");
  });
});

describe("Givebutter fee rows", () => {
  const GB_JUNE = {
    month: "2025-06",
    feeCents: 2930,
    entryCount: 1,
    byType: [{ type: "givebutter", feeCents: 2930, count: 1 }],
    postedAt: monthEnd("2025-06"),
  };

  test("books its own row, named and marked for its own rail", async () => {
    const s = await seedNy();
    await s.t.mutation(internal.processorFees.upsertFeeRows, {
      processor: "givebutter",
      months: [GB_JUNE],
      execute: true,
    });
    const row = await run(s.t, async (ctx) =>
      (await ctx.db.query("transactions").collect()).find((r) =>
        r.externalId?.startsWith("givebutter-fees:"),
      ),
    );
    expect(row?.amountCents).toBe(2930);
    expect(row?.merchantName).toBe("Givebutter");
    expect(row?.description).toBe("Givebutter processing fees — 2025-06");
    expect(row?.flow).toBe("outflow");
    // A fee is charged, not chosen — same rule as Stripe's row.
    expect(row?.feeOrigin).toBe("givebutter_processing");
    expect(needsBudget(row!)).toBe(false);
    expect(isSpend(row!)).toBe(true);
  });

  test("the note says why most transactions contribute nothing", async () => {
    const s = await seedNy();
    await s.t.mutation(internal.processorFees.upsertFeeRows, {
      processor: "givebutter",
      months: [GB_JUNE],
      execute: true,
    });
    const row = await run(s.t, async (ctx) =>
      (await ctx.db.query("transactions").collect()).find((r) =>
        r.externalId?.startsWith("givebutter-fees:"),
      ),
    );
    expect(row?.note).toContain("did NOT cover the fee");
  });

  test("the two rails write separate rows for the same month", async () => {
    const s = await seedNy();
    const month = "2026-07";
    await s.t.mutation(internal.processorFees.upsertFeeRows, {
      processor: "stripe",
      months: [JULY],
      execute: true,
    });
    await s.t.mutation(internal.processorFees.upsertFeeRows, {
      processor: "givebutter",
      months: [{ ...GB_JUNE, month, postedAt: monthEnd(month) }],
      execute: true,
    });
    const rows = await run(s.t, async (ctx) =>
      (await ctx.db.query("transactions").collect()).filter((r) =>
        r.externalId?.includes("-fees:"),
      ),
    );
    expect(rows.map((r) => r.externalId).sort()).toEqual([
      "givebutter-fees:2026-07",
      "stripe-fees:2026-07",
    ]);
  });

  test("a Givebutter sweep never deletes Stripe's evidence for that month", async () => {
    // `upsertFeeEntries` replaces a month wholesale. Scoped to one rail, or the
    // second sweep of the morning would wipe the first one's entries and leave
    // a row whose own evidence adds up to nothing.
    const s = await seedNy();
    await s.t.mutation(internal.processorFees.upsertFeeEntries, {
      processor: "stripe",
      month: "2026-07",
      entries: JULY_ENTRIES,
      execute: true,
    });
    await s.t.mutation(internal.processorFees.upsertFeeEntries, {
      processor: "givebutter",
      month: "2026-07",
      entries: [
        {
          balanceTransactionId: "gb:99",
          type: "givebutter",
          feeCents: 2930,
          grossCents: 100000,
          occurredAt: Date.UTC(2026, 6, 15, 12),
        },
      ],
      execute: true,
    });
    const stored = await run(s.t, async (ctx) =>
      ctx.db.query("processorFeeEntries").collect(),
    );
    expect(stored.filter((e) => e.processor === "stripe")).toHaveLength(
      JULY_ENTRIES.length,
    );
    expect(stored.filter((e) => e.processor === "givebutter")).toHaveLength(1);
  });
});
