import { afterEach, describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { createReceipt } from "../lib/receiptLinks";

/**
 * The rate-limit-safe bulk "re-extract all failed" sweep
 * (`receipts.ts#retryFailedExtractions` / `runFailedRetrySweep`) — the fix
 * for the owner's mass-upload incident: ~80 receipts scheduled at
 * `runAfter(0)` all at once tripped Ollama's rate limit (HTTP 429), leaving
 * most of them stuck with `ocrError` set. This sweep re-extracts failed
 * receipts SERIALLY, one at a time, throttled apart, backing off
 * exponentially (respecting a `Retry-After` header) on a rate-limited
 * attempt instead of recording it as a permanent failure.
 *
 * No test ever calls OpenRouter for real — a 429 is simulated via a stubbed
 * global `fetch` (mirrors `aiCoding.test.ts`); the "permanent failure" tests
 * instead lean on the deterministic `no_key` degrade path (no
 * `OPENROUTER_API_KEY` set), which needs no fetch mock at all.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

// ── Seed helpers (mirrors receipts.test.ts) ───────────────────────────────────
async function seedPerson(s: ChapterSetup): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Book Keeper",
      userId: s.userId,
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

async function seedBookkeeper(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedPerson(s);
  await grantRole(s, personId, "bookkeeper");
  return personId;
}

async function storeBlobWithContent(s: ChapterSetup, content: string): Promise<Id<"_storage">> {
  return await run(s.t, (ctx) =>
    (ctx.storage as unknown as {
      store: (b: Blob) => Promise<Id<"_storage">>;
    }).store(new Blob([content], { type: "image/png" })),
  );
}

/** Seed an ALREADY-FAILED upload receipt (as if a prior extraction attempt
 *  set `ocrError`) — the sweep's raw material. */
async function newFailedReceipt(
  s: ChapterSetup,
  ocrError = "AI request failed — OpenRouter returned HTTP 429 (rate limited) — try again shortly.",
): Promise<Id<"receipts">> {
  const storageId = await storeBlobWithContent(s, `receipt-${Math.random()}`);
  return await run(s.t, (ctx) =>
    createReceipt(ctx, {
      chapterId: s.chapterId,
      storageId,
      source: "upload",
      ocrError,
    }),
  );
}

async function getReceipt(s: ChapterSetup, receiptId: Id<"receipts">) {
  return await run(s.t, (ctx) => ctx.db.get(receiptId));
}

/** Every pending `_scheduled_functions` row whose name matches `fragment`
 *  (name + first arg + absolute `scheduledTime`), for asserting WHAT got
 *  scheduled (and WHEN) without firing it — mirrors `receipts.test.ts`'s own
 *  `scheduledJobs` helper, plus `scheduledTime` for delay assertions. */
async function scheduledJobs(
  s: ChapterSetup,
  fragment: string,
): Promise<{ args: any; scheduledTime: number }[]> {
  const rows = await run(s.t, (ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return rows
    .filter((r) => r.name.includes(fragment))
    .map((r) => ({ args: r.args[0] as any, scheduledTime: r.scheduledTime }));
}

/** Stub OpenRouter's chat-completions endpoint to always return a 429 with
 *  the given `Retry-After` header (seconds). Mirrors `aiCoding.test.ts`'s
 *  `stubOpenRouterOk`, and `aiEngine.test.ts`'s header-aware `mockFetch`. */
function stubOpenRouter429(retryAfterSeconds: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => "rate limited",
      json: async () => ({}),
      headers: { get: (name: string) => (name === "Retry-After" ? String(retryAfterSeconds) : null) },
    })),
  );
}

const THROTTLE_MS = 4000;
const SWEEP_BACKOFF_BASE_MS = 30_000;

// ── Role gate ────────────────────────────────────────────────────────────────
describe("role gates", () => {
  test("retryFailedExtractions and failedExtractionStatus need bookkeeper+", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // No financeRoles grant at all.
    await expect(s.as.mutation(api.receipts.retryFailedExtractions, {})).rejects.toThrow(
      ConvexError,
    );
    await expect(s.as.query(api.receipts.failedExtractionStatus, {})).rejects.toThrow(
      ConvexError,
    );
  });

  test("a bookkeeper can call both", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    await expect(s.as.query(api.receipts.failedExtractionStatus, {})).resolves.toEqual({
      failedCount: 0,
      sweepInProgress: false,
    });
    await expect(s.as.mutation(api.receipts.retryFailedExtractions, {})).resolves.toEqual({
      started: false,
      failedCount: 0,
    });
  });
});

// ── failedExtractionStatus ────────────────────────────────────────────────────
describe("failedExtractionStatus", () => {
  test("counts only receipts with ocrError set, excluding duplicates", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    await newFailedReceipt(s, "no_total");
    await newFailedReceipt(s, "no_total");
    const dupeId = await newFailedReceipt(s, "no_total");
    // A duplicate — never counted (nothing worth spending a call on).
    await run(s.t, (ctx) =>
      ctx.db.patch(dupeId, { duplicateOfReceiptId: dupeId, updatedAt: Date.now() }),
    );
    // A healthy receipt (no ocrError) — never counted.
    const storageId = await storeBlobWithContent(s, "ok");
    await run(s.t, (ctx) =>
      createReceipt(ctx, { chapterId: s.chapterId, storageId, source: "upload" }),
    );

    const status = await s.as.query(api.receipts.failedExtractionStatus, {});
    expect(status.failedCount).toBe(2);
    expect(status.sweepInProgress).toBe(false);
  });
});

// ── retryFailedExtractions — kickoff + idempotency ───────────────────────────
describe("retryFailedExtractions", () => {
  test("kicks off exactly one sweep chain and is idempotent against a double-tap", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    await newFailedReceipt(s);
    await newFailedReceipt(s);

    const first = await s.as.mutation(api.receipts.retryFailedExtractions, {});
    expect(first).toEqual({ started: true, failedCount: 2 });

    // A second call while the first chain is still marked in-progress must
    // NOT schedule a second overlapping chain — that would double the
    // request rate right back into the rate limit this sweep exists to
    // avoid.
    const second = await s.as.mutation(api.receipts.retryFailedExtractions, {});
    expect(second.started).toBe(false);

    const jobs = await scheduledJobs(s, "runFailedRetrySweep");
    expect(jobs.length).toBe(1);

    const status = await s.as.query(api.receipts.failedExtractionStatus, {});
    expect(status.sweepInProgress).toBe(true);
  });

  test("threads the model override through to the sweep", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    await newFailedReceipt(s);

    await s.as.mutation(api.receipts.retryFailedExtractions, { model: "  my/model  " });
    const jobs = await scheduledJobs(s, "runFailedRetrySweep");
    expect(jobs[0]?.args.model).toBe("my/model");
  });
});

// ── runFailedRetrySweep — serial + throttled ─────────────────────────────────
describe("runFailedRetrySweep — serial, throttled, one-at-a-time", () => {
  test("processes exactly ONE receipt per invocation and reschedules at THROTTLE_MS (not 0)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const a = await newFailedReceipt(s, "stale error A");
    const b = await newFailedReceipt(s, "stale error B");
    const c = await newFailedReceipt(s, "stale error C");

    // No OPENROUTER_API_KEY configured — every extraction attempt degrades
    // deterministically to a NON-retryable `no_key` failure, no fetch mock
    // needed. This exercises the "permanent failure — move on" path.
    const before = Date.now();
    await t.action(internal.receipts.runFailedRetrySweep, { chapterId: s.chapterId });

    // Only ONE new continuation was scheduled — never all three at once.
    const jobs = await scheduledJobs(s, "runFailedRetrySweep");
    expect(jobs.length).toBe(1);
    const delay = jobs[0].scheduledTime - before;
    expect(delay).toBeGreaterThanOrEqual(THROTTLE_MS - 500);
    expect(delay).toBeLessThan(THROTTLE_MS + 3000);
    expect(jobs[0].args.attempt).toBe(0);
    expect(jobs[0].args.processed).toBe(1);

    // Exactly one of the three receipts got touched this invocation; the
    // other two are untouched.
    const [ra, rb, rc] = await Promise.all([getReceipt(s, a), getReceipt(s, b), getReceipt(s, c)]);
    const touched = [ra, rb, rc].filter(
      (r) => r?.ocrError !== "stale error A" && r?.ocrError !== "stale error B" && r?.ocrError !== "stale error C",
    );
    expect(touched.length).toBe(1);
    expect(touched[0]?.ocrError).toContain("No AI engine key configured");
  });

  test("stops (clears the in-progress marker) once no failed receipts remain", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    // Simulate a marker left by `retryFailedExtractions` for a chain that's
    // about to discover there's nothing left to do.
    await run(s.t, (ctx) =>
      ctx.db.insert("receiptSweepState", {
        chapterId: s.chapterId,
        inProgress: true,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    await t.action(internal.receipts.runFailedRetrySweep, { chapterId: s.chapterId });

    const jobs = await scheduledJobs(s, "runFailedRetrySweep");
    expect(jobs.length).toBe(0);
    const state = await run(s.t, (ctx) =>
      ctx.db
        .query("receiptSweepState")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .unique(),
    );
    expect(state?.inProgress).toBe(false);
  });
});

// ── runFailedRetrySweep — rate-limit backoff ─────────────────────────────────
describe("runFailedRetrySweep — 429 backs off instead of finalizing", () => {
  test("a 429 does NOT overwrite ocrError, backs off longer than THROTTLE_MS, and respects Retry-After", async () => {
    const savedKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-key";
    stubOpenRouter429(50); // Retry-After: 50s — longer than the 30s exponential floor.

    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    const original = "AI request failed — OpenRouter returned HTTP 429 (rate limited) — try again shortly.";
    const receiptId = await newFailedReceipt(s, original);

    const before = Date.now();
    await t.action(internal.receipts.runFailedRetrySweep, { chapterId: s.chapterId });

    // The receipt's ocrError is UNTOUCHED — a transient 429 is never
    // recorded as if it were a settled/permanent verdict.
    const row = await getReceipt(s, receiptId);
    expect(row?.ocrError).toBe(original);

    // Backs off — the continuation is scheduled well past the normal
    // THROTTLE_MS pace, honoring the (longer) Retry-After window.
    const jobs = await scheduledJobs(s, "runFailedRetrySweep");
    expect(jobs.length).toBe(1);
    const delay = jobs[0].scheduledTime - before;
    expect(delay).toBeGreaterThanOrEqual(50_000 - 1000);
    expect(jobs[0].args.attempt).toBe(1);
    // The cursor is UNCHANGED — the same receipt is retried next, not
    // skipped.
    expect(jobs[0].args.cursor).toBeUndefined();
    expect(jobs[0].args.processed).toBe(0);

    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedKey;
  });

  test("a Retry-After shorter than the exponential floor never shortens the backoff", async () => {
    const savedKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-key";
    stubOpenRouter429(2); // Much shorter than the 30s exponential floor.

    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    await newFailedReceipt(s);

    const before = Date.now();
    await t.action(internal.receipts.runFailedRetrySweep, { chapterId: s.chapterId });

    const jobs = await scheduledJobs(s, "runFailedRetrySweep");
    const delay = jobs[0].scheduledTime - before;
    // Never shorter than the exponential floor (SWEEP_BACKOFF_BASE_MS for
    // the first backoff), regardless of a short Retry-After.
    expect(delay).toBeGreaterThanOrEqual(SWEEP_BACKOFF_BASE_MS - 1000);

    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedKey;
  });

  test("stops after SWEEP_MAX_CONSECUTIVE_BACKOFFS consecutive 429s and clears the marker", async () => {
    const savedKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-key";
    stubOpenRouter429(1);

    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);
    await newFailedReceipt(s);
    await run(s.t, (ctx) =>
      ctx.db.insert("receiptSweepState", {
        chapterId: s.chapterId,
        inProgress: true,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    // Simulate the chain already having backed off 5 times in a row.
    await t.action(internal.receipts.runFailedRetrySweep, {
      chapterId: s.chapterId,
      attempt: 5,
      processed: 0,
    });

    // The 6th consecutive 429 trips the cap — the chain stops instead of
    // scheduling yet another backoff.
    const jobs = await scheduledJobs(s, "runFailedRetrySweep");
    expect(jobs.length).toBe(0);
    const state = await run(s.t, (ctx) =>
      ctx.db
        .query("receiptSweepState")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .unique(),
    );
    expect(state?.inProgress).toBe(false);

    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedKey;
  });
});

// ── submitUploadedReceipts — staggered scheduling ────────────────────────────
describe("submitUploadedReceipts staggers its scheduled extractions", () => {
  test("schedules the i-th receipt's extraction at i * THROTTLE_MS, never all at runAfter(0)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);

    const storageIds = await Promise.all([
      storeBlobWithContent(s, "file-1"),
      storeBlobWithContent(s, "file-2"),
      storeBlobWithContent(s, "file-3"),
    ]);

    const before = Date.now();
    await s.as.mutation(api.receipts.submitUploadedReceipts, { storageIds });

    const jobs = await scheduledJobs(s, "processUploadedReceipt");
    expect(jobs.length).toBe(3);
    const delays = jobs.map((j) => j.scheduledTime - before).sort((a, b) => a - b);
    // The first fires ~immediately; each subsequent one THROTTLE_MS later.
    expect(delays[0]).toBeLessThan(1000);
    expect(delays[1]).toBeGreaterThanOrEqual(THROTTLE_MS - 500);
    expect(delays[1]).toBeLessThan(THROTTLE_MS + 3000);
    expect(delays[2]).toBeGreaterThanOrEqual(2 * THROTTLE_MS - 500);
    expect(delays[2]).toBeLessThan(2 * THROTTLE_MS + 3000);
  });

  test("a duplicate in the batch is never scheduled, and doesn't widen the gap between real extractions", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBookkeeper(s);

    // Upload the SAME bytes twice (the 2nd is an exact duplicate — never
    // scheduled) plus one fresh file.
    const dupeBytes = "same-bytes";
    const storageId1 = await storeBlobWithContent(s, dupeBytes);
    // Submit the first file alone so it's the "earlier" receipt the second
    // submission's dedupe check can find.
    await s.as.mutation(api.receipts.submitUploadedReceipts, { storageIds: [storageId1] });

    const storageId2 = await storeBlobWithContent(s, dupeBytes); // exact same content
    const storageId3 = await storeBlobWithContent(s, "fresh-bytes");
    const beforeSecondBatch = Date.now();
    const results = await s.as.mutation(api.receipts.submitUploadedReceipts, {
      storageIds: [storageId2, storageId3],
    });
    expect(results.find((r) => r.storageId === storageId2)?.duplicate).toBe(true);
    const freshOutcome = results.find((r) => r.storageId === storageId3);
    expect(freshOutcome?.duplicate).toBe(false);

    const jobs = await scheduledJobs(s, "processUploadedReceipt");
    // 1 from the first submission + 1 from the fresh file in the second
    // (the duplicate never gets one) — identified by receiptId, not timing,
    // since both submissions can land in the same millisecond in a fast
    // test run.
    expect(jobs.length).toBe(2);
    const freshJob = jobs.find((j) => j.args.receiptId === freshOutcome?.receiptId);
    expect(freshJob).toBeDefined();
    // The duplicate being skipped doesn't push the fresh file's delay out —
    // it's scheduled essentially immediately WITHIN ITS OWN batch (index 0
    // of the real, non-duplicate schedule count), not `THROTTLE_MS` later as
    // it would be if the skipped duplicate still consumed a stagger slot.
    expect(freshJob!.scheduledTime - beforeSecondBatch).toBeLessThan(THROTTLE_MS / 2);
  });
});
