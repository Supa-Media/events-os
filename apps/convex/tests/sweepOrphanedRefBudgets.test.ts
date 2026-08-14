import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * The pre-cascade orphan sweep.
 *
 * Unlike the cascade it accompanies, this one IS fully exercisable — it finds
 * its targets by dead ref rather than by hard-coded id, so a fixture can build
 * the exact shape production was in. The case that matters most is the one it
 * REFUSES: an orphaned budget with money coded to it stays put, because a
 * sweep nobody is watching must not be able to drop real spend into
 * Unattributed.
 *
 * Delete this file with the module.
 */

async function seedProject(s: ChapterSetup, name: string): Promise<Id<"projects">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("projects", {
      chapterId: s.chapterId,
      name,
      status: "in_progress",
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

/** A project budget whose project has been deleted out from under it. */
async function seedOrphanedProjectBudget(
  s: ChapterSetup,
  opts: { name: string; amountCents?: number },
): Promise<Id<"budgets">> {
  const projectId = await seedProject(s, opts.name);
  return await run(s.t, async (ctx) => {
    const budgetId = await ctx.db.insert("budgets", {
      chapterId: s.chapterId,
      amountCents: opts.amountCents ?? 0,
      type: "one_time",
      cadence: "per_instance",
      refKind: "project",
      scopeRefId: projectId,
      label: opts.name,
      year: 2026,
      approvalStatus: "approved",
      createdAt: Date.now(),
    });
    await ctx.db.delete(projectId);
    return budgetId;
  });
}

describe("sweepOrphanedRefBudgets", () => {
  test("deletes an empty budget whose ref is gone — and only on execute", async () => {
    const s = await setupChapter(newT());
    const budgetId = await seedOrphanedProjectBudget(s, {
      name: "Create sponsorship package for LTN",
      amountCents: 50_000,
    });

    const dry = await s.t.mutation(internal.sweepOrphanedRefBudgets.sweepOrphanedRefBudgets, {});
    expect(dry.dryRun).toBe(true);
    expect(dry.deleted.map((r) => r.budgetId)).toEqual([budgetId]);
    // A dry run writes nothing.
    expect(await run(s.t, (ctx) => ctx.db.get(budgetId))).not.toBeNull();

    const real = await s.t.mutation(internal.sweepOrphanedRefBudgets.sweepOrphanedRefBudgets, {
      execute: true,
    });
    expect(real.deleted.map((r) => r.name)).toEqual(["Create sponsorship package for LTN"]);
    expect(await run(s.t, (ctx) => ctx.db.get(budgetId))).toBeNull();
  });

  test("leaves a budget whose ref still resolves", async () => {
    const s = await setupChapter(newT());
    const projectId = await seedProject(s, "Live project");
    const budgetId = await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 50_000,
        type: "one_time",
        cadence: "per_instance",
        refKind: "project",
        scopeRefId: projectId,
        label: "Live project",
        year: 2026,
        approvalStatus: "approved",
        createdAt: Date.now(),
      }),
    );

    const res = await s.t.mutation(internal.sweepOrphanedRefBudgets.sweepOrphanedRefBudgets, {
      execute: true,
    });

    expect(res.deleted).toEqual([]);
    expect(res.kept).toEqual([]);
    expect(await run(s.t, (ctx) => ctx.db.get(budgetId))).not.toBeNull();
  });

  test("REFUSES an orphan with spend on it, and says what it found", async () => {
    const s = await setupChapter(newT());
    const budgetId = await seedOrphanedProjectBudget(s, {
      name: "Recap video",
      amountCents: 600_000,
    });
    await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "relay_csv",
        flow: "outflow",
        amountCents: 32_500,
        postedAt: Date.now(),
        status: "reconciled",
        budgetId,
        createdAt: Date.now(),
      }),
    );

    const res = await s.t.mutation(internal.sweepOrphanedRefBudgets.sweepOrphanedRefBudgets, {
      execute: true,
    });

    expect(res.deleted).toEqual([]);
    expect(res.kept).toHaveLength(1);
    expect(res.kept[0].keptBecause).toContain("$325.00");
    // Still there, still coded — the money keeps a legible home.
    expect(await run(s.t, (ctx) => ctx.db.get(budgetId))).not.toBeNull();
  });

  test("REFUSES an orphan carrying plan lines", async () => {
    const s = await setupChapter(newT());
    const budgetId = await seedOrphanedProjectBudget(s, { name: "Planned but dead" });
    await run(s.t, (ctx) =>
      ctx.db.insert("budgetLines", {
        budgetId,
        description: "Venue",
        plannedCents: 1_000,
        sortOrder: 0,
        createdBy: s.userId,
        createdAt: Date.now(),
      }),
    );

    const res = await s.t.mutation(internal.sweepOrphanedRefBudgets.sweepOrphanedRefBudgets, {
      execute: true,
    });

    expect(res.deleted).toEqual([]);
    expect(res.kept[0].keptBecause).toContain("budgetLines");
    expect(await run(s.t, (ctx) => ctx.db.get(budgetId))).not.toBeNull();
  });

  test("is idempotent — a settled re-run deletes nothing", async () => {
    const s = await setupChapter(newT());
    await seedOrphanedProjectBudget(s, { name: "Gone" });

    await s.t.mutation(internal.sweepOrphanedRefBudgets.sweepOrphanedRefBudgets, {
      execute: true,
    });
    const second = await s.t.mutation(
      internal.sweepOrphanedRefBudgets.sweepOrphanedRefBudgets,
      { execute: true },
    );

    expect(second.deleted).toEqual([]);
    expect(second.scanned).toBe(0);
  });
});
