/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * `finances.forPickerOptions` (the base grouped list) and `reconcileSuggest.
 * rankForPicker` (the ranked list) both call the ONE shared scan in
 * `lib/forPickerCandidates.ts` now (see that file's module doc — this was two
 * independently-maintained scans until this PR reconciled them). This suite
 * pins the thing the extraction is FOR: given identical seeded state, both
 * surfaces must return the exact same candidate set (same refs, same
 * budgetIds, same labels) — not merely "similar" or "usually agree."
 *
 * This does NOT re-test either surface's own behavior (approved-only
 * filtering, no-fabricated-dates, central scoping, ranking tiers, search) —
 * that's `financeLinksToBudgets.test.ts`'s `forPickerOptions` suite and
 * `reconcileSuggest.test.ts`, both left unmodified by this PR. This is purely
 * a cross-surface parity check over one deliberately mixed dataset.
 */

const SUPER = "seyi@publicworship.life";

async function seedEvent(
  s: ChapterSetup,
  opts: { name: string; eventDate: number; isTraining?: boolean },
): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Service",
      slug: `service-${Date.now()}-${Math.random()}`,
      version: 1,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: opts.name,
      eventDate: opts.eventDate,
      status: "planning",
      isTraining: opts.isTraining,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function seedProject(
  s: ChapterSetup,
  name: string,
  opts: { deadline?: number } = {},
): Promise<Id<"projects">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("projects", {
      chapterId: s.chapterId,
      name,
      status: "in_progress",
      deadline: opts.deadline,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

async function approveBudgetDirect(s: ChapterSetup, budgetId: Id<"budgets">): Promise<void> {
  await run(s.t, (ctx) => ctx.db.patch(budgetId, { approvalStatus: "approved" }));
}

/** A candidate identity every "For" picker row carries regardless of surface
 *  — the tuple this parity check compares. */
type CandidateKey = { refKind: "event" | "project" | "recurring"; budgetId: string; label: string };

function keySet(keys: CandidateKey[]): Set<string> {
  return new Set(keys.map((k) => `${k.refKind}:${k.budgetId}:${k.label}`));
}

describe("forPickerOptions and rankForPicker candidate-set parity", () => {
  test("identical seeded state -> identical candidate sets from both 'For' picker surfaces", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: SUPER });
    const NOW = Date.now();

    // ── Included candidates ──────────────────────────────────────────────
    const approvedEventId = await seedEvent(s, { name: "Sunday Gathering", eventDate: NOW });
    const approvedEventBudgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 40000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year: 2026,
      scopeRefId: approvedEventId,
    });
    await approveBudgetDirect(s, approvedEventBudgetId);

    const approvedProjectId = await seedProject(s, "Budgeted Project", {
      deadline: NOW + 5 * 24 * 60 * 60 * 1000,
    });
    const approvedProjectBudgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 20000,
      type: "one_time",
      refKind: "project",
      cadence: "per_instance",
      year: 2026,
      scopeRefId: approvedProjectId,
    });
    await approveBudgetDirect(s, approvedProjectBudgetId);

    // A project whose budget has MOVED to central (`transferProjectScope`) —
    // must still land in the "project" group on both surfaces, not
    // "recurring", and both must resolve the SAME (moved) budgetId.
    const movedProjectId = await seedProject(s, "Music Recording");
    const movedProjectBudgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 30000,
      type: "one_time",
      refKind: "project",
      cadence: "per_instance",
      year: 2026,
      scopeRefId: movedProjectId,
    });
    await approveBudgetDirect(s, movedProjectBudgetId);
    await s.as.mutation(api.finances.transferProjectScope, {
      projectId: movedProjectId,
      target: "central",
    });
    // `moveBudgetScope` resets provenance to "submitted" on a scope move —
    // re-approve so the moved budget is attributable on both surfaces.
    await approveBudgetDirect(s, movedProjectBudgetId);

    const chapterRecurringBudgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 100000,
      type: "recurring",
      cadence: "monthly",
      year: 2026,
      month: 1,
      label: "Ops",
    });
    await approveBudgetDirect(s, chapterRecurringBudgetId);

    const centralRecurringBudgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 500000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      central: true,
      label: "City Launch Fund",
    });
    await approveBudgetDirect(s, centralRecurringBudgetId);

    // ── Excluded candidates (must be absent from BOTH surfaces) ──────────
    await seedEvent(s, { name: "Bare Event", eventDate: NOW }); // no budget
    const unapprovedEventId = await seedEvent(s, { name: "Unapproved Event", eventDate: NOW });
    await s.as.mutation(api.finances.createBudget, {
      amountCents: 15000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year: 2026,
      scopeRefId: unapprovedEventId,
    }); // left in "draft"
    await seedProject(s, "Bare Project"); // no budget
    await s.as.mutation(api.finances.createBudget, {
      amountCents: 60000,
      type: "recurring",
      cadence: "monthly",
      year: 2026,
      month: 1,
      label: "Draft bucket",
    }); // left in "draft"
    const trainingEventId = await seedEvent(s, {
      name: "Training Drill",
      eventDate: NOW,
      isTraining: true,
    });
    const trainingBudgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 5000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year: 2026,
      scopeRefId: trainingEventId,
    });
    await approveBudgetDirect(s, trainingBudgetId); // approved AND budgeted, but isTraining -> still excluded

    // ── Surface 1: the base grouped list ─────────────────────────────────
    const options = await s.as.query(api.finances.forPickerOptions, {});
    const fromOptions: CandidateKey[] = [
      ...options.events.map((e) => ({ refKind: "event" as const, budgetId: e.budgetId, label: e.label })),
      ...options.projects.map((p) => ({
        refKind: "project" as const,
        budgetId: p.budgetId,
        label: p.label,
      })),
      ...options.recurring.map((r) => ({
        refKind: "recurring" as const,
        budgetId: r.budgetId,
        label: r.label,
      })),
    ];

    // ── Surface 2: the ranked list — seed a plain chapter-owned txn with no
    // tier-1/2/3 evidence so EVERY attributable candidate shows up (all tier
    // 4), giving an apples-to-apples set against the base list. ───────────
    const txnId = await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 1234,
        postedAt: NOW,
        status: "unreviewed",
        createdAt: Date.now(),
      }),
    );
    const ranked = await s.as.query(api.reconcileSuggest.rankForPicker, { transactionId: txnId });
    const fromRanked: CandidateKey[] = ranked.rows.map((r) => ({
      refKind: r.refKind,
      budgetId: r.budgetId,
      label: r.label,
    }));

    // ── Parity ────────────────────────────────────────────────────────────
    expect(fromOptions.length).toBeGreaterThan(0);
    expect(fromRanked.length).toBe(fromOptions.length);
    expect(keySet(fromRanked)).toEqual(keySet(fromOptions));

    // The 5 included refs, explicitly — and the exclusions, explicitly.
    const rankedBudgetIds = new Set(fromRanked.map((r) => r.budgetId));
    for (const included of [
      approvedEventBudgetId,
      approvedProjectBudgetId,
      movedProjectBudgetId,
      chapterRecurringBudgetId,
      centralRecurringBudgetId,
    ]) {
      expect(rankedBudgetIds.has(included)).toBe(true);
    }
    expect(rankedBudgetIds.has(trainingBudgetId)).toBe(false);
    expect(fromOptions.some((c) => c.budgetId === trainingBudgetId)).toBe(false);
  });
});
