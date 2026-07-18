/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * ON-INGEST AI-coding suggestion tests — the owner's ask that a charge gets a
 * coding suggestion AS IT ARRIVES, not just on the old hourly-only cron
 * (`aiCodingData.ts`'s `scheduleSuggestionOnIngest` / `ingestSuggestionSweep` /
 * `runSuggestionSweep`):
 *
 *  - inserting an eligible transaction via either ingest path (the Increase
 *    webhook apply mutation, `increase.applyIncreaseCardTransaction`; the
 *    manual-add mutation, `finances.createManualTransaction`) schedules
 *    EXACTLY ONE debounced `ingestSuggestionSweep` job — a burst of several
 *    eligible arrivals within the debounce window still schedules only one
 *    (burst safety: the mutex in `aiCodingIngestState`),
 *  - a central-owned charge, and a manual entry submitted already coded,
 *    never wake the debounce (nothing to suggest),
 *  - with `OPENROUTER_API_KEY` unset, neither ingest path schedules anything
 *    at all — this is also what keeps every OTHER finance/increase test in
 *    this suite (which doesn't set the key) leak-free: no new scheduled
 *    function is created for them,
 *  - `ingestSuggestionSweep` clears the debounce mutex and schedules
 *    `aiCoding.suggestCodingSystem` (labelled `triggeredBy:"ingest"` for the
 *    audit trail) for each still-eligible transaction, using the exact same
 *    eligibility rule + `SWEEP_BATCH` cap as the hourly cron — never
 *    double-suggesting a txn that already carries a proposal,
 *  - end to end: a charge lands, the debounced sweep fires, and the
 *    transaction comes out the other side with a real `aiSuggestion` +
 *    an `aiUsageEvents` row crediting `"ingest"`.
 */

// ── shared seed helpers (mirrors aiCoding.test.ts / increaseCards.test.ts) ──

async function seedIncreaseAccount(
  s: ChapterSetup,
  increaseAccountId: string,
  chapterId: Id<"chapters"> | "central" = s.chapterId,
): Promise<void> {
  const now = Date.now();
  await run(s.t, (ctx) =>
    ctx.db.insert("increaseAccounts", {
      chapterId,
      sandbox: false,
      onboardingStatus: "active",
      increaseEntityId: "entity_shared_org",
      increaseAccountId,
      createdAt: now,
      updatedAt: now,
    }),
  );
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

async function asBookkeeper(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "bookkeeper",
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

/** Every scheduled `_scheduled_functions` row (name + first arg), for
 *  asserting on WHAT got scheduled without firing it. */
async function scheduledJobs(
  s: ChapterSetup,
): Promise<{ name: string; args: unknown }[]> {
  const rows = await run(s.t, (ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  return rows.map((r) => ({ name: r.name, args: r.args[0] }));
}

async function ingestState(s: ChapterSetup) {
  return await run(s.t, (ctx) => ctx.db.query("aiCodingIngestState").first());
}

/** Stub OpenRouter's HTTP response as a successful chat completion whose
 *  message content is `content` (already a JSON string) — mirrors
 *  aiCoding.test.ts's identical helper. */
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

// ── env save/restore (OPENROUTER_API_KEY toggles the whole feature) ────────

describe("on-ingest AI-coding suggestions", () => {
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedKey;
    vi.unstubAllGlobals();
  });

  describe("Increase webhook apply path (applyIncreaseCardTransaction)", () => {
    test("an eligible chapter charge schedules exactly one debounced ingest sweep", async () => {
      process.env.OPENROUTER_API_KEY = "test-key";
      vi.useFakeTimers();
      try {
        const t = newT();
        const s = await setupChapter(t);
        await seedIncreaseAccount(s, "account_x");

        await t.mutation(internal.increase.applyIncreaseCardTransaction, {
          externalId: "txn_1",
          accountId: "account_x",
          flow: "outflow",
          amountCents: 4200,
          postedAt: Date.now(),
          merchantName: "Office Depot",
        });

        const state = await ingestState(s);
        expect(state?.pending).toBe(true);

        const jobs = await scheduledJobs(s);
        expect(jobs).toHaveLength(1);
        expect(jobs[0].name).toContain("ingestSuggestionSweep");
      } finally {
        vi.useRealTimers();
      }
    });

    test("a burst of several eligible charges still schedules only ONE ingest sweep (debounce)", async () => {
      process.env.OPENROUTER_API_KEY = "test-key";
      vi.useFakeTimers();
      try {
        const t = newT();
        const s = await setupChapter(t);
        await seedIncreaseAccount(s, "account_x");

        for (let i = 0; i < 5; i++) {
          await t.mutation(internal.increase.applyIncreaseCardTransaction, {
            externalId: `txn_burst_${i}`,
            accountId: "account_x",
            flow: "outflow",
            amountCents: 1000 + i,
            postedAt: Date.now(),
            merchantName: "Burst Merchant",
          });
        }

        // Still exactly one pending sweep — every arrival after the first was
        // absorbed by the mutex, not scheduled its own.
        const jobs = await scheduledJobs(s);
        const sweeps = jobs.filter((j) => j.name.includes("ingestSuggestionSweep"));
        expect(sweeps).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    test("a central-owned charge never wakes the debounce (central isn't auto-coded)", async () => {
      process.env.OPENROUTER_API_KEY = "test-key";
      vi.useFakeTimers();
      try {
        const t = newT();
        const s = await setupChapter(t);
        await seedIncreaseAccount(s, "account_central", "central");

        await t.mutation(internal.increase.applyIncreaseCardTransaction, {
          externalId: "txn_central",
          accountId: "account_central",
          flow: "outflow",
          amountCents: 1500,
          postedAt: Date.now(),
        });

        expect(await ingestState(s)).toBeNull();
        expect(await scheduledJobs(s)).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    test("degrades to scheduling nothing when OPENROUTER_API_KEY is unset", async () => {
      delete process.env.OPENROUTER_API_KEY;
      const t = newT();
      const s = await setupChapter(t);
      await seedIncreaseAccount(s, "account_x");

      await t.mutation(internal.increase.applyIncreaseCardTransaction, {
        externalId: "txn_nokey",
        accountId: "account_x",
        flow: "outflow",
        amountCents: 4200,
        postedAt: Date.now(),
      });

      // No mutex row, no scheduled function — this is also what keeps every
      // OTHER (non-AI) test that calls this mutation leak-free.
      expect(await ingestState(s)).toBeNull();
      expect(await scheduledJobs(s)).toHaveLength(0);
    });
  });

  describe("manual-add path (createManualTransaction)", () => {
    test("an unreviewed manual entry schedules the debounced ingest sweep", async () => {
      process.env.OPENROUTER_API_KEY = "test-key";
      vi.useFakeTimers();
      try {
        const t = newT();
        const s = await setupChapter(t);
        await asBookkeeper(s);

        await s.as.mutation(api.finances.createManualTransaction, {
          flow: "outflow",
          amountCents: 2500,
          postedAt: Date.now(),
          merchantName: "Hardware Store",
        });

        expect((await ingestState(s))?.pending).toBe(true);
        expect(await scheduledJobs(s)).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    test("a manual entry submitted already-categorized does NOT wake the debounce", async () => {
      process.env.OPENROUTER_API_KEY = "test-key";
      vi.useFakeTimers();
      try {
        const t = newT();
        const s = await setupChapter(t);
        await asBookkeeper(s);
        const categoryId = await run(s.t, async (ctx) => {
          const fundId = await ctx.db.insert("funds", {
            chapterId: s.chapterId,
            name: "General",
            restriction: "unrestricted",
            sortOrder: 0,
            createdAt: Date.now(),
          });
          return await ctx.db.insert("budgetCategories", {
            chapterId: s.chapterId,
            fundId,
            name: "Supplies",
            kind: "lineItem",
            createdAt: Date.now(),
          });
        });

        await s.as.mutation(api.finances.createManualTransaction, {
          flow: "outflow",
          amountCents: 2500,
          postedAt: Date.now(),
          categoryId,
        });

        // Already `status:"categorized"` on entry — nothing to suggest.
        expect(await ingestState(s)).toBeNull();
        expect(await scheduledJobs(s)).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    test("a central manual entry never wakes the debounce", async () => {
      process.env.OPENROUTER_API_KEY = "test-key";
      vi.useFakeTimers();
      try {
        const t = newT();
        const s = await setupChapter(t, { email: "seyi@publicworship.life" });

        await s.as.mutation(api.finances.createManualTransaction, {
          flow: "outflow",
          amountCents: 4200,
          postedAt: Date.now(),
          central: true,
        });

        expect(await ingestState(s)).toBeNull();
        expect(await scheduledJobs(s)).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("ingestSuggestionSweep (the debounced sweep itself)", () => {
    test("clears the mutex and schedules suggestCodingSystem (triggeredBy: ingest) for eligible txns only", async () => {
      process.env.OPENROUTER_API_KEY = "test-key";
      const t = newT();
      const s = await setupChapter(t);

      // Seed directly (bypassing the ingest mutations) so this test isolates
      // the sweep's OWN eligibility + scheduling logic.
      const eligibleId = await run(s.t, (ctx) =>
        ctx.db.insert("transactions", {
          chapterId: s.chapterId,
          source: "manual",
          flow: "outflow",
          amountCents: 1000,
          postedAt: Date.now(),
          status: "unreviewed",
          createdAt: Date.now(),
        }),
      );
      // Already suggested — must be skipped (never double-suggest).
      await run(s.t, (ctx) =>
        ctx.db.insert("transactions", {
          chapterId: s.chapterId,
          source: "manual",
          flow: "outflow",
          amountCents: 2000,
          postedAt: Date.now(),
          status: "unreviewed",
          createdAt: Date.now(),
          aiSuggestion: { suggestedAt: Date.now(), confidence: 0.5 },
        }),
      );
      // Simulate a mutex left pending by an ingest hook.
      await run(s.t, (ctx) =>
        ctx.db.insert("aiCodingIngestState", {
          pending: true,
          scheduledAt: Date.now(),
        }),
      );

      const result = await t.mutation(internal.aiCodingData.ingestSuggestionSweep, {});
      expect(result).toEqual({ scheduled: 1 });

      const state = await ingestState(s);
      expect(state?.pending).toBe(false);

      const jobs = await scheduledJobs(s);
      const suggestJobs = jobs.filter((j) => j.name.includes("suggestCodingSystem"));
      expect(suggestJobs).toHaveLength(1);
      expect(suggestJobs[0].args).toMatchObject({
        transactionId: eligibleId,
        triggeredBy: "ingest",
      });
    });

    test("degrades to scheduling nothing when the key is unset (still clears the mutex)", async () => {
      delete process.env.OPENROUTER_API_KEY;
      const t = newT();
      const s = await setupChapter(t);
      await run(s.t, (ctx) =>
        ctx.db.insert("transactions", {
          chapterId: s.chapterId,
          source: "manual",
          flow: "outflow",
          amountCents: 1000,
          postedAt: Date.now(),
          status: "unreviewed",
          createdAt: Date.now(),
        }),
      );
      await run(s.t, (ctx) =>
        ctx.db.insert("aiCodingIngestState", { pending: true, scheduledAt: Date.now() }),
      );

      const result = await t.mutation(internal.aiCodingData.ingestSuggestionSweep, {});
      expect(result).toEqual({ scheduled: 0 });
      expect((await ingestState(s))?.pending).toBe(false);
      expect(await scheduledJobs(s)).toHaveLength(0);
    });
  });

  describe("end-to-end: charge lands → debounced sweep fires → a real suggestion lands", () => {
    test("an Increase card charge gets a suggestion + an 'ingest' audit-trail row", async () => {
      process.env.OPENROUTER_API_KEY = "test-key";
      stubOpenRouterOk(
        JSON.stringify({ confidence: 0.7, rationale: "Matches usual vendor." }),
      );
      vi.useFakeTimers();
      try {
        const t = newT();
        const s = await setupChapter(t);
        await seedIncreaseAccount(s, "account_x");

        await t.mutation(internal.increase.applyIncreaseCardTransaction, {
          externalId: "txn_e2e",
          accountId: "account_x",
          flow: "outflow",
          amountCents: 6420,
          postedAt: Date.now(),
          merchantName: "Office Depot",
        });

        await t.finishAllScheduledFunctions(vi.runAllTimers);

        const txn = await run(s.t, (ctx) =>
          ctx.db
            .query("transactions")
            .withIndex("by_external_id", (q) => q.eq("externalId", "txn_e2e"))
            .unique(),
        );
        expect(txn?.aiSuggestion).toBeDefined();
        expect(txn?.aiSuggestion?.rationale).toBe("Matches usual vendor.");

        const usage = await run(s.t, (ctx) =>
          ctx.db.query("aiUsageEvents").collect(),
        );
        expect(usage).toHaveLength(1);
        expect(usage[0].triggeredBy).toBe("ingest");
        expect(usage[0].outcome).toBe("suggested");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
