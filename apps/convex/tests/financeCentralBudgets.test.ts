/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Central (org-level) budgets + explicit budget attribution (PR 2).
 *
 * Covers: central-budget create is gated on central access (a chapter manager is
 * rejected) and stores `chapterId:"central"`; `listBudgets` tags every row's
 * `level`; categorize accepts a central budgetId from a chapter txn but rejects
 * another chapter's budget; an explicit `budgetId` makes a txn count toward THAT
 * budget only while unlinked txns keep deriving; and `dashboardCentral` rolls a
 * central budget's actuals up across chapters without polluting per-chapter
 * allocations.
 *
 * A superuser (`seyi@publicworship.life`) is an implicit CENTRAL manager; a plain
 * chapter caller with a `manager` grant is chapter-only.
 */

function tsInMonth(year: number, month: number): number {
  return Date.UTC(year, month - 1, 15, 17, 0, 0);
}

async function seedSelfPerson(s: ChapterSetup): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

/** A chapter-only manager (person + manager grant, scope chapter). */
async function asChapterManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
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

describe("central budgets: create gating + storage", () => {
  test("createBudget central:true is rejected for a chapter-only manager", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    await expect(
      s.as.mutation(api.finances.createBudget, {
        amountCents: 100000,
        scope: "chapter",
        cadence: "yearly",
        year: 2026,
        central: true,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a central user creates a central budget stored as chapterId:'central'", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 500000,
      scope: "chapter",
      cadence: "yearly",
      year: 2026,
      central: true,
      label: "Org Marketing",
    });
    const doc = await run(s.t, (ctx) => ctx.db.get(budgetId));
    expect(doc?.chapterId).toBe("central");
  });
});

describe("listBudgets: chapter + central, level-tagged", () => {
  test("returns both the caller's chapter budgets and central budgets, each tagged", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const chapterBudget = await s.as.mutation(api.finances.createBudget, {
      amountCents: 100000,
      scope: "chapter",
      cadence: "yearly",
      year: 2026,
      label: "NY Ops",
    });
    const centralBudget = await s.as.mutation(api.finances.createBudget, {
      amountCents: 500000,
      scope: "chapter",
      cadence: "yearly",
      year: 2026,
      central: true,
      label: "Org",
    });
    const budgets = await s.as.query(api.finances.listBudgets, {});
    expect(budgets.find((b) => b.id === chapterBudget)?.level).toBe("chapter");
    expect(budgets.find((b) => b.id === centralBudget)?.level).toBe("central");
  });
});

describe("categorize: budget attribution tenancy", () => {
  test("accepts a central budgetId from a chapter txn; null clears; another chapter's is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const centralBudget = await s.as.mutation(api.finances.createBudget, {
      amountCents: 500000,
      scope: "chapter",
      cadence: "yearly",
      year: 2026,
      central: true,
    });
    const txnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 5000,
      postedAt: Date.now(),
    });

    // A chapter txn may point at a central budget.
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txnId,
      budgetId: centralBudget,
    });
    expect(
      (await run(s.t, (ctx) => ctx.db.get(txnId)))?.budgetId,
    ).toBe(centralBudget);

    // `null` clears the attribution.
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txnId,
      budgetId: null,
    });
    expect(
      (await run(s.t, (ctx) => ctx.db.get(txnId)))?.budgetId,
    ).toBeUndefined();

    // Another chapter's budget is out of tenancy → rejected.
    const foreignBudget = await run(t, async (ctx) => {
      const other = await ctx.db.insert("chapters", {
        name: "Boston",
        isActive: true,
        createdAt: Date.now(),
      });
      return ctx.db.insert("budgets", {
        chapterId: other,
        amountCents: 1000,
        scope: "chapter",
        cadence: "yearly",
        year: 2026,
        createdAt: Date.now(),
      });
    });
    await expect(
      s.as.mutation(api.finances.categorizeTransaction, {
        transactionId: txnId,
        budgetId: foreignBudget,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("budget attribution: explicit link wins, unlinked still derives", () => {
  test("an explicit budgetId counts toward that budget only; unlinked txns derive-match both", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const year = 2026;
    const month = 3;

    const fundId = await s.as.mutation(api.finances.createFund, {
      name: "General",
      restriction: "unrestricted",
    });
    const categoryId = await s.as.mutation(api.finances.createCategory, {
      fundId,
      name: "Food",
      kind: "lineItem",
    });
    // Two budgets that BOTH derive-match a Food/March spend.
    const budgetA = await s.as.mutation(api.finances.createBudget, {
      amountCents: 100000,
      scope: "bucket",
      cadence: "monthly",
      year,
      month,
      fundId,
      categoryId,
      label: "A",
    });
    const budgetB = await s.as.mutation(api.finances.createBudget, {
      amountCents: 100000,
      scope: "bucket",
      cadence: "monthly",
      year,
      month,
      fundId,
      categoryId,
      label: "B",
    });

    // txn1 ($100): explicitly linked to A.
    const txn1 = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 10000,
      postedAt: tsInMonth(year, month),
      fundId,
      categoryId,
    });
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txn1,
      budgetId: budgetA,
    });
    // txn2 ($50): unlinked → derive-matches both A and B.
    await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 5000,
      postedAt: tsInMonth(year, month),
      fundId,
      categoryId,
    });

    const rows = await s.as.query(api.finances.budgetVsActual, { year, month });
    // A: linked $100 + derived $50; B: only the unlinked $50 (never the linked one).
    expect(rows.find((r) => r.budgetId === budgetA)?.actualCents).toBe(15000);
    expect(rows.find((r) => r.budgetId === budgetB)?.actualCents).toBe(5000);
  });
});

describe("budget attribution: an explicit link still buckets by the budget's period", () => {
  test("a txn linked to a MONTHLY budget counts in its posted month, not another month", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const year = 2026;

    // A recurring "$1,000/mo" budget carries no stored `month`, so its period is
    // the dashboard's queried month (`budgetEffectivePeriod`).
    const monthly = await s.as.mutation(api.finances.createBudget, {
      amountCents: 100000,
      scope: "bucket",
      cadence: "monthly",
      year,
      label: "Monthly",
    });

    // $80 posted in MARCH, explicitly linked to the monthly budget.
    const txn = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 8000,
      postedAt: tsInMonth(year, 3),
    });
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txn,
      budgetId: monthly,
    });

    // March: the linked txn lands in the budget's March window → counts.
    const march = await s.as.query(api.finances.budgetVsActual, { year, month: 3 });
    expect(march.find((r) => r.budgetId === monthly)?.actualCents).toBe(8000);

    // April: the same budget's window is April, where the txn does NOT fall →
    // the explicit link must not drag March spend into April.
    const april = await s.as.query(api.finances.budgetVsActual, { year, month: 4 });
    expect(april.find((r) => r.budgetId === monthly)?.actualCents).toBe(0);
  });
});

describe("dashboardCentral: central budgets roll up org-wide", () => {
  test("sums a central budget's actuals across chapters; per-chapter allocation excludes it", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const year = 2026;
    const month = 5;
    const when = tsInMonth(year, month);

    const centralBudget = await s.as.mutation(api.finances.createBudget, {
      amountCents: 500000,
      scope: "chapter",
      cadence: "yearly",
      year,
      central: true,
      label: "Org Ads",
    });

    // NY: a $70 spend linked to the central budget.
    await run(t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 7000,
        postedAt: when,
        budgetId: centralBudget,
        status: "categorized",
        createdAt: Date.now(),
      }),
    );
    // Boston: a $30 spend linked to the SAME central budget.
    await run(t, async (ctx) => {
      const boston = await ctx.db.insert("chapters", {
        name: "Boston",
        isActive: true,
        createdAt: Date.now(),
      });
      await ctx.db.insert("transactions", {
        chapterId: boston,
        source: "manual",
        flow: "outflow",
        amountCents: 3000,
        postedAt: when,
        budgetId: centralBudget,
        status: "categorized",
        createdAt: Date.now(),
      });
    });

    const dash = await s.as.query(api.finances.dashboardCentral, { year, month });
    const cb = dash.centralBudgets.find((b) => b.id === centralBudget);
    expect(cb?.spentCents).toBe(10000); // 7000 + 3000, org-wide
    expect(cb?.budgetCents).toBe(500000);

    // NY has no chapter budget of its own, so its allocation must be 0 — the
    // central budget never leaks into a per-chapter rollup.
    const ny = dash.chapterRollup.find((c) => c.chapterName === "New York");
    expect(ny?.budgetCents).toBe(0);
    expect(ny?.spentCents).toBe(7000);
  });
});
