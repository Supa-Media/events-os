import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * AI auto-coding tests (Phase 1, D1 + the sweep/project-proposal follow-up,
 * + the post-review-adversarial-pass fixes):
 *  - `acceptSuggestion` applies a manually-seeded `aiSuggestion` (bookkeeper),
 *  - it rejects a caller without the bookkeeper role, and a txn with no
 *    suggestion,
 *  - it rejects (and never clobbers) a stale suggestion once a human has
 *    already reviewed the transaction — accept, manual re-edit, accept again,
 *  - `suggestCoding` degrades to null (no write) when OPENROUTER_API_KEY is
 *    unset. No test ever calls OpenRouter for real — network failures and
 *    successful replies are both simulated via a stubbed global `fetch`.
 *  - a failed `suggestCoding` attempt (network error, non-200, unparseable
 *    reply) records a lightweight `aiSuggestion.failed` marker so the hourly
 *    sweep doesn't immediately resubmit it, but does retry once the cooldown
 *    passes.
 *  - `sweepUnsuggestedTransactions` (the hourly cron trigger) schedules
 *    `aiCoding.suggestCodingSystem` only for unreviewed txns with no
 *    `aiSuggestion` yet (or a cooled-down failed attempt), and degrades like
 *    the action when the key is unset.
 *  - `writeSuggestion` persists a `budgetId` proposal (chapter-validated) —
 *    WP-U (one home per dollar): the model proposes a BUDGET directly instead
 *    of a separate project/event link, so there's no more dual-proposal
 *    sanitization to worry about (a `budgetId` is a single scalar).
 */

/** Stub OpenRouter's HTTP response as a successful chat completion whose
 *  message content is `content` (already a JSON string). */
function stubOpenRouterOk(content: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
    })),
  );
}

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

/** Insert an unreviewed outflow transaction, optionally with a stored
 *  suggestion and/or a cardholder link (R2 — `personId`/`cardId`/`postedAt`). */
async function seedTxn(
  s: ChapterSetup,
  suggestion?: Record<string, unknown>,
  extra: Partial<{
    personId: Id<"people">;
    cardId: Id<"cards">;
    postedAt: number;
  }> = {},
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: 4200,
      postedAt: extra.postedAt ?? Date.now(),
      merchantName: "Office Depot",
      status: "unreviewed",
      createdAt: Date.now(),
      personId: extra.personId,
      cardId: extra.cardId,
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

/** Seed an event in the caller's chapter, dated `eventDate` (defaults to now,
 *  so it falls inside `loadForSuggestion`'s ± week window). */
async function seedEvent(
  s: ChapterSetup,
  eventDate: number = Date.now(),
  opts: { name?: string; ownerPersonId?: Id<"people"> } = {},
): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Service",
      slug: "service",
      version: 1,
      isArchived: false,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: opts.name ?? "Sunday Gathering",
      eventDate,
      ownerPersonId: opts.ownerPersonId,
      status: "planning",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** Raw-insert a one_time budget for an event or project ref (WP-U: the AI now
 *  proposes a `budgetId` directly, so a test exercising that path needs the
 *  ref's budget to already exist — mirrors what `createEventBudget`/
 *  `createProjectBudget` would have written). */
async function seedRefBudget(
  s: ChapterSetup,
  refKind: "event" | "project",
  scopeRefId: string,
  amountCents = 50000,
): Promise<Id<"budgets">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("budgets", {
      chapterId: s.chapterId,
      amountCents,
      type: "one_time",
      refKind,
      scopeRefId,
      cadence: "per_instance",
      year: 2026,
      createdAt: Date.now(),
    }),
  );
}

/** Whether an event has a one_time budget yet (via `by_ref`) — confirms the
 *  AI never summons one on a rejected/hallucinated proposal. */
async function hasBudgetForEvent(
  s: ChapterSetup,
  eventId: Id<"events">,
): Promise<boolean> {
  const existing = await run(s.t, (ctx) =>
    ctx.db
      .query("budgets")
      .withIndex("by_ref", (q) => q.eq("refKind", "event").eq("scopeRefId", eventId))
      .first(),
  );
  return existing != null;
}

/** Seed a roster `people` row (R2 context tests — the cardholder + their
 *  associated events/projects). Distinct from `seedSelfPerson`, which links a
 *  person to the AUTHENTICATED CALLER; this one is a bare roster row. */
async function seedPerson(
  s: ChapterSetup,
  overrides: Partial<{
    name: string;
    role: string;
    isTeamMember: boolean;
  }> = {},
): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: overrides.name ?? "Jordan Rivera",
      role: overrides.role,
      isTeamMember: overrides.isTeamMember,
      createdAt: Date.now(),
    }),
  );
}

/** Seed a card whose cardholder is `personId` (R2 — `personId`-less txns
 *  resolve the cardholder via `transaction.cardId` → this row). */
async function seedCard(
  s: ChapterSetup,
  cardholderPersonId: Id<"people">,
): Promise<Id<"cards">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("cards", {
      chapterId: s.chapterId,
      cardholderPersonId,
      type: "virtual",
      status: "active",
      createdAt: Date.now(),
    }),
  );
}

/** Seed a volunteer engagement linking `personId` to `eventId` (one of the
 *  R2 person↔event association paths, alongside `roleAssignments` and
 *  `events.ownerPersonId`). */
async function seedEngagement(
  s: ChapterSetup,
  personId: Id<"people">,
  eventId: Id<"events">,
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("engagements", {
      chapterId: s.chapterId,
      eventId,
      personId,
      type: "volunteer",
      status: "confirmed",
      createdAt: Date.now(),
    }),
  );
}

/** Seed a project in the caller's chapter, owned by `ownerPersonId` when
 *  given (R2 — a person's owned projects are one association path). */
async function seedProjectOwnedBy(
  s: ChapterSetup,
  overrides: Partial<{
    name: string;
    ownerPersonId: Id<"people">;
    startDate: number;
    deadline: number;
  }> = {},
): Promise<Id<"projects">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("projects", {
      chapterId: s.chapterId,
      name: overrides.name ?? "Fall Retreat",
      status: "in_progress",
      ownerPersonId: overrides.ownerPersonId,
      startDate: overrides.startDate,
      deadline: overrides.deadline,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

/** Stub OpenRouter's HTTP response as a successful chat completion, AND
 *  capture the request body so a test can inspect the prompt it was sent. */
function stubOpenRouterCapture(content: string): { body: () => any } {
  let captured: any;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string);
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content } }] }),
      };
    }),
  );
  return { body: () => captured };
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

  test("clears the suggestion once applied — accepting twice is a no-op, not a double-apply", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const { fundId, categoryId } = await seedFundAndCategory(s);
    const txnId = await seedTxn(s, {
      fundId,
      categoryId,
      confidence: 0.9,
      suggestedAt: Date.now(),
    });

    await s.as.mutation(api.aiCodingData.acceptSuggestion, {
      transactionId: txnId,
    });
    const txnAfterFirstAccept = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txnAfterFirstAccept?.aiSuggestion).toBeUndefined();

    // Accepting again finds no suggestion left to apply.
    await expect(
      s.as.mutation(api.aiCodingData.acceptSuggestion, { transactionId: txnId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("skips a dangling suggestion.fundId (fund since deleted) but applies the rest", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const { fundId: staleFundId, categoryId } = await seedFundAndCategory(s);
    // Simulate the fund vanishing out from under the stored suggestion (e.g.
    // the WP-1.4 fund-merge migration deleting an extra fund) after the
    // suggestion was written but before it's accepted.
    await run(s.t, (ctx) => ctx.db.delete(staleFundId));
    const txnId = await seedTxn(s, {
      fundId: staleFundId,
      categoryId,
      confidence: 0.9,
      suggestedAt: Date.now(),
    });

    const result = await s.as.mutation(api.aiCodingData.acceptSuggestion, {
      transactionId: txnId,
    });
    expect(result).toBeNull();

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    // The dangling id is skipped, never copied onto the transaction...
    expect(txn?.fundId).toBeUndefined();
    // ...but the rest of the suggestion still applies.
    expect(txn?.categoryId).toEqual(categoryId);
    expect(txn?.status).toBe("categorized");
  });

  test("accept, then a manual re-edit, then a stale late-arriving suggestion can't clobber it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const { fundId: fundA, categoryId: categoryA } = await seedFundAndCategory(s);
    const fundB = await run(s.t, (ctx) =>
      ctx.db.insert("funds", {
        chapterId: s.chapterId,
        name: "Missions",
        restriction: "designated",
        sortOrder: 1,
        createdAt: Date.now(),
      }),
    );
    const categoryB = await run(s.t, (ctx) =>
      ctx.db.insert("budgetCategories", {
        chapterId: s.chapterId,
        fundId: fundB,
        name: "Travel",
        kind: "lineItem",
        createdAt: Date.now(),
      }),
    );

    // The AI proposes fund/category A; the bookkeeper accepts it.
    const txnId = await seedTxn(s, {
      fundId: fundA,
      categoryId: categoryA,
      confidence: 0.9,
      suggestedAt: Date.now(),
    });
    await s.as.mutation(api.aiCodingData.acceptSuggestion, {
      transactionId: txnId,
    });

    // The bookkeeper realizes that was wrong and manually re-codes to B.
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txnId,
      fundId: fundB,
      categoryId: categoryB,
    });
    const afterManualEdit = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(afterManualEdit?.fundId).toEqual(fundB);
    expect(afterManualEdit?.categoryId).toEqual(categoryB);
    // The manual path must also have cleared any (now nonexistent) suggestion.
    expect(afterManualEdit?.aiSuggestion).toBeUndefined();

    // A straggling suggestion computed before the edit lands AFTER it (a real
    // race: `suggestCoding` read the txn, then the human edited, then
    // `writeSuggestion` persisted the now-stale proposal for fund/category A).
    await s.t.mutation(internal.aiCodingData.writeSuggestion, {
      transactionId: txnId,
      fundId: fundA,
      categoryId: categoryA,
      confidence: 0.9,
      rationale: "stale — computed before the manual re-edit",
      model: "test/model",
    });

    // Accepting that stale suggestion must be rejected, not silently reapplied.
    await expect(
      s.as.mutation(api.aiCodingData.acceptSuggestion, { transactionId: txnId }),
    ).rejects.toBeInstanceOf(ConvexError);

    // The manual re-edit to B must survive untouched.
    const finalTxn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(finalTxn?.fundId).toEqual(fundB);
    expect(finalTxn?.categoryId).toEqual(categoryB);
    expect(finalTxn?.status).toBe("categorized");
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

  test("schedules suggestCodingSystem for unreviewed + categorized-but-needs-budget, unsuggested txns", async () => {
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
    // PR fix-suggest-broaden: categorized but STILL missing a budget —
    // now ALSO eligible (the "Needs budget" backlog the owner reported the
    // Reconcile "Suggest" button was missing on).
    const categorizedNeedsBudgetId = await seedTxn(s);
    await run(s.t, (ctx) =>
      ctx.db.patch(categorizedNeedsBudgetId, { status: "categorized" }),
    );
    // FULLY coded (categorized AND budgeted) — must still be skipped, nothing
    // left to suggest.
    const { fundId: fund2, categoryId: category2 } = await seedFundAndCategory(s);
    const budgetId = await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 50000,
        type: "recurring",
        cadence: "yearly",
        year: 2026,
        createdAt: Date.now(),
      }),
    );
    const fullyCodedId = await seedTxn(s);
    await run(s.t, (ctx) =>
      ctx.db.patch(fullyCodedId, {
        status: "categorized",
        fundId: fund2,
        categoryId: category2,
        budgetId,
      }),
    );

    const result = await s.t.mutation(
      internal.aiCodingData.sweepUnsuggestedTransactions,
      {},
    );
    expect(result).toEqual({ scheduled: 2 });

    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(2);
    const scheduledTxnIds = scheduled.map(
      (job) => (job.args[0] as { transactionId: string }).transactionId,
    );
    expect(scheduledTxnIds.sort()).toEqual([pendingId, categorizedNeedsBudgetId].sort());
    for (const job of scheduled) {
      expect(job.name).toContain("suggestCodingSystem");
    }
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

describe("budgetId proposal (writeSuggestion) — WP-U: one home per dollar", () => {
  test("persists a budgetId proposal alongside fund/category", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { fundId, categoryId } = await seedFundAndCategory(s);
    const projectId = await seedProject(s);
    const budgetId = await seedRefBudget(s, "project", projectId);
    const txnId = await seedTxn(s);

    await s.t.mutation(internal.aiCodingData.writeSuggestion, {
      transactionId: txnId,
      fundId,
      categoryId,
      budgetId,
      confidence: 0.8,
      rationale: "Matches the Fall Retreat project's usual vendor.",
      model: "test/model",
    });

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.aiSuggestion?.budgetId).toEqual(budgetId);
    expect(txn?.aiSuggestion?.fundId).toEqual(fundId);
    expect(txn?.aiSuggestion?.categoryId).toEqual(categoryId);
    // The model never moves money or advances status on its own.
    expect(txn?.status).toBe("unreviewed");
    expect(txn?.budgetId).toBeUndefined();
  });

  test("rejects a budgetId from another chapter", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const other = await setupChapter(t, { email: "other@publicworship.life" });
    const foreignProjectId = await seedProject(other);
    const foreignBudgetId = await seedRefBudget(other, "project", foreignProjectId);
    const txnId = await seedTxn(s);

    await expect(
      s.t.mutation(internal.aiCodingData.writeSuggestion, {
        transactionId: txnId,
        budgetId: foreignBudgetId,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("acceptSuggestion applies a budgetId proposal", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const projectId = await seedProject(s);
    const budgetId = await seedRefBudget(s, "project", projectId);
    const txnId = await seedTxn(s, { budgetId, suggestedAt: Date.now() });

    await s.as.mutation(api.aiCodingData.acceptSuggestion, {
      transactionId: txnId,
    });

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.budgetId).toEqual(budgetId);
    expect(txn?.status).toBe("categorized");
  });
});

describe("suggestCoding budgetId sanitization (WP-U: one home per dollar)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("keeps a proposed budgetId that matches a PROJECT's budget in context", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const projectId = await seedProject(s);
    const budgetId = await seedRefBudget(s, "project", projectId);
    const txnId = await seedTxn(s);

    stubOpenRouterOk(
      JSON.stringify({
        budgetId,
        confidence: 0.7,
        rationale: "Matches the Fall Retreat project's usual vendor.",
      }),
    );

    const result = await s.as.action(api.aiCoding.suggestCoding, {
      transactionId: txnId,
    });

    expect(result?.budgetId).toEqual(budgetId);
    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.aiSuggestion?.budgetId).toEqual(budgetId);

    delete process.env.OPENROUTER_API_KEY;
  });

  test("keeps a proposed budgetId that matches an EVENT's budget in context", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const eventId = await seedEvent(s);
    const budgetId = await seedRefBudget(s, "event", eventId);
    const txnId = await seedTxn(s);

    stubOpenRouterOk(
      JSON.stringify({
        budgetId,
        confidence: 0.6,
        rationale: "Matches Sunday Gathering's usual caterer.",
      }),
    );

    const result = await s.as.action(api.aiCoding.suggestCoding, {
      transactionId: txnId,
    });

    expect(result?.budgetId).toEqual(budgetId);
    delete process.env.OPENROUTER_API_KEY;
  });

  test("drops a budgetId proposed for a budget-less event — the model must never invent one", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    // An event with NO budget yet — its context line reads
    // `budgetId=(none — do not select)`.
    const eventId = await seedEvent(s);
    const txnId = await seedTxn(s);
    // A budget from a totally unrelated chapter — stands in for a
    // hallucinated/out-of-context id (never in this chapter's allow-list).
    const other = await setupChapter(t, { email: "other@publicworship.life" });
    const foreignProjectId = await seedProject(other);
    const hallucinatedBudgetId = await seedRefBudget(
      other,
      "project",
      foreignProjectId,
    );

    stubOpenRouterOk(
      JSON.stringify({
        budgetId: hallucinatedBudgetId,
        confidence: 0.5,
        rationale: "Guessed at Sunday Gathering even though it has no budget.",
      }),
    );

    const result = await s.as.action(api.aiCoding.suggestCoding, {
      transactionId: txnId,
    });

    expect(result?.budgetId).toBeUndefined();
    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.aiSuggestion?.budgetId).toBeUndefined();
    // The budget-less event itself is untouched — no budget was summoned.
    expect(await hasBudgetForEvent(s, eventId)).toBe(false);
  });
});

// Review fix: the write-time sanitization allow-lists in `codeTransaction`
// were built ONLY from `context.events`/`context.projects` — the chapter-wide,
// 50-nearest (`EVENT_LIMIT`) lists — excluding `context.person.events`/
// `person.projects` entirely. The prompt explicitly tells the model that a
// match to the CARDHOLDER's own event/project is a strong signal, but a model
// that followed that instruction and proposed exactly such an event got it
// silently dropped as "hallucinated" whenever that event fell outside the
// general window. Fixed by unioning `person.events`/`person.projects` ids
// into the allow-lists before filtering.
describe("suggestCoding survives sanitization for a cardholder-associated id outside the general window", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENROUTER_API_KEY;
  });

  test("a proposal for the cardholder's own event's budget that ISN'T in the general events list still gets written", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const callerPersonId = await seedSelfPerson(s);
    await grantRole(s, callerPersonId, "bookkeeper");
    const cardholderId = await seedPerson(s, { name: "Jordan Rivera" });
    const postedAt = Date.now();

    // The cardholder's own event, associated via an `engagements` row, dated
    // far enough back that it will NOT be among the chapter-wide 50-nearest
    // events (`EVENT_LIMIT`) once the 50 filler events below crowd it out.
    const farEventId = await seedEvent(s, postedAt - 1000 * DAY_MS, {
      name: "Cardholder's Far Event",
    });
    await seedEngagement(s, cardholderId, farEventId);
    const farBudgetId = await seedRefBudget(s, "event", farEventId);

    // 50 unrelated events, each closer to `postedAt` than the far event, so
    // the chapter-wide query's nearest-50-before scan is fully occupied by
    // these and never even fetches the far event.
    for (let i = 1; i <= 50; i++) {
      await seedEvent(s, postedAt - i * DAY_MS, { name: `Filler ${i}` });
    }

    const txnId = await seedTxn(s, undefined, {
      personId: cardholderId,
      postedAt,
    });

    // Sanity check: confirm the far event really is excluded from the
    // general list but present (WITH its budgetId) in the cardholder's own
    // associated list — otherwise this test wouldn't actually exercise the fix.
    const context = await s.t.query(
      internal.aiCodingData.loadForSuggestionSystem,
      { transactionId: txnId },
    );
    expect(context.events.map((e) => e._id)).not.toContain(farEventId);
    const personFarEvent = context.person?.events.find((e) => e._id === farEventId);
    expect(personFarEvent).toBeDefined();
    expect(personFarEvent?.budgetId).toEqual(farBudgetId);

    stubOpenRouterOk(
      JSON.stringify({
        budgetId: farBudgetId,
        confidence: 0.8,
        rationale: "Matches the cardholder's own event.",
      }),
    );

    const result = await s.as.action(api.aiCoding.suggestCoding, {
      transactionId: txnId,
    });

    expect(result?.budgetId).toEqual(farBudgetId);
    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.aiSuggestion?.budgetId).toEqual(farBudgetId);
  });
});

describe("a failed suggestCoding attempt doesn't get immediately re-swept", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENROUTER_API_KEY;
  });

  test("suggestCoding records a failed-attempt marker (not a rethrow) on a non-200", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const txnId = await seedTxn(s);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );

    const result = await s.as.action(api.aiCoding.suggestCoding, {
      transactionId: txnId,
    });
    expect(result).toBeNull();

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.aiSuggestion?.failed).toBe(true);
    expect(txn?.aiSuggestion?.suggestedAt).toBeTypeOf("number");
    // No links were (or could be) proposed on a failed attempt.
    expect(txn?.aiSuggestion?.fundId).toBeUndefined();
    expect(txn?.aiSuggestion?.budgetId).toBeUndefined();
  });

  test("the hourly sweep skips a transaction whose failed attempt is still within cooldown", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    // Recently failed — must stay skipped (still cooling down).
    await seedTxn(s, {
      failed: true,
      rationale: "OpenRouter call failed (500).",
      model: "test/model",
      suggestedAt: Date.now(),
    });
    // An ordinary never-attempted txn in the same sweep — proves the skip
    // above is specifically the cooldown, not a broken/no-op sweep.
    const untouchedId = await seedTxn(s);

    const result = await s.t.mutation(
      internal.aiCodingData.sweepUnsuggestedTransactions,
      {},
    );
    expect(result).toEqual({ scheduled: 1 });

    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].args[0]).toMatchObject({ transactionId: untouchedId });
  });

  test("the hourly sweep DOES retry once the failed attempt is past the cooldown window", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const STALE_FAILURE_MS = Date.now() - 25 * 60 * 60 * 1000; // 25h ago (>24h cooldown)
    const txnId = await seedTxn(s, {
      failed: true,
      rationale: "OpenRouter call failed (500).",
      model: "test/model",
      suggestedAt: STALE_FAILURE_MS,
    });

    const result = await s.t.mutation(
      internal.aiCodingData.sweepUnsuggestedTransactions,
      {},
    );
    expect(result).toEqual({ scheduled: 1 });

    const scheduled = await run(s.t, (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].args[0]).toMatchObject({ transactionId: txnId });
  });
});

// #132's review flagged that no test exercised the FULL pipeline (mocked
// OpenRouter fetch -> suggestCoding -> parseModelJson -> sanitize ->
// writeSuggestion) with a garbled/unparseable reply, or with a fund/category
// proposal (only projectId/eventId sanitization was covered end-to-end
// above; fund/category were otherwise only exercised via a direct
// `writeSuggestion` mutation call in the `acceptSuggestion` tests).
describe("suggestCoding round-trip via mocked OpenRouter fetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENROUTER_API_KEY;
  });

  test("a 200 response with unparseable JSON content records a failed-attempt marker, same as a non-200", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const txnId = await seedTxn(s);

    // 200 OK, but the message content isn't JSON at all — parseModelJson
    // must fail closed here, not throw out of the action.
    stubOpenRouterOk("Sorry, I can't help with that request.");

    const result = await s.as.action(api.aiCoding.suggestCoding, {
      transactionId: txnId,
    });
    expect(result).toBeNull();

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.aiSuggestion?.failed).toBe(true);
    expect(txn?.aiSuggestion?.fundId).toBeUndefined();
    expect(txn?.aiSuggestion?.budgetId).toBeUndefined();
  });

  test("a full mocked-fetch run proposing fundId + categoryId writes both through to the transaction", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const { fundId, categoryId } = await seedFundAndCategory(s);
    const txnId = await seedTxn(s);

    stubOpenRouterOk(
      JSON.stringify({
        fundId,
        categoryId,
        confidence: 0.8,
        rationale: "Matches recent Office Depot supply purchases.",
      }),
    );

    const result = await s.as.action(api.aiCoding.suggestCoding, {
      transactionId: txnId,
    });

    expect(result?.fundId).toEqual(fundId);
    expect(result?.categoryId).toEqual(categoryId);

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.aiSuggestion?.fundId).toEqual(fundId);
    expect(txn?.aiSuggestion?.categoryId).toEqual(categoryId);
    expect(txn?.aiSuggestion?.failed).toBeFalsy();
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;

// R2: enrich the coding context with the CARDHOLDER (person + their own
// associated events/projects) and rank candidate events/projects by
// proximity to the charge's `postedAt` instead of a flat list. These tests
// exercise `gatherSuggestionContext` through `loadForSuggestionSystem` (the
// no-auth loader) directly — no OpenRouter call is needed to verify the
// context it hands the model.
describe("R2: cardholder context (gatherSuggestionContext)", () => {
  test("includes the cardholder's associated events/projects when transaction.personId is set (name omitted — PII minimization)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedPerson(s, {
      name: "Jordan Rivera",
      role: "Videographer",
      isTeamMember: true,
    });
    // Associated via `events.ownerPersonId` (owns the event outright).
    const ownedEventId = await seedEvent(s, Date.now(), {
      name: "Owned Event",
      ownerPersonId: personId,
    });
    // Associated via `engagements` (a volunteer engagement, not ownership).
    const engagedEventId = await seedEvent(s, Date.now() + DAY_MS, {
      name: "Engaged Event",
    });
    await seedEngagement(s, personId, engagedEventId);
    // Associated via `projects.ownerPersonId`.
    const projectId = await seedProjectOwnedBy(s, {
      name: "Owned Project",
      ownerPersonId: personId,
    });
    const txnId = await seedTxn(s, undefined, { personId });

    const context = await s.t.query(
      internal.aiCodingData.loadForSuggestionSystem,
      { transactionId: txnId },
    );

    expect(context.person?._id).toEqual(personId);
    // `name` is deliberately NOT part of the context shape — see aiCoding.ts.
    expect(context.person).not.toHaveProperty("name");
    expect(context.person?.role).toBe("Videographer");
    expect(context.person?.isTeamMember).toBe(true);
    const personEventIds = context.person?.events.map((e) => e._id);
    expect(personEventIds).toContain(ownedEventId);
    expect(personEventIds).toContain(engagedEventId);
    expect(context.person?.projects.map((p) => p._id)).toContain(projectId);
  });

  test("resolves the cardholder via cardId when personId is unset", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedPerson(s, { name: "Sam Okafor" });
    const cardId = await seedCard(s, personId);
    const txnId = await seedTxn(s, undefined, { cardId });

    const context = await s.t.query(
      internal.aiCodingData.loadForSuggestionSystem,
      { transactionId: txnId },
    );

    expect(context.person?._id).toEqual(personId);
  });

  test("omits person context gracefully when the txn has neither personId nor cardId", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const txnId = await seedTxn(s); // no personId, no cardId

    const context = await s.t.query(
      internal.aiCodingData.loadForSuggestionSystem,
      { transactionId: txnId },
    );

    expect(context.person).toBeUndefined();
  });
});

describe("R2: date-window ranking (gatherSuggestionContext)", () => {
  test("an event 3 days from postedAt outranks one 200 days away", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const postedAt = Date.now();
    const nearEventId = await seedEvent(s, postedAt + 3 * DAY_MS, {
      name: "Near Event",
    });
    const farEventId = await seedEvent(s, postedAt + 200 * DAY_MS, {
      name: "Far Event",
    });
    const txnId = await seedTxn(s, undefined, { postedAt });

    const context = await s.t.query(
      internal.aiCodingData.loadForSuggestionSystem,
      { transactionId: txnId },
    );

    const eventIds = context.events.map((e) => e._id);
    const nearIndex = eventIds.indexOf(nearEventId);
    const farIndex = eventIds.indexOf(farEventId);
    expect(nearIndex).toBeGreaterThanOrEqual(0);
    expect(farIndex).toBeGreaterThanOrEqual(0);
    expect(nearIndex).toBeLessThan(farIndex);
  });

  test("projects are ranked by proximity to postedAt via startDate/deadline; undated projects sort last", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const postedAt = Date.now();
    const nearProjectId = await seedProjectOwnedBy(s, {
      name: "Near Project",
      startDate: postedAt + 5 * DAY_MS,
    });
    const farProjectId = await seedProjectOwnedBy(s, {
      name: "Far Project",
      deadline: postedAt + 300 * DAY_MS,
    });
    const undatedProjectId = await seedProjectOwnedBy(s, {
      name: "Undated Project",
    });
    const txnId = await seedTxn(s, undefined, { postedAt });

    const context = await s.t.query(
      internal.aiCodingData.loadForSuggestionSystem,
      { transactionId: txnId },
    );

    const projectIds = context.projects.map((p) => p._id);
    const nearIndex = projectIds.indexOf(nearProjectId);
    const farIndex = projectIds.indexOf(farProjectId);
    const undatedIndex = projectIds.indexOf(undatedProjectId);
    expect(nearIndex).toBeLessThan(farIndex);
    expect(farIndex).toBeLessThan(undatedIndex);
  });
});

describe("R2: prompt shape includes cardholder + ranked date-proximity sections", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENROUTER_API_KEY;
  });

  test("the prompt sent to OpenRouter carries a CARDHOLDER section and ranked EVENTS/PROJECTS headers", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const callerPersonId = await seedSelfPerson(s);
    await grantRole(s, callerPersonId, "bookkeeper");
    const cardholderId = await seedPerson(s, {
      name: "Jordan Rivera",
      role: "Videographer",
    });
    const postedAt = Date.now();
    const nearEventId = await seedEvent(s, postedAt + 3 * DAY_MS, {
      name: "Near Event",
      ownerPersonId: cardholderId,
    });
    const txnId = await seedTxn(
      s,
      undefined,
      { personId: cardholderId, postedAt },
    );

    const capture = stubOpenRouterCapture(
      JSON.stringify({ confidence: 0.5, rationale: "no strong match" }),
    );

    await s.as.action(api.aiCoding.suggestCoding, { transactionId: txnId });

    const body = capture.body();
    const systemMsg: string = body.messages[0].content;
    const userMsg: string = body.messages[1].content;

    // The system prompt instructs the model to weigh cardholder association
    // and date proximity, not just treat every list as flat/unordered.
    expect(systemMsg).toContain("CARDHOLDER");
    expect(systemMsg.toLowerCase()).toContain("ranked nearest");

    // The user prompt carries the actual cardholder section + ranked headers.
    expect(userMsg).toContain("CARDHOLDER");
    expect(userMsg).toContain("role: Videographer");
    expect(userMsg).toContain("EVENTS (ranked nearest the charge date first)");
    expect(userMsg).toContain("PROJECTS (ranked, most relevant first)");
    // Merchant/description/amount (#3) were already in the prompt pre-R2 —
    // confirm they're still there alongside the new sections.
    expect(userMsg).toContain("merchant: Office Depot");
    expect(userMsg).toContain("amount: 42.00 (outflow)");
    // The cardholder's own associated event is listed (by name — it has no
    // budget yet, so its line reads `budgetId=(none — do not select)`, WP-U),
    // with its day-offset label.
    expect(userMsg).toContain('name="Near Event"');
    expect(userMsg).toContain("(none — do not select)");
    expect(userMsg).toContain("(+3d)");
    // PII minimization: the cardholder's NAME never leaves for OpenRouter —
    // neither message references it, even though it's on the roster record.
    expect(systemMsg).not.toContain("Jordan Rivera");
    expect(userMsg).not.toContain("Jordan Rivera");
    expect(userMsg).not.toContain("name:");
  });

  test("the prompt shows '(no cardholder on file...)' when the txn has no resolvable person", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const callerPersonId = await seedSelfPerson(s);
    await grantRole(s, callerPersonId, "bookkeeper");
    const txnId = await seedTxn(s); // no personId, no cardId

    const capture = stubOpenRouterCapture(
      JSON.stringify({ confidence: 0.3, rationale: "no match" }),
    );

    await s.as.action(api.aiCoding.suggestCoding, { transactionId: txnId });

    const userMsg: string = capture.body().messages[1].content;
    expect(userMsg).toContain(
      "CARDHOLDER\n(no cardholder on file for this transaction)",
    );
  });
});

// ── PR fix-suggest-broaden ───────────────────────────────────────────────────
// The owner-reported bug: PR #265's per-row "Suggest" button only ever
// rendered on an UNREVIEWED row with no suggestion — a "Categorized" row that
// still showed "Needs budget" (the majority of the backlog) got a bare "—"
// with no way to trigger a suggestion. `finances.isSuggestible` is the ONE
// predicate now shared by the button (`ReconcileList.tsx`), the on-demand
// gate below (`loadForSuggestion`), and the sweep (`isEligibleForSuggestion`,
// covered above in "sweepUnsuggestedTransactions").
describe("PR fix-suggest-broaden: on-demand suggestCoding on a categorized+needs-budget row", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENROUTER_API_KEY;
  });

  /** Raw-insert a transaction with full control over status/links/isPersonal —
   *  `seedTxn` above only ever produces an `unreviewed` row. */
  async function seedTxnWith(
    s: ChapterSetup,
    overrides: Partial<{
      status: "unreviewed" | "categorized" | "reconciled" | "excluded";
      flow: "inflow" | "outflow" | "transfer";
      budgetId: Id<"budgets">;
      categoryId: Id<"budgetCategories">;
      fundId: Id<"funds">;
      isPersonal: boolean;
    }>,
  ): Promise<Id<"transactions">> {
    return await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: overrides.flow ?? "outflow",
        amountCents: 4200,
        postedAt: Date.now(),
        merchantName: "Office Depot",
        status: overrides.status ?? "unreviewed",
        budgetId: overrides.budgetId,
        categoryId: overrides.categoryId,
        fundId: overrides.fundId,
        isPersonal: overrides.isPersonal,
        createdAt: Date.now(),
      }),
    );
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

  test("succeeds on a categorized row that still needs a budget", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const { fundId, categoryId } = await seedFundAndCategory(s);
    const txnId = await seedTxnWith(s, { status: "categorized", fundId, categoryId });

    stubOpenRouterOk(
      JSON.stringify({
        categoryId,
        confidence: 0.7,
        rationale: "Matches the existing category; still needs a budget.",
      }),
    );

    const result = await s.as.action(api.aiCoding.suggestCoding, {
      transactionId: txnId,
    });
    expect(result).not.toBeNull();

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.aiSuggestion?.categoryId).toEqual(categoryId);
    // The model never moves money or advances status on its own.
    expect(txn?.status).toBe("categorized");
    expect(txn?.budgetId).toBeUndefined();
  });

  test("rejects a categorized row that already has a budget attached", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const budgetId = await seedBudget(s);
    const txnId = await seedTxnWith(s, { status: "categorized", budgetId });

    await expect(
      s.as.action(api.aiCoding.suggestCoding, { transactionId: txnId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects a reconciled (treasurer-closed) row, even with no budget", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const txnId = await seedTxnWith(s, { status: "reconciled" });

    await expect(
      s.as.action(api.aiCoding.suggestCoding, { transactionId: txnId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects an excluded row", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const txnId = await seedTxnWith(s, { status: "excluded" });

    await expect(
      s.as.action(api.aiCoding.suggestCoding, { transactionId: txnId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects a personal charge, even if categorized with no budget", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const txnId = await seedTxnWith(s, { status: "categorized", isPersonal: true });

    await expect(
      s.as.action(api.aiCoding.suggestCoding, { transactionId: txnId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("still succeeds on a plain unreviewed row (unchanged rule)", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const txnId = await seedTxnWith(s, { status: "unreviewed" });

    stubOpenRouterOk(JSON.stringify({ confidence: 0.3, rationale: "no strong match" }));

    const result = await s.as.action(api.aiCoding.suggestCoding, {
      transactionId: txnId,
    });
    expect(result).not.toBeNull();
  });
});

describe("PR fix-suggest-broaden: acceptSuggestion staleness (baseline diff)", () => {
  /** Raw-insert a transaction with full control over status/links. */
  async function seedTxnWith(
    s: ChapterSetup,
    overrides: Partial<{
      status: "unreviewed" | "categorized" | "reconciled" | "excluded";
      budgetId: Id<"budgets">;
      categoryId: Id<"budgetCategories">;
      fundId: Id<"funds">;
    }>,
  ): Promise<Id<"transactions">> {
    return await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 4200,
        postedAt: Date.now(),
        merchantName: "Office Depot",
        status: overrides.status ?? "unreviewed",
        budgetId: overrides.budgetId,
        categoryId: overrides.categoryId,
        fundId: overrides.fundId,
        createdAt: Date.now(),
      }),
    );
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

  test("accepts a categorized+needs-budget row's suggestion when nothing changed since", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const { fundId, categoryId } = await seedFundAndCategory(s);
    const txnId = await seedTxnWith(s, { status: "categorized", fundId, categoryId });
    const proposedBudgetId = await seedBudget(s);

    // Mirrors what `codeTransaction` would write: baseline = what the loader
    // read BEFORE the model call (categorized, this fund/category, no budget).
    await s.t.mutation(internal.aiCodingData.writeSuggestion, {
      transactionId: txnId,
      budgetId: proposedBudgetId,
      confidence: 0.8,
      rationale: "Matches the usual vendor for this budget.",
      model: "test/model",
      baseline: { status: "categorized", fundId, categoryId, budgetId: null },
    });

    await s.as.mutation(api.aiCodingData.acceptSuggestion, {
      transactionId: txnId,
    });

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.budgetId).toEqual(proposedBudgetId);
    expect(txn?.status).toBe("categorized");
    expect(txn?.aiSuggestion).toBeUndefined();
  });

  test("rejects a stale suggestion when a manual edit raced it (budget attached in between)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const { fundId, categoryId } = await seedFundAndCategory(s);
    const txnId = await seedTxnWith(s, { status: "categorized", fundId, categoryId });
    const staleBudgetId = await seedBudget(s);
    const realBudgetId = await seedBudget(s);

    // The bookkeeper manually attaches a budget via the "For" picker WHILE a
    // suggestion is in flight — this already clears any stored suggestion
    // (`categorizeTransaction`'s own rule), same as production.
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txnId,
      budgetId: realBudgetId,
    });

    // A straggling suggestion computed BEFORE that edit lands AFTER it (the
    // real race `codeTransaction` can hit: `loadForSuggestion` read the txn
    // with budgetId still null, then the human edited, then `writeSuggestion`
    // persisted the now-stale proposal). Its baseline reflects the OLD
    // (pre-edit) state, not the current one.
    await s.t.mutation(internal.aiCodingData.writeSuggestion, {
      transactionId: txnId,
      budgetId: staleBudgetId,
      confidence: 0.8,
      rationale: "stale — computed before the manual budget attach",
      model: "test/model",
      baseline: { status: "categorized", fundId, categoryId, budgetId: null },
    });

    await expect(
      s.as.mutation(api.aiCodingData.acceptSuggestion, { transactionId: txnId }),
    ).rejects.toBeInstanceOf(ConvexError);

    // The manual attach must survive untouched — never clobbered by the stale proposal.
    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.budgetId).toEqual(realBudgetId);
  });

  test("legacy suggestion with no baseline still falls back to the unreviewed-only gate", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const { fundId, categoryId } = await seedFundAndCategory(s);
    // Categorized (needs budget) but the suggestion was seeded directly with
    // no `baseline` — mirrors a suggestion written before this field existed.
    const txnId = await seedTxnWith(s, { status: "categorized", fundId, categoryId });
    const budgetId = await seedBudget(s);
    await run(s.t, (ctx) =>
      ctx.db.patch(txnId, {
        aiSuggestion: { budgetId, confidence: 0.5, suggestedAt: Date.now() },
      }),
    );

    // No baseline -> falls back to "must still be exactly unreviewed", which
    // this categorized row isn't — rejected, even though nothing raced it.
    await expect(
      s.as.mutation(api.aiCodingData.acceptSuggestion, { transactionId: txnId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  // Review pin tests (PR #269 adversarial review, observations 1 + coverage nit).

  test("an unrelated human edit (note, receipt) survives Accept untouched", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const { fundId, categoryId } = await seedFundAndCategory(s);
    const txnId = await seedTxnWith(s, { status: "categorized", fundId, categoryId });
    const proposedBudgetId = await seedBudget(s);

    await s.t.mutation(internal.aiCodingData.writeSuggestion, {
      transactionId: txnId,
      budgetId: proposedBudgetId,
      confidence: 0.8,
      rationale: "Matches the usual vendor for this budget.",
      model: "test/model",
      baseline: { status: "categorized", fundId, categoryId, budgetId: null },
    });

    // Neither field is baseline-tracked — a bookkeeper jotting a note or
    // attaching a receipt WHILE a suggestion sits pending must never be
    // treated as "raced" staleness, and `acceptSuggestion`'s patch (status/
    // fund/category/budget/aiSuggestion only) must never clobber them.
    await s.as.mutation(api.finances.setTransactionNote, {
      transactionId: txnId,
      note: "Reimbursed by the youth group budget line.",
    });
    const receiptId = (await run(s.t, (ctx) =>
      (ctx.storage as unknown as { store: (b: Blob) => Promise<Id<"_storage">> }).store(
        new Blob(["receipt"], { type: "text/plain" }),
      ),
    )) as Id<"_storage">;
    await s.as.mutation(api.finances.attachReceipt, {
      transactionId: txnId,
      storageId: receiptId,
    });

    await s.as.mutation(api.aiCodingData.acceptSuggestion, {
      transactionId: txnId,
    });

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.budgetId).toEqual(proposedBudgetId);
    expect(txn?.note).toBe("Reimbursed by the youth group budget line.");
    expect(txn?.receiptStorageId).toEqual(receiptId);
  });

  test("rejects accept once the charge is flagged personal after the suggestion was computed", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const { fundId, categoryId } = await seedFundAndCategory(s);
    const txnId = await seedTxnWith(s, { status: "categorized", fundId, categoryId });
    // The caller IS the cardholder, so `flagPersonalCharge`'s
    // cardholder-or-manager gate is satisfied by the "bookkeeper" role
    // already granted above.
    const cardId = await run(s.t, (ctx) =>
      ctx.db.insert("cards", {
        chapterId: s.chapterId,
        cardholderPersonId: personId,
        type: "virtual",
        status: "active",
        createdAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) => ctx.db.patch(txnId, { cardId }));
    const proposedBudgetId = await seedBudget(s);

    // A suggestion is computed while the charge still looks like ordinary
    // chapter spend — baseline captures fund/category/budget/status exactly
    // as they stand (none of which `flagPersonalCharge` below touches).
    await s.t.mutation(internal.aiCodingData.writeSuggestion, {
      transactionId: txnId,
      budgetId: proposedBudgetId,
      confidence: 0.8,
      rationale: "Matches the usual vendor for this budget.",
      model: "test/model",
      baseline: { status: "categorized", fundId, categoryId, budgetId: null },
    });

    // The cardholder realizes it was a personal charge and flags it — this
    // sets `isPersonal` WITHOUT touching `aiSuggestion` or any baseline field,
    // so the baseline diff alone would NOT catch this (review observation 1).
    await s.as.mutation(api.cards.flagPersonalCharge, { transactionId: txnId });

    await expect(
      s.as.mutation(api.aiCodingData.acceptSuggestion, { transactionId: txnId }),
    ).rejects.toBeInstanceOf(ConvexError);

    // Never attached — the now-personal charge stays budget-less.
    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.budgetId).toBeUndefined();
    expect(txn?.isPersonal).toBe(true);
  });
});
