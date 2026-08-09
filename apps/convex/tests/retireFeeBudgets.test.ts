import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { newT, run, setupChapter } from "./setup.helpers";
import { needsBudget } from "../finances";
import type { Id } from "../_generated/dataModel";

/**
 * The one-off that retires the two auto-created draft fee budgets and stamps
 * the three Cash App fee rows.
 *
 * A one-off that touches production financial data gets tested like anything
 * else, and the tests that matter are the REFUSALS: a module that deletes a
 * budget somebody actually used, or stamps a row that isn't a fee, is worse
 * than one that does nothing. Every precondition below is a thing that would be
 * silent damage if it were missing.
 */

async function seed(t: ReturnType<typeof newT>) {
  const s = await setupChapter(t);
  const ids = await run(t, async (ctx) => {
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

async function addDraftFeeBudget(
  t: ReturnType<typeof newT>,
  s: { chapterId: Id<"chapters">; fundId: Id<"funds">; categoryId: Id<"budgetCategories"> },
  label: string,
  year: number,
  amountCents: number,
) {
  return run(t, (ctx) =>
    ctx.db.insert("budgets", {
      chapterId: s.chapterId,
      amountCents,
      label,
      type: "recurring",
      cadence: "yearly",
      year,
      fundId: s.fundId,
      categoryId: s.categoryId,
      createdAt: Date.now(),
      approvalStatus: "draft",
      // `createdBy` deliberately absent — no user made these.
    }),
  );
}

async function addCashAppFeeRow(
  t: ReturnType<typeof newT>,
  chapterId: Id<"chapters">,
  externalId: string,
  amountCents: number,
) {
  return run(t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId,
      source: "manual",
      flow: "outflow",
      amountCents,
      postedAt: Date.UTC(2026, 0, 6, 12),
      description: "Cash App processing fees",
      merchantName: "Cash App",
      status: "categorized",
      externalId,
      createdAt: Date.now(),
    }),
  );
}

/** Production's shape: both drafts, and the three Cash App rows ($43.15). */
async function seedProdShape(t: ReturnType<typeof newT>) {
  const s = await seed(t);
  await addDraftFeeBudget(t, s, "Processor fees 2025", 2025, 10_000);
  await addDraftFeeBudget(t, s, "Processor fees 2026", 2026, 30_000);
  await addCashAppFeeRow(t, s.chapterId, "cashapp-fees:2025-11-06", 1_400);
  await addCashAppFeeRow(t, s.chapterId, "cashapp-fees:2026-01-06", 1_000);
  await addCashAppFeeRow(t, s.chapterId, "cashapp-fees:2026-08-07", 1_915);
  return s;
}

describe("retireFeeBudgets", () => {
  test("a dry run reports everything and writes nothing", async () => {
    const t = newT();
    await seedProdShape(t);

    const r = await t.mutation(internal.retireFeeBudgets.retireFeeBudgets, {});
    expect(r.dryRun).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.deleted).toBe(2);
    expect(r.cashAppRowsStamped).toBe(3);
    expect(r.feeRowCents).toBe(4_315); // $43.15
    expect(r.found.map((f) => f.label).sort()).toEqual([
      "Processor fees 2025",
      "Processor fees 2026",
    ]);

    // Nothing actually moved.
    expect(await run(t, (ctx) => ctx.db.query("budgets").collect())).toHaveLength(2);
    const rows = await run(t, (ctx) => ctx.db.query("transactions").collect());
    expect(rows.every((row) => row.feeOrigin == null)).toBe(true);
  });

  test("the real run deletes both drafts, stamps all three rows, and clears Needs budget", async () => {
    const t = newT();
    await seedProdShape(t);

    const before = await run(t, (ctx) => ctx.db.query("transactions").collect());
    expect(before.filter((row) => needsBudget(row))).toHaveLength(3);

    const r = await t.mutation(internal.retireFeeBudgets.retireFeeBudgets, { execute: true });
    expect(r.problems).toEqual([]);
    expect(r.deleted).toBe(2);
    expect(r.cashAppRowsStamped).toBe(3);
    expect(r.feeRowsStillNeedingBudget).toBe(0);

    expect(await run(t, (ctx) => ctx.db.query("budgets").collect())).toHaveLength(0);
    const after = await run(t, (ctx) => ctx.db.query("transactions").collect());
    expect(after.every((row) => row.feeOrigin === "cash_app_processing")).toBe(true);
    expect(after.filter((row) => needsBudget(row))).toHaveLength(0);
    // The rows themselves are untouched otherwise — still coded, still spend.
    expect(after.reduce((sum, row) => sum + row.amountCents, 0)).toBe(4_315);
  });

  test("running twice changes nothing the second time", async () => {
    const t = newT();
    await seedProdShape(t);
    await t.mutation(internal.retireFeeBudgets.retireFeeBudgets, { execute: true });

    const again = await t.mutation(internal.retireFeeBudgets.retireFeeBudgets, { execute: true });
    expect(again.deleted).toBe(0);
    expect(again.alreadyGone).toBe(2);
    expect(again.cashAppRowsStamped).toBe(0);
    expect(again.problems).toEqual([]);
  });

  test("REFUSES a budget with a transaction attributed to it", async () => {
    const t = newT();
    const s = await seedProdShape(t);
    const budget = (await run(t, (ctx) => ctx.db.query("budgets").collect())).find(
      (b) => b.label === "Processor fees 2026",
    )!;
    await run(t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 5_000,
        postedAt: Date.now(),
        status: "categorized",
        budgetId: budget._id,
        createdAt: Date.now(),
      }),
    );

    const r = await t.mutation(internal.retireFeeBudgets.retireFeeBudgets, { execute: true });
    expect(r.problems.join(" ")).toContain("attributed to it");
    expect(r.deleted).toBe(0);
    // COUPLED: a surprise anywhere stops everything, including the stamping.
    expect(await run(t, (ctx) => ctx.db.query("budgets").collect())).toHaveLength(2);
  });

  test("REFUSES a budget a human created", async () => {
    const t = newT();
    const s = await seed(t);
    const budgetId = await addDraftFeeBudget(t, s, "Processor fees 2026", 2026, 30_000);
    await run(t, (ctx) => ctx.db.patch(budgetId, { createdBy: s.userId }));

    const r = await t.mutation(internal.retireFeeBudgets.retireFeeBudgets, { execute: true });
    expect(r.problems.join(" ")).toContain("createdBy");
    expect(r.deleted).toBe(0);
  });

  test("REFUSES a budget somebody approved", async () => {
    const t = newT();
    const s = await seed(t);
    const budgetId = await addDraftFeeBudget(t, s, "Processor fees 2025", 2025, 10_000);
    await run(t, (ctx) => ctx.db.patch(budgetId, { approvalStatus: "approved" }));

    const r = await t.mutation(internal.retireFeeBudgets.retireFeeBudgets, { execute: true });
    expect(r.problems.join(" ")).toContain("not draft");
    expect(r.deleted).toBe(0);
    expect(await run(t, (ctx) => ctx.db.query("budgets").collect())).toHaveLength(1);
  });

  test("REFUSES to stamp a row that isn't a Cash App fee", async () => {
    const t = newT();
    const s = await seed(t);
    // Right key, wrong row — somebody reused the id, or the data moved.
    await run(t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "inflow",
        amountCents: 9_999,
        postedAt: Date.now(),
        merchantName: "Somebody Else",
        status: "categorized",
        externalId: "cashapp-fees:2026-01-06",
        createdAt: Date.now(),
      }),
    );

    const r = await t.mutation(internal.retireFeeBudgets.retireFeeBudgets, { execute: true });
    expect(r.problems.join(" ")).toContain("not a Cash App");
    const rows = await run(t, (ctx) => ctx.db.query("transactions").collect());
    expect(rows.every((row) => row.feeOrigin == null)).toBe(true);
  });

  test("the Bank & Fees category is never touched, and its usage is reported", async () => {
    const t = newT();
    const s = await seedProdShape(t);
    // A discretionary cost lives here too, and must keep its budget question.
    await run(t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 4_900,
        postedAt: Date.now(),
        description: "Givebutter Plus — monthly",
        status: "categorized",
        categoryId: s.categoryId,
        createdAt: Date.now(),
      }),
    );

    const r = await t.mutation(internal.retireFeeBudgets.retireFeeBudgets, { execute: true });
    expect(r.bankAndFeesCodedRows).toBe(1);

    const categories = await run(t, (ctx) => ctx.db.query("budgetCategories").collect());
    expect(categories).toHaveLength(1);
    expect(categories[0].name).toBe("Bank & Fees");

    const subscription = (await run(t, (ctx) => ctx.db.query("transactions").collect())).find(
      (row) => row.description === "Givebutter Plus — monthly",
    )!;
    expect(subscription.feeOrigin).toBeUndefined();
    expect(needsBudget(subscription)).toBe(true);
  });
});
