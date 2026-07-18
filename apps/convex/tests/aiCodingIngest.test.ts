/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { queueSuggestionOnIngest } from "../aiCodingData";

/**
 * ON-INGEST AI-coding suggestion tests — the owner's ask that a charge gets a
 * coding suggestion AS IT ARRIVES, not just on the old hourly-only cron.
 *
 * TWO-HOP ARCHITECTURE (review findings 1 + 2, PR #265 — "nothing about
 * suggestions may ever affect a money write"):
 *  - hop 1 (`queueSuggestionOnIngest`, called INLINE by the money mutation):
 *    does ONLY a try/catch-wrapped `ctx.scheduler.runAfter` targeting
 *    `aiCodingData.scheduleSuggestionOnIngest` — append-only, can't contend
 *    with the money write, and a failure is swallowed rather than
 *    propagated. ALWAYS scheduled, unconditionally, for every transaction
 *    insert — no key check, no eligibility check happens at this layer.
 *  - hop 2 (`scheduleSuggestionOnIngest`, an internalMutation, fires in its
 *    OWN separate transaction once scheduled): does the actual `OPENROUTER_API_KEY`
 *    check, re-reads the transaction, checks eligibility, and — only if
 *    eligible — debounces into `ingestSuggestionSweep` (hop 3) via the
 *    `aiCodingIngestState` mutex. NEITHER a throw NOR OCC contention on that
 *    shared mutex row here can ever roll back or retry the money mutation
 *    that triggered hop 1, since they're fully separate transactions.
 *
 * Most tests below directly invoke hop 2 (`t.mutation(internal.aiCodingData.
 * scheduleSuggestionOnIngest, {transactionId})`) to simulate it firing,
 * rather than draining real/fake timers through the chain — this is
 * deterministic and exercises the exact same code a real scheduled firing
 * would run.
 *
 * Coverage:
 *  - hop 1 is scheduled for EVERY insert (even central-owned, even with no
 *    key) — the money mutation itself has zero conditionals;
 *  - hop 2 debounces into exactly one `ingestSuggestionSweep` even when
 *    several independently-scheduled hop-1 firings race it (sequential
 *    dedup — see that test's own comment for what this does and doesn't
 *    prove);
 *  - hop 2 no-ops for a central-owned charge, an already-categorized manual
 *    entry, or when the key is unset — without ever touching the mutex;
 *  - a central manual entry never even schedules hop 1 (the money mutation's
 *    central branch doesn't call the hook at all);
 *  - `ingestSuggestionSweep` (hop 3) schedules `suggestCodingSystem`
 *    (`triggeredBy:"ingest"`) only for still-eligible transactions, same cap
 *    as the hourly cron — never double-suggesting;
 *  - structural safety: a scheduling failure in hop 1 is swallowed, and the
 *    money row is durably committed before hop 1 has even run;
 *  - stale-mutex self-heal: a wedged `pending:true` row (hop 3 threw after
 *    staging its clear) is cleared by the hourly cron unconditionally, and
 *    by the very next hop-2 firing that notices it's stale;
 *  - end to end: a charge lands, all three hops fire, and the transaction
 *    comes out the other side with a real `aiSuggestion` + an `"ingest"`-
 *    labelled `aiUsageEvents` row.
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

/** A bare, directly-insertable unreviewed chapter transaction (bypasses both
 *  ingest mutations — used by tests that isolate hop 2/3's own logic). */
async function seedBareTxn(
  s: ChapterSetup,
  extra: Partial<{ status: "unreviewed" | "categorized"; amountCents: number }> = {},
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: extra.amountCents ?? 1000,
      postedAt: Date.now(),
      status: extra.status ?? "unreviewed",
      createdAt: Date.now(),
    }),
  );
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

function jobsNamed(jobs: { name: string; args: unknown }[], fragment: string) {
  return jobs.filter((j) => j.name.includes(fragment));
}

async function ingestState(s: ChapterSetup) {
  return await run(s.t, (ctx) => ctx.db.query("aiCodingIngestState").first());
}

/** Directly invoke hop 2 (simulates the scheduled `scheduleSuggestionOnIngest`
 *  firing) — deterministic, no timer wrangling needed. */
async function fireHop2(t: ReturnType<typeof newT>, transactionId: Id<"transactions">) {
  await t.mutation(internal.aiCodingData.scheduleSuggestionOnIngest, { transactionId });
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

// ── env save/restore (OPENROUTER_API_KEY toggles hop 2's degrade) ──────────

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
    test("an eligible chapter charge schedules hop 1, which (once fired) debounces into ONE ingest sweep", async () => {
      process.env.OPENROUTER_API_KEY = "test-key";
      vi.useFakeTimers();
      try {
        const t = newT();
        const s = await setupChapter(t);
        await seedIncreaseAccount(s, "account_x");

        const result = await t.mutation(internal.increase.applyIncreaseCardTransaction, {
          externalId: "txn_1",
          accountId: "account_x",
          flow: "outflow",
          amountCents: 4200,
          postedAt: Date.now(),
          merchantName: "Office Depot",
        });
        expect(result).toEqual({ inserted: true, skipped: false });

        // Fake timers: hop 1 hasn't fired yet — exactly one pending job.
        const hop1Jobs = await scheduledJobs(s);
        expect(jobsNamed(hop1Jobs, "scheduleSuggestionOnIngest")).toHaveLength(1);
        expect(await ingestState(s)).toBeNull(); // mutex untouched until hop 1 runs

        const txn = await run(s.t, (ctx) =>
          ctx.db
            .query("transactions")
            .withIndex("by_external_id", (q) => q.eq("externalId", "txn_1"))
            .unique(),
        );
        await fireHop2(t, txn!._id);

        expect((await ingestState(s))?.pending).toBe(true);
        const afterHop2 = await scheduledJobs(s);
        expect(jobsNamed(afterHop2, "ingestSuggestionSweep")).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    test("sequential dedup: several eligible charges each schedule their own hop 1, but only the first to fire schedules the sweep", async () => {
      // NOTE (review finding 6a, PR #265): this awaits each hop-1 firing
      // ONE AT A TIME — convex-test, like real Convex, serializes mutations,
      // so this proves SEQUENTIAL dedup (the mutex correctly recognizes
      // "already pending" across N independently-scheduled hop-1 firings).
      // It does NOT exercise genuinely concurrent hop-1 firings racing the
      // same OCC read-then-write — that's inherently hard to force
      // deterministically in this harness. Convex's documented OCC semantics
      // (a losing writer retries against the winner's committed state) are
      // what the shared-row read-then-write pattern relies on for the
      // concurrent case; this test covers the always-true sequential one.
      process.env.OPENROUTER_API_KEY = "test-key";
      vi.useFakeTimers();
      try {
        const t = newT();
        const s = await setupChapter(t);
        await seedIncreaseAccount(s, "account_x");

        const txnIds: Id<"transactions">[] = [];
        for (let i = 0; i < 5; i++) {
          await t.mutation(internal.increase.applyIncreaseCardTransaction, {
            externalId: `txn_burst_${i}`,
            accountId: "account_x",
            flow: "outflow",
            amountCents: 1000 + i,
            postedAt: Date.now(),
            merchantName: "Burst Merchant",
          });
          const txn = await run(s.t, (ctx) =>
            ctx.db
              .query("transactions")
              .withIndex("by_external_id", (q) => q.eq("externalId", `txn_burst_${i}`))
              .unique(),
          );
          txnIds.push(txn!._id);
        }
        // Each insert scheduled its OWN hop-1 job — that layer has no dedup.
        expect(jobsNamed(await scheduledJobs(s), "scheduleSuggestionOnIngest")).toHaveLength(5);

        // Fire all 5 hop-1 jobs, one at a time.
        for (const id of txnIds) await fireHop2(t, id);

        // Still exactly one pending sweep — every firing after the first saw
        // `pending:true` and no-opped rather than scheduling its own.
        const jobs = await scheduledJobs(s);
        expect(jobsNamed(jobs, "ingestSuggestionSweep")).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    test("a central-owned charge's hop 1 fires but is a no-op (central isn't auto-coded)", async () => {
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

        // Hop 1 IS scheduled — the money mutation schedules unconditionally.
        expect(jobsNamed(await scheduledJobs(s), "scheduleSuggestionOnIngest")).toHaveLength(1);

        const txn = await run(s.t, (ctx) =>
          ctx.db
            .query("transactions")
            .withIndex("by_external_id", (q) => q.eq("externalId", "txn_central"))
            .unique(),
        );
        await fireHop2(t, txn!._id);

        // But firing it is a no-op: central is never eligible.
        expect(await ingestState(s)).toBeNull();
        expect(jobsNamed(await scheduledJobs(s), "ingestSuggestionSweep")).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    test("hop 1 is scheduled even with no key set, but firing it is a no-op (the degrade lives in hop 2, not the money mutation)", async () => {
      delete process.env.OPENROUTER_API_KEY;
      vi.useFakeTimers();
      try {
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

        expect(jobsNamed(await scheduledJobs(s), "scheduleSuggestionOnIngest")).toHaveLength(1);

        const txn = await run(s.t, (ctx) =>
          ctx.db
            .query("transactions")
            .withIndex("by_external_id", (q) => q.eq("externalId", "txn_nokey"))
            .unique(),
        );
        await fireHop2(t, txn!._id);

        expect(await ingestState(s)).toBeNull();
        expect(jobsNamed(await scheduledJobs(s), "ingestSuggestionSweep")).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("manual-add path (createManualTransaction)", () => {
    test("an unreviewed manual entry's hop 1 debounces into the ingest sweep once fired", async () => {
      process.env.OPENROUTER_API_KEY = "test-key";
      vi.useFakeTimers();
      try {
        const t = newT();
        const s = await setupChapter(t);
        await asBookkeeper(s);

        const txnId = await s.as.mutation(api.finances.createManualTransaction, {
          flow: "outflow",
          amountCents: 2500,
          postedAt: Date.now(),
          merchantName: "Hardware Store",
        });

        expect(jobsNamed(await scheduledJobs(s), "scheduleSuggestionOnIngest")).toHaveLength(1);
        await fireHop2(t, txnId);

        expect((await ingestState(s))?.pending).toBe(true);
        expect(jobsNamed(await scheduledJobs(s), "ingestSuggestionSweep")).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    test("a manual entry submitted already-categorized: hop 1 fires but is a no-op", async () => {
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

        const txnId = await s.as.mutation(api.finances.createManualTransaction, {
          flow: "outflow",
          amountCents: 2500,
          postedAt: Date.now(),
          categoryId,
        });

        expect(jobsNamed(await scheduledJobs(s), "scheduleSuggestionOnIngest")).toHaveLength(1);
        await fireHop2(t, txnId);

        // Already `status:"categorized"` on entry — nothing to suggest.
        expect(await ingestState(s)).toBeNull();
        expect(jobsNamed(await scheduledJobs(s), "ingestSuggestionSweep")).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    test("a central manual entry never schedules hop 1 at all", async () => {
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

        // The money mutation's central branch never calls the hook at all —
        // not even hop 1 gets scheduled (unlike the central Increase-charge
        // case above, where the SAME code path handles both).
        expect(await ingestState(s)).toBeNull();
        expect(await scheduledJobs(s)).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("ingestSuggestionSweep (hop 3, the debounced sweep itself)", () => {
    test("clears the mutex and schedules suggestCodingSystem (triggeredBy: ingest) for eligible txns only", async () => {
      process.env.OPENROUTER_API_KEY = "test-key";
      const t = newT();
      const s = await setupChapter(t);

      // Seed directly (bypassing both ingest hops) so this test isolates the
      // sweep's OWN eligibility + scheduling logic.
      const eligibleId = await seedBareTxn(s, { amountCents: 1000 });
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
      // Simulate a mutex left pending by an ingest hop.
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
      const suggestJobs = jobsNamed(jobs, "suggestCodingSystem");
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
      await seedBareTxn(s);
      await run(s.t, (ctx) =>
        ctx.db.insert("aiCodingIngestState", { pending: true, scheduledAt: Date.now() }),
      );

      const result = await t.mutation(internal.aiCodingData.ingestSuggestionSweep, {});
      expect(result).toEqual({ scheduled: 0 });
      expect((await ingestState(s))?.pending).toBe(false);
      expect(await scheduledJobs(s)).toHaveLength(0);
    });
  });

  describe("structural safety: the ingest hook can never fail a money write (review findings 1 + 2, PR #265)", () => {
    test("queueSuggestionOnIngest swallows a scheduler failure rather than throwing (belt-and-braces try/catch)", async () => {
      const t = newT();
      const s = await setupChapter(t);
      const txnId = await seedBareTxn(s);

      await run(s.t, async (ctx) => {
        // Stub `ctx.scheduler.runAfter` to simulate the append-only schedule
        // call itself failing — the ONE thing hop 1 does.
        const brokenCtx: MutationCtx = {
          ...ctx,
          scheduler: {
            ...ctx.scheduler,
            runAfter: () => {
              throw new Error("scheduler unavailable (simulated)");
            },
          },
        } as MutationCtx;

        await expect(
          queueSuggestionOnIngest(brokenCtx, txnId),
        ).resolves.toBeUndefined();
      });
    });

    test("the money insert is already durably committed before hop 1 has even run", async () => {
      process.env.OPENROUTER_API_KEY = "test-key";
      vi.useFakeTimers();
      try {
        const t = newT();
        const s = await setupChapter(t);
        await seedIncreaseAccount(s, "account_x");

        const result = await t.mutation(internal.increase.applyIncreaseCardTransaction, {
          externalId: "txn_committed_first",
          accountId: "account_x",
          flow: "outflow",
          amountCents: 4200,
          postedAt: Date.now(),
        });
        expect(result).toEqual({ inserted: true, skipped: false });

        // Fake timers: hop 1 has NOT run yet. The money row is already
        // durably present regardless — its success can never have depended
        // on anything hop 1/2/3 do, since they haven't run at all.
        const txn = await run(s.t, (ctx) =>
          ctx.db
            .query("transactions")
            .withIndex("by_external_id", (q) => q.eq("externalId", "txn_committed_first"))
            .unique(),
        );
        expect(txn).not.toBeNull();
        expect(jobsNamed(await scheduledJobs(s), "scheduleSuggestionOnIngest")).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("stale-mutex self-heal (review finding 3, PR #265)", () => {
    const STALE_MUTEX_MS = 15 * 60 * 1000;

    test("the hourly cron clears a wedged pending mutex row even with zero new arrivals", async () => {
      process.env.OPENROUTER_API_KEY = "test-key";
      const t = newT();
      const s = await setupChapter(t);
      const staleAt = Date.now() - (STALE_MUTEX_MS + 60_000);
      await run(s.t, (ctx) =>
        ctx.db.insert("aiCodingIngestState", { pending: true, scheduledAt: staleAt }),
      );

      await t.mutation(internal.aiCodingData.sweepUnsuggestedTransactions, {});

      expect((await ingestState(s))?.pending).toBe(false);
    });

    test("the hourly cron leaves a genuinely fresh pending row alone", async () => {
      process.env.OPENROUTER_API_KEY = "test-key";
      const t = newT();
      const s = await setupChapter(t);
      await run(s.t, (ctx) =>
        ctx.db.insert("aiCodingIngestState", { pending: true, scheduledAt: Date.now() }),
      );

      await t.mutation(internal.aiCodingData.sweepUnsuggestedTransactions, {});

      // Still pending — a real in-flight sweep must not be disturbed.
      expect((await ingestState(s))?.pending).toBe(true);
    });

    test("a new arrival self-heals a wedged mutex immediately, without waiting for the cron", async () => {
      process.env.OPENROUTER_API_KEY = "test-key";
      vi.useFakeTimers();
      try {
        const t = newT();
        const s = await setupChapter(t);
        const staleAt = Date.now() - (STALE_MUTEX_MS + 60_000);
        await run(s.t, (ctx) =>
          ctx.db.insert("aiCodingIngestState", { pending: true, scheduledAt: staleAt }),
        );
        const txnId = await seedBareTxn(s);

        // Directly fire hop 2, simulating a new arrival's hop-1 job running.
        await fireHop2(t, txnId);

        const state = await ingestState(s);
        expect(state?.pending).toBe(true);
        expect(state?.scheduledAt).toBeGreaterThan(staleAt);
        expect(jobsNamed(await scheduledJobs(s), "ingestSuggestionSweep")).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("end-to-end: charge lands → all three hops fire → a real suggestion lands", () => {
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
