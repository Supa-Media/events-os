/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Precision measurement for AI coding suggestions (the founder's "mostly
 * wrong" report needs numbers, not vibes):
 *  - `acceptSuggestion` appends an `accepted` outcome row snapshotting the
 *    suggested + chosen ids,
 *  - `recordCodingOverride` appends an `overridden` row for the ONE dimension
 *    the human hand-resolved (no-op when there's no live suggestion),
 *  - `codingPrecision` reads the append-only log and reports per-dimension
 *    precision (ED/FM-gated).
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

async function assignSpecializedRole(
  s: ChapterSetup,
  personId: Id<"people">,
  title: "executive_director" | "finance_manager",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("specializedRoles", {
      personId,
      scope: "central",
      title,
      roleKind: title === "finance_manager" ? "finance" : "leadership",
      createdAt: Date.now(),
    }),
  );
}

async function seedFundAndCategories(s: ChapterSetup): Promise<{
  fundId: Id<"funds">;
  catX: Id<"budgetCategories">;
  catY: Id<"budgetCategories">;
}> {
  return await run(s.t, async (ctx) => {
    const fundId = await ctx.db.insert("funds", {
      chapterId: s.chapterId,
      name: "General",
      restriction: "unrestricted",
      sortOrder: 0,
      createdAt: Date.now(),
    });
    const catX = await ctx.db.insert("budgetCategories", {
      chapterId: s.chapterId,
      fundId,
      name: "Supplies",
      kind: "lineItem",
      createdAt: Date.now(),
    });
    const catY = await ctx.db.insert("budgetCategories", {
      chapterId: s.chapterId,
      fundId,
      name: "Travel",
      kind: "lineItem",
      createdAt: Date.now(),
    });
    return { fundId, catX, catY };
  });
}

async function seedBudget(s: ChapterSetup): Promise<Id<"budgets">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("budgets", {
      chapterId: s.chapterId,
      amountCents: 50000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      createdAt: Date.now(),
    }),
  );
}

async function seedTxn(
  s: ChapterSetup,
  suggestion?: Record<string, unknown>,
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: 4200,
      postedAt: Date.now(),
      merchantName: "Office Depot",
      status: "unreviewed",
      createdAt: Date.now(),
      ...(suggestion ? { aiSuggestion: suggestion } : {}),
    }),
  );
}

async function outcomesFor(s: ChapterSetup, txnId: Id<"transactions">) {
  return await run(s.t, (ctx) =>
    ctx.db
      .query("aiCodingOutcomes")
      .withIndex("by_transaction", (q) => q.eq("transactionId", txnId))
      .collect(),
  );
}

describe("acceptSuggestion records an accepted outcome", () => {
  test("snapshots suggested + chosen ids on accept", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const { fundId, catX } = await seedFundAndCategories(s);
    const txnId = await seedTxn(s, {
      fundId,
      categoryId: catX,
      confidence: 0.9,
      model: "test/model",
      suggestedAt: Date.now(),
    });

    await s.as.mutation(api.aiCodingData.acceptSuggestion, {
      transactionId: txnId,
    });

    const outcomes = await outcomesFor(s, txnId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      outcome: "accepted",
      suggestedFundId: fundId,
      suggestedCategoryId: catX,
      chosenFundId: fundId,
      chosenCategoryId: catX,
      confidence: 0.9,
      model: "test/model",
    });
  });
});

describe("recordCodingOverride", () => {
  test("records the resolved dimension when a live suggestion exists", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const { catX, catY } = await seedFundAndCategories(s);
    const txnId = await seedTxn(s, {
      categoryId: catX,
      confidence: 0.6,
      model: "test/model",
      suggestedAt: Date.now(),
    });

    await s.as.mutation(api.aiCodingData.recordCodingOverride, {
      transactionId: txnId,
      dimension: "category",
      chosenCategoryId: catY,
    });

    const outcomes = await outcomesFor(s, txnId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      outcome: "overridden",
      overriddenDimension: "category",
      suggestedCategoryId: catX,
      chosenCategoryId: catY,
    });
  });

  test("is a no-op when the transaction has no live suggestion", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const budgetId = await seedBudget(s);
    const txnId = await seedTxn(s); // no aiSuggestion

    await s.as.mutation(api.aiCodingData.recordCodingOverride, {
      transactionId: txnId,
      dimension: "budget",
      chosenBudgetId: budgetId,
    });

    expect(await outcomesFor(s, txnId)).toHaveLength(0);
  });
});

describe("codingPrecision", () => {
  test("computes per-dimension precision from the outcome log (ED-gated)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await assignSpecializedRole(s, personId, "executive_director");
    const { fundId, catX, catY } = await seedFundAndCategories(s);
    const budgetId = await seedBudget(s);
    const txnId = await seedTxn(s);
    const now = Date.now();

    await run(s.t, async (ctx) => {
      // Accept: confirms the suggested category (correct).
      await ctx.db.insert("aiCodingOutcomes", {
        chapterId: s.chapterId,
        transactionId: txnId,
        outcome: "accepted",
        suggestedFundId: fundId,
        suggestedCategoryId: catX,
        chosenFundId: fundId,
        chosenCategoryId: catX,
        createdAt: now,
      });
      // Override the category to a different one (incorrect category).
      await ctx.db.insert("aiCodingOutcomes", {
        chapterId: s.chapterId,
        transactionId: txnId,
        outcome: "overridden",
        suggestedCategoryId: catX,
        chosenCategoryId: catY,
        overriddenDimension: "category",
        createdAt: now,
      });
      // Override the budget, choosing exactly the suggested budget (correct
      // budget). Its suggestedCategoryId is present but NOT the resolved
      // dimension, so it must NOT count toward category.
      await ctx.db.insert("aiCodingOutcomes", {
        chapterId: s.chapterId,
        transactionId: txnId,
        outcome: "overridden",
        suggestedCategoryId: catX,
        suggestedBudgetId: budgetId,
        chosenBudgetId: budgetId,
        overriddenDimension: "budget",
        createdAt: now,
      });
    });

    const report = await s.as.query(api.aiCodingData.codingPrecision, {});
    expect(report.sampleSize).toBe(3);
    expect(report.accepted).toBe(1);
    expect(report.overridden).toBe(2);
    // Category: accept(correct) + category-override(incorrect) = 2 claims,
    // 1 correct. The budget-override row's suggested category is unknown.
    expect(report.byDimension.category).toMatchObject({
      claims: 2,
      correct: 1,
      precision: 0.5,
    });
    // Budget: one override that matched the suggestion.
    expect(report.byDimension.budget).toMatchObject({
      claims: 1,
      correct: 1,
      precision: 1,
    });
    // Fund: only the accept proposed one → trivially correct.
    expect(report.byDimension.fund).toMatchObject({ claims: 1, correct: 1 });
  });

  test("rejects a non-ED/FM caller", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper"); // finance seat, but not ED/FM
    await expect(
      s.as.query(api.aiCodingData.codingPrecision, {}),
    ).rejects.toThrow();
  });
});
