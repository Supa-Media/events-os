import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * AI auto-coding tests (Phase 1, D1 + the sweep/project-proposal follow-up):
 *  - `acceptSuggestion` applies a manually-seeded `aiSuggestion` (bookkeeper),
 *  - it rejects a caller without the bookkeeper role, and a txn with no
 *    suggestion,
 *  - `suggestCoding` degrades to null (no write) when OPENROUTER_API_KEY is
 *    unset. No test ever calls OpenRouter.
 *  - `sweepUnsuggestedTransactions` (the hourly cron trigger) schedules
 *    `aiCoding.suggestCodingSystem` only for unreviewed txns with no
 *    `aiSuggestion` yet, and degrades like the action when the key is unset.
 *  - `writeSuggestion` persists a `projectId` proposal (chapter-validated),
 *    the piece `suggestCoding`/`suggestCodingSystem` now also propose.
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

/** Seed a project in the caller's chapter (for `projectId` proposal tests). */
async function seedProject(s: ChapterSetup): Promise<Id<"projects">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("projects", {
      chapterId: s.chapterId,
      name: "Fall Retreat",
      status: "in_progress",
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
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

  test("rejects a suggestion with no links and leaves status unchanged", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    // Suggestion carries only confidence/rationale — no fund/category/etc.
    const txnId = await seedTxn(s, {
      confidence: 0.4,
      rationale: "Not sure how to code this.",
      model: "test/model",
      suggestedAt: Date.now(),
    });

    await expect(
      s.as.mutation(api.aiCodingData.acceptSuggestion, { transactionId: txnId }),
    ).rejects.toBeInstanceOf(ConvexError);

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.status).toBe("unreviewed"); // unchanged
    expect(txn?.fundId).toBeUndefined();
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

describe("sweepUnsuggestedTransactions (the hourly cron trigger)", () => {
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedKey;
  });

  test("schedules suggestCodingSystem only for unreviewed + unsuggested txns", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);

    // Eligible: unreviewed, no suggestion yet.
    const pendingId = await seedTxn(s);
    // Already suggested — must be skipped even though still unreviewed.
    await seedTxn(s, {
      confidence: 0.5,
      rationale: "Already looked at this one.",
      suggestedAt: Date.now(),
    });
    // Not unreviewed — must be skipped regardless of suggestion state.
    const categorizedId = await seedTxn(s);
    await run(s.t, (ctx) =>
      ctx.db.patch(categorizedId, { status: "categorized" }),
    );

    const result = await s.t.mutation(
      internal.aiCodingData.sweepUnsuggestedTransactions,
      {},
    );
    expect(result).toEqual({ scheduled: 1 });

    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].name).toContain("suggestCodingSystem");
    expect(scheduled[0].args[0]).toMatchObject({ transactionId: pendingId });
  });

  test("re-running the sweep never re-schedules an already-suggested txn", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    await seedTxn(s, { suggestedAt: Date.now() }); // already suggested

    const result = await s.t.mutation(
      internal.aiCodingData.sweepUnsuggestedTransactions,
      {},
    );
    expect(result).toEqual({ scheduled: 0 });

    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(0);
  });

  test("degrades to scheduling nothing when the key is unset", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const t = newT();
    const s = await setupChapter(t);
    await seedTxn(s); // would otherwise be eligible

    const result = await s.t.mutation(
      internal.aiCodingData.sweepUnsuggestedTransactions,
      {},
    );
    expect(result).toEqual({ scheduled: 0 });

    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(0);
  });
});

describe("projectId proposal (writeSuggestion)", () => {
  test("persists a projectId proposal alongside fund/category", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { fundId, categoryId } = await seedFundAndCategory(s);
    const projectId = await seedProject(s);
    const txnId = await seedTxn(s);

    await s.t.mutation(internal.aiCodingData.writeSuggestion, {
      transactionId: txnId,
      fundId,
      categoryId,
      projectId,
      confidence: 0.8,
      rationale: "Matches the Fall Retreat project's usual vendor.",
      model: "test/model",
    });

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.aiSuggestion?.projectId).toEqual(projectId);
    expect(txn?.aiSuggestion?.fundId).toEqual(fundId);
    expect(txn?.aiSuggestion?.categoryId).toEqual(categoryId);
    // The model never moves money or advances status on its own.
    expect(txn?.status).toBe("unreviewed");
    expect(txn?.projectId).toBeUndefined();
  });

  test("rejects a projectId from another chapter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const other = await setupChapter(t, { email: "other@publicworship.life" });
    const foreignProjectId = await seedProject(other);
    const txnId = await seedTxn(s);

    await expect(
      s.t.mutation(internal.aiCodingData.writeSuggestion, {
        transactionId: txnId,
        projectId: foreignProjectId,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("acceptSuggestion applies a projectId proposal", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const projectId = await seedProject(s);
    const txnId = await seedTxn(s, { projectId, suggestedAt: Date.now() });

    await s.as.mutation(api.aiCodingData.acceptSuggestion, {
      transactionId: txnId,
    });

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.projectId).toEqual(projectId);
    expect(txn?.status).toBe("categorized");
  });
});
