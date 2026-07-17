/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { aiCostUsd } from "@events-os/shared";

/**
 * AI usage audit trail (owner condition for allowing a PAID OpenRouter model
 * on finance auto-coding — see `aiCoding.ts`'s header + `schema/aiUsage.ts`):
 *
 *  - `codeTransaction` (via `aiCoding.suggestCoding`/`suggestCodingSystem`)
 *    writes exactly one `aiUsageEvents` row per OpenRouter attempt — success,
 *    a non-200, AND an unparseable-but-200 reply (real tokens were still
 *    billed) — but NO row when the key is unset (no call was ever made).
 *  - Cost prefers the gateway's exact `usage.cost`; else it's estimated from
 *    the model's price table; `rawUsage` always keeps the raw payload.
 *  - `triggeredBy` is "manual" for `suggestCoding`, "sweep" for
 *    `suggestCodingSystem`.
 *  - `acceptSuggestion` backfills `suggestionAccepted: true` onto the LATEST
 *    usage event for that transaction.
 *  - `getUsageSummary` (the Accounts tab's "AI usage" section) is ED/FM-only,
 *    same gate as the rest of that screen, and totals month-to-date
 *    calls/cost/accept-rate + a compact recent-events list.
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

/** Assign a specialized-role TITLE at a scope (direct row insert, mirrors
 *  `financeSeats.test.ts`) — the ED/FM gate `getUsageSummary` shares with the
 *  rest of the Accounts tab. */
async function assignSpecializedRole(
  s: ChapterSetup,
  personId: Id<"people">,
  scope: Id<"chapters"> | "central",
  title: "executive_director" | "finance_manager",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("specializedRoles", {
      personId,
      scope,
      title,
      roleKind: title === "finance_manager" ? "finance" : "leadership",
      createdAt: Date.now(),
    }),
  );
}

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

async function seedTxn(
  s: ChapterSetup,
  extra: Partial<{ personId: Id<"people">; postedAt: number }> = {},
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
    }),
  );
}

function stubOpenRouterOk(content: string, usage?: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }], usage }),
    })),
  );
}

function stubOpenRouterFail(status: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status, json: async () => ({}) })),
  );
}

async function allUsageEvents(s: ChapterSetup) {
  return run(s.t, (ctx) => ctx.db.query("aiUsageEvents").collect());
}

describe("aiUsageEvents — written by codeTransaction (aiCoding.ts)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_MODEL;
  });

  test("no key → no OpenRouter call → no usage event (degrade path)", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const txnId = await seedTxn(s);

    await s.as.action(api.aiCoding.suggestCoding, { transactionId: txnId });

    expect(await allUsageEvents(s)).toHaveLength(0);
  });

  test("a successful manual suggestion writes one 'suggested' event, triggeredBy='manual', cost estimated from usage tokens", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const { fundId, categoryId } = await seedFundAndCategory(s);
    const txnId = await seedTxn(s);

    stubOpenRouterOk(
      JSON.stringify({ fundId, categoryId, confidence: 0.8, rationale: "match" }),
      { prompt_tokens: 120, completion_tokens: 40 },
    );

    await s.as.action(api.aiCoding.suggestCoding, { transactionId: txnId });

    const events = await allUsageEvents(s);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.feature).toBe("finance_auto_coding");
    expect(e.chapterId).toBe(s.chapterId);
    expect(e.triggeredBy).toBe("manual");
    expect(e.subjectTransactionId).toBe(txnId);
    expect(e.outcome).toBe("suggested");
    expect(e.promptTokens).toBe(120);
    expect(e.completionTokens).toBe(40);
    // No gateway `cost` in the mocked usage → estimated from the model's
    // price table (the default paid model, unless OPENROUTER_MODEL is set).
    const expectedCostUsd = aiCostUsd(e.model, {
      inputTokens: 120,
      outputTokens: 40,
    });
    expect(e.costUsdMicros).toBe(Math.round(expectedCostUsd * 1_000_000));
    expect(e.suggestionAccepted).toBeUndefined();
  });

  test("prefers the gateway's exact usage.cost over the estimated price-table cost", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const txnId = await seedTxn(s);

    stubOpenRouterOk(
      JSON.stringify({ confidence: 0.3, rationale: "no strong match" }),
      { prompt_tokens: 200, completion_tokens: 100, cost: 0.0055 },
    );

    await s.as.action(api.aiCoding.suggestCoding, { transactionId: txnId });

    const events = await allUsageEvents(s);
    expect(events).toHaveLength(1);
    expect(events[0].costUsdMicros).toBe(5500);
  });

  test("a sweep-triggered (system) call records triggeredBy='sweep'", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const txnId = await seedTxn(s);

    stubOpenRouterOk(JSON.stringify({ confidence: 0.2, rationale: "n/a" }));

    await s.t.action(internal.aiCoding.suggestCodingSystem, {
      transactionId: txnId,
    });

    const events = await allUsageEvents(s);
    expect(events).toHaveLength(1);
    expect(events[0].triggeredBy).toBe("sweep");
  });

  test("a non-200 OpenRouter response writes a 'failed' event with zeroed usage", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const txnId = await seedTxn(s);

    stubOpenRouterFail(500);

    await s.as.action(api.aiCoding.suggestCoding, { transactionId: txnId });

    const events = await allUsageEvents(s);
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("failed");
    expect(events[0].promptTokens).toBe(0);
    expect(events[0].completionTokens).toBe(0);
    expect(events[0].costUsdMicros).toBe(0);
  });

  test("a network error writes a 'failed' event", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const txnId = await seedTxn(s);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    await s.as.action(api.aiCoding.suggestCoding, { transactionId: txnId });

    const events = await allUsageEvents(s);
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("failed");
  });

  test("a 200 with unparseable content still captures real token usage (billed even though it failed to parse)", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const txnId = await seedTxn(s);

    stubOpenRouterOk("not json at all", {
      prompt_tokens: 80,
      completion_tokens: 20,
    });

    await s.as.action(api.aiCoding.suggestCoding, { transactionId: txnId });

    const events = await allUsageEvents(s);
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("failed");
    expect(events[0].promptTokens).toBe(80);
    expect(events[0].completionTokens).toBe(20);
    expect(events[0].rawUsage).toMatchObject({
      prompt_tokens: 80,
      completion_tokens: 20,
    });
  });

  test("OPENROUTER_MODEL overrides the default model used for the call and logged on the event", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.OPENROUTER_MODEL = "some/other-paid-model";
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const txnId = await seedTxn(s);

    const capture: { body?: any } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        capture.body = JSON.parse(init.body as string);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: '{"confidence":0.1}' } }],
          }),
        };
      }),
    );

    await s.as.action(api.aiCoding.suggestCoding, { transactionId: txnId });

    expect(capture.body.model).toBe("some/other-paid-model");
    const events = await allUsageEvents(s);
    expect(events[0].model).toBe("some/other-paid-model");
  });
});

describe("acceptSuggestion backfills suggestionAccepted on the latest usage event", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENROUTER_API_KEY;
  });

  test("marks the latest event accepted; an older event for the same txn is untouched", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const { fundId, categoryId } = await seedFundAndCategory(s);
    const txnId = await seedTxn(s, {});
    await run(s.t, (ctx) =>
      ctx.db.patch(txnId, {
        aiSuggestion: {
          fundId,
          categoryId,
          confidence: 0.9,
          model: "test/model",
          suggestedAt: Date.now(),
        },
      }),
    );

    const olderEventId = await run(s.t, (ctx) =>
      ctx.db.insert("aiUsageEvents", {
        feature: "finance_auto_coding",
        chapterId: s.chapterId,
        triggeredBy: "sweep",
        subjectTransactionId: txnId,
        model: "test/model",
        promptTokens: 10,
        completionTokens: 5,
        costUsdMicros: 0,
        outcome: "failed",
        createdAt: Date.now() - 60_000,
      }),
    );
    const latestEventId = await run(s.t, (ctx) =>
      ctx.db.insert("aiUsageEvents", {
        feature: "finance_auto_coding",
        chapterId: s.chapterId,
        triggeredBy: "manual",
        subjectTransactionId: txnId,
        model: "test/model",
        promptTokens: 20,
        completionTokens: 10,
        costUsdMicros: 100,
        outcome: "suggested",
        createdAt: Date.now(),
      }),
    );

    await s.as.mutation(api.aiCodingData.acceptSuggestion, {
      transactionId: txnId,
    });

    const older = await run(s.t, (ctx) => ctx.db.get(olderEventId));
    const latest = await run(s.t, (ctx) => ctx.db.get(latestEventId));
    expect(older?.suggestionAccepted).toBeUndefined();
    expect(latest?.suggestionAccepted).toBe(true);
  });

  test("accepting a suggestion with no matching usage event still succeeds (nothing to backfill)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const { fundId } = await seedFundAndCategory(s);
    const txnId = await seedTxn(s, {});
    await run(s.t, (ctx) =>
      ctx.db.patch(txnId, {
        aiSuggestion: { fundId, confidence: 0.9, suggestedAt: Date.now() },
      }),
    );

    const result = await s.as.mutation(api.aiCodingData.acceptSuggestion, {
      transactionId: txnId,
    });
    expect(result).toBeNull();
  });
});

describe("getUsageSummary — ED/FM-gated, same as the rest of the Accounts tab", () => {
  test("rejects a caller with no ED/FM seat", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "manager"); // chapter finance manager ≠ ED/FM

    await expect(
      s.as.query(api.aiCodingData.getUsageSummary, {}),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("rejects an unauthenticated/no-person caller", async () => {
    const t = newT();
    const s = await setupChapter(t);

    await expect(
      s.as.query(api.aiCodingData.getUsageSummary, {}),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("allows a central executive_director", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await assignSpecializedRole(s, personId, "central", "executive_director");

    const result = await s.as.query(api.aiCodingData.getUsageSummary, {});
    expect(result.monthToDate).toBeDefined();
  });

  test("allows a superuser with no grants at all", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });

    const result = await s.as.query(api.aiCodingData.getUsageSummary, {});
    expect(result.monthToDate).toBeDefined();
  });

  test("totals month-to-date calls/cost, computes accept rate from 'suggested' events only, and shapes the recent-events list", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await assignSpecializedRole(s, personId, "central", "finance_manager");
    const cardholderId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Jordan Rivera",
        createdAt: Date.now(),
      }),
    );
    const txnId = await seedTxn(s, { personId: cardholderId });
    const now = Date.now();

    // This month: 1 suggested+accepted, 1 suggested (not accepted), 1 failed.
    await run(s.t, (ctx) =>
      ctx.db.insert("aiUsageEvents", {
        feature: "finance_auto_coding",
        chapterId: s.chapterId,
        triggeredBy: "manual",
        subjectTransactionId: txnId,
        cardholderPersonId: cardholderId,
        model: "anthropic/claude-sonnet-5",
        promptTokens: 100,
        completionTokens: 50,
        costUsdMicros: 1000,
        outcome: "suggested",
        suggestionAccepted: true,
        createdAt: now,
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("aiUsageEvents", {
        feature: "finance_auto_coding",
        chapterId: s.chapterId,
        triggeredBy: "sweep",
        subjectTransactionId: txnId,
        model: "anthropic/claude-sonnet-5",
        promptTokens: 100,
        completionTokens: 50,
        costUsdMicros: 2000,
        outcome: "suggested",
        createdAt: now,
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("aiUsageEvents", {
        feature: "finance_auto_coding",
        chapterId: s.chapterId,
        triggeredBy: "sweep",
        model: "anthropic/claude-sonnet-5",
        promptTokens: 0,
        completionTokens: 0,
        costUsdMicros: 0,
        outcome: "failed",
        createdAt: now,
      }),
    );
    // Last month — must NOT count toward month-to-date totals.
    const lastMonth = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth() - 1,
      15,
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("aiUsageEvents", {
        feature: "finance_auto_coding",
        chapterId: s.chapterId,
        triggeredBy: "sweep",
        model: "anthropic/claude-sonnet-5",
        promptTokens: 500,
        completionTokens: 500,
        costUsdMicros: 99999,
        outcome: "suggested",
        createdAt: lastMonth,
      }),
    );

    const result = await s.as.query(api.aiCodingData.getUsageSummary, {});

    expect(result.monthToDate.calls).toBe(3);
    expect(result.monthToDate.costUsdMicros).toBe(3000);
    expect(result.monthToDate.acceptRate).toBe(0.5); // 1 of 2 suggested accepted

    expect(result.recentEvents.length).toBeGreaterThanOrEqual(3);
    const withCardholder = result.recentEvents.find(
      (e) => e.cardholderName === "Jordan Rivera",
    );
    expect(withCardholder).toBeDefined();
    expect(withCardholder?.merchantName).toBe("Office Depot");
  });
});
