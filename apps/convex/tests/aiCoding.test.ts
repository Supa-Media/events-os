import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * AI auto-coding tests (Phase 1, D1):
 *  - `acceptSuggestion` applies a manually-seeded `aiSuggestion` (bookkeeper),
 *  - it rejects a caller without the bookkeeper role, and a txn with no
 *    suggestion,
 *  - and `suggestCoding` degrades to null (no write) when OPENROUTER_API_KEY is
 *    unset. No test ever calls OpenRouter.
 */

/** Insert a roster `people` row linked to the seeded user so `viewerPerson`
 *  resolves the caller. */
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

/** Grant the caller a finance role. */
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

/** Seed a fund + category in the caller's chapter. */
async function seedFundAndCategory(
  s: ChapterSetup,
): Promise<{ fundId: Id<"funds">; categoryId: Id<"budgetCategories"> }> {
  return await run(s.t, async (ctx) => {
    const fundId = await ctx.db.insert("funds", {
      chapterId: s.chapterId,
      name: "General",
      restriction: "unrestricted",
      sortOrder: 0,
      createdAt: Date.now(),
    });
    const categoryId = await ctx.db.insert("budgetCategories", {
      chapterId: s.chapterId,
      fundId,
      name: "Supplies",
      kind: "lineItem",
      createdAt: Date.now(),
    });
    return { fundId, categoryId };
  });
}

/** Insert an unreviewed outflow transaction, optionally with a stored suggestion. */
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

describe("acceptSuggestion", () => {
  test("applies a stored suggestion and marks the txn categorized", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const { fundId, categoryId } = await seedFundAndCategory(s);
    const txnId = await seedTxn(s, {
      fundId,
      categoryId,
      confidence: 0.9,
      rationale: "Office supplies for the General fund.",
      model: "test/model",
      suggestedAt: Date.now(),
    });

    const result = await s.as.mutation(api.aiCodingData.acceptSuggestion, {
      transactionId: txnId,
    });
    expect(result).toBeNull();

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.fundId).toEqual(fundId);
    expect(txn?.categoryId).toEqual(categoryId);
    expect(txn?.status).toBe("categorized");
  });

  test("rejects a caller without the bookkeeper role", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "viewer");
    const { fundId } = await seedFundAndCategory(s);
    const txnId = await seedTxn(s, { fundId, suggestedAt: Date.now() });

    await expect(
      s.as.mutation(api.aiCodingData.acceptSuggestion, { transactionId: txnId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects a txn that has no suggestion", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const txnId = await seedTxn(s); // no aiSuggestion

    await expect(
      s.as.mutation(api.aiCodingData.acceptSuggestion, { transactionId: txnId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("suggestCoding degrade path (no OPENROUTER_API_KEY)", () => {
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedKey;
  });

  test("returns null and writes nothing when the key is unset (bookkeeper)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const txnId = await seedTxn(s);

    const result = await s.as.action(api.aiCoding.suggestCoding, {
      transactionId: txnId,
    });
    expect(result).toBeNull();

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.aiSuggestion).toBeUndefined();
  });

  test("rejects a caller without the bookkeeper role", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "viewer"); // below bookkeeper
    const txnId = await seedTxn(s);

    await expect(
      s.as.action(api.aiCoding.suggestCoding, { transactionId: txnId }),
    ).rejects.toBeInstanceOf(ConvexError);

    // The gate runs before any write, so nothing is persisted.
    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.aiSuggestion).toBeUndefined();
  });
});
