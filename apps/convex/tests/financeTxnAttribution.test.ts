/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { DEFAULT_EXPENSE_CATEGORIES } from "../lib/seed/finance";

/**
 * "Every-dollar-attributed" finance follow-up tests:
 *  - Part A: default expense categories seeded for an empty chapter (idempotent,
 *    chapter-scoped) via the superuser mutation + the CLI internal wrapper.
 *  - Part B: the derived `needsBudget` flag (spend txn && no budget) on the txn
 *    read shape, and `dashboardChapter.toBudgetCount`.
 *  - Part C: the no-auth internal migration wrapper runs the same idempotent
 *    backfill as the superuser public mutation.
 */

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

async function grantManager(s: ChapterSetup): Promise<void> {
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
}

/** Raw-insert a General Fund so the category seeder has somewhere to hang them. */
async function insertGeneralFund(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
): Promise<Id<"funds">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("funds", {
      chapterId,
      name: "General Fund",
      restriction: "unrestricted",
      sortOrder: 0,
      isActive: true,
      createdAt: Date.now(),
    }),
  );
}

/** Count `budgetCategories` in a chapter (raw read — bypasses role/active-chapter). */
async function categoryCount(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
): Promise<number> {
  const rows = await run(s.t, (ctx) =>
    ctx.db
      .query("budgetCategories")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .collect(),
  );
  return rows.length;
}

describe("Part A — seedDefaultExpenseCategories", () => {
  test("creates the full default set for an empty chapter; idempotent; chapter-scoped", async () => {
    const t = newT();
    // Superuser gates the public seed mutation.
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    await insertGeneralFund(s, s.chapterId);

    // A second chapter (with a fund) that we never seed — proves scoping.
    const otherChapterId = await run(t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "Other",
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    await run(t, (ctx) =>
      ctx.db.insert("funds", {
        chapterId: otherChapterId,
        name: "General Fund",
        restriction: "unrestricted",
        sortOrder: 0,
        isActive: true,
        createdAt: Date.now(),
      }),
    );

    const first = await s.as.mutation(api.finances.seedDefaultExpenseCategories, {});
    expect(first.inserted).toBe(DEFAULT_EXPENSE_CATEGORIES.length);
    expect(await categoryCount(s, s.chapterId)).toBe(
      DEFAULT_EXPENSE_CATEGORIES.length,
    );

    // Every seeded row is a `kind: "category"` under the General Fund and names
    // exactly the default set.
    const rows = await run(t, (ctx) =>
      ctx.db
        .query("budgetCategories")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(rows.every((r) => r.kind === "category")).toBe(true);
    expect(new Set(rows.map((r) => r.name))).toEqual(
      new Set(DEFAULT_EXPENSE_CATEGORIES),
    );

    // Chapter-scoped: the untouched chapter still has none.
    expect(await categoryCount(s, otherChapterId)).toBe(0);

    // Idempotent: a re-run inserts nothing and leaves the count unchanged.
    const second = await s.as.mutation(api.finances.seedDefaultExpenseCategories, {});
    expect(second.inserted).toBe(0);
    expect(await categoryCount(s, s.chapterId)).toBe(
      DEFAULT_EXPENSE_CATEGORIES.length,
    );
  });

  test("non-superuser is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t); // plain leader@publicworship.life
    await insertGeneralFund(s, s.chapterId);
    await expect(
      s.as.mutation(api.finances.seedDefaultExpenseCategories, {}),
    ).rejects.toThrow();
  });

  test("runSeedDefaultExpenseCategories (internal) seeds every category-less chapter, idempotently", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await insertGeneralFund(s, s.chapterId);

    const first = await t.mutation(
      internal.finances.runSeedDefaultExpenseCategories,
      {},
    );
    expect(first.chaptersSeeded).toBe(1);
    expect(first.inserted).toBe(DEFAULT_EXPENSE_CATEGORIES.length);
    expect(await categoryCount(s, s.chapterId)).toBe(
      DEFAULT_EXPENSE_CATEGORIES.length,
    );

    // Re-run: the chapter already has categories → skipped.
    const second = await t.mutation(
      internal.finances.runSeedDefaultExpenseCategories,
      {},
    );
    expect(second.chaptersSeeded).toBe(0);
    expect(second.inserted).toBe(0);
  });
});

describe("Part B — needsBudget + toBudgetCount", () => {
  test("needsBudget is true only for un-budgeted spend; toBudgetCount counts them", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantManager(s);
    const now = Date.now();

    // A raw-inserted budget to attribute one txn to.
    const budgetId = await run(t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 100000,
        type: "recurring",
        cadence: "monthly",
        year: 2026,
        createdAt: now,
      }),
    );

    // A: un-budgeted spend → needs a budget.
    const txnA = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 1500,
      postedAt: now,
    });
    // B: spend that we then attribute to a budget → no longer needs one.
    const txnB = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 2500,
      postedAt: now,
    });
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txnB,
      budgetId,
    });
    // C: transfer → excluded from spend, never flagged.
    await s.as.mutation(api.finances.createManualTransaction, {
      flow: "transfer",
      amountCents: 500,
      postedAt: now,
    });
    // D: outflow marked excluded → not spend, never flagged.
    const txnD = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 700,
      postedAt: now,
    });
    await s.as.mutation(api.finances.setTransactionStatus, {
      transactionId: txnD,
      status: "excluded",
    });
    // E: inflow → not spend.
    await s.as.mutation(api.finances.createManualTransaction, {
      flow: "inflow",
      amountCents: 9000,
      postedAt: now,
    });

    const page = await s.as.query(api.finances.listTransactions, {
      paginationOpts: { numItems: 50, cursor: null },
    });
    const byId = new Map(page.page.map((tr) => [tr.id, tr] as const));
    expect(byId.get(txnA)?.needsBudget).toBe(true);
    expect(byId.get(txnB)?.needsBudget).toBe(false);
    expect(byId.get(txnD)?.needsBudget).toBe(false);
    // Transfer + inflow never need a budget.
    for (const tr of page.page) {
      if (tr.flow !== "outflow") expect(tr.needsBudget).toBe(false);
    }

    // Only txn A (un-budgeted, non-excluded outflow) is counted.
    const dash = await s.as.query(api.finances.dashboardChapter, {});
    expect(dash.toBudgetCount).toBe(1);
  });
});

describe("Part C — runMigrateBudgetScopesToTypes (internal)", () => {
  test("runs the same idempotent v2 backfill without an auth gate", async () => {
    const t = newT();
    const s = await setupChapter(t);

    // A legacy budget: `scope`, no `type`.
    const legacy = await run(t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 40000,
        scope: "chapter",
        cadence: "yearly",
        year: 2026,
        createdAt: Date.now(),
      }),
    );

    const first = await t.mutation(
      internal.finances.runMigrateBudgetScopesToTypes,
      {},
    );
    expect(first.migrated).toBe(1);
    expect(first.skipped).toBe(0);

    const migrated = await run(t, (ctx) => ctx.db.get(legacy));
    expect(migrated?.type).toBe("recurring");

    // Idempotent: the now-v2 budget is skipped on a re-run.
    const second = await t.mutation(
      internal.finances.runMigrateBudgetScopesToTypes,
      {},
    );
    expect(second.migrated).toBe(0);
    expect(second.skipped).toBe(1);
  });
});
