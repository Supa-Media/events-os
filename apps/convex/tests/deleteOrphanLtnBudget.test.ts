import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { orphanBudgetProblems } from "../deleteOrphanLtnBudget";

/**
 * The state guards on the orphaned-budget cleanup.
 *
 * The runner addresses one production row by hard-coded id, so it can't be
 * exercised in a fixture — but every claim it makes about that row's CURRENT
 * state can, and those are the claims that decide whether running it is a
 * cleanup or a data loss.
 *
 * The linked-transaction guard is not hypothetical: this budget carried a $325
 * receipted charge until the morning it was scheduled for deletion. Had the
 * recode not happened first, the guard below is the only thing standing between
 * "delete the relic" and "drop coded spend into Unattributed".
 *
 * Delete this file with the module.
 */

/** `events.eventTypeId` is required; nothing here cares which type. */
function seedEventType(s: ChapterSetup, ctx: MutationCtx): Promise<Id<"eventTypes">> {
  return ctx.db.insert("eventTypes", {
    chapterId: s.chapterId,
    name: "T",
    slug: "t",
    version: 1,
    isArchived: false,
    createdBy: s.userId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

/** A `one_time` event budget whose `scopeRefId` points at nothing — the shape
 *  the production row is in. */
async function seedOrphanBudget(s: ChapterSetup): Promise<Id<"budgets">> {
  return await run(s.t, async (ctx) => {
    const eventId = await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId: await seedEventType(s, ctx),
      templateVersion: 1,
      name: "Love Thy Neighbor",
      eventDate: Date.now(),
      status: "planning",
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    // Delete it back out: an id that once resolved and no longer does is
    // exactly what a deleted event leaves behind on the budget.
    await ctx.db.delete(eventId);
    return await ctx.db.insert("budgets", {
      chapterId: s.chapterId,
      amountCents: 600_000,
      type: "one_time",
      cadence: "per_instance",
      refKind: "event",
      scopeRefId: eventId,
      label: "Love Thy Neighbor 2026",
      year: 2026,
      month: 9,
      approvalStatus: "approved",
      createdAt: Date.now(),
    });
  });
}

describe("orphanBudgetProblems", () => {
  test("a budget whose event is gone, with nothing hanging off it, is clean", async () => {
    const s = await setupChapter(newT());
    const budgetId = await seedOrphanBudget(s);

    const problems = await run(s.t, async (ctx) =>
      orphanBudgetProblems(ctx, (await ctx.db.get(budgetId))!),
    );

    expect(problems).toEqual([]);
  });

  test("refuses while a transaction is still coded to it — the $325 case", async () => {
    const s = await setupChapter(newT());
    const budgetId = await seedOrphanBudget(s);
    await run(s.t, async (ctx) => {
      await ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "relay_csv",
        flow: "outflow",
        amountCents: 32_500,
        postedAt: Date.now(),
        status: "reconciled",
        budgetId,
        createdAt: Date.now(),
      });
    });

    const problems = await run(s.t, async (ctx) =>
      orphanBudgetProblems(ctx, (await ctx.db.get(budgetId))!),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("32500¢");
    expect(problems[0]).toContain("recode them first");
  });

  test("refuses when the event ref resolves — it isn't orphaned", async () => {
    const s = await setupChapter(newT());
    const budgetId = await seedOrphanBudget(s);
    await run(s.t, async (ctx) => {
      const liveEventId = await ctx.db.insert("events", {
        chapterId: s.chapterId,
        eventTypeId: await seedEventType(s, ctx),
        templateVersion: 1,
        name: "2026 Love Thy Neighbor",
        eventDate: Date.now(),
        status: "planning",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.patch(budgetId, { scopeRefId: liveEventId });
    });

    const problems = await run(s.t, async (ctx) =>
      orphanBudgetProblems(ctx, (await ctx.db.get(budgetId))!),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("2026 Love Thy Neighbor");
    expect(problems[0]).toContain("not orphaned");
  });

  test("refuses when the budget carries plan lines — $0 spent isn't $0 planned", async () => {
    const s = await setupChapter(newT());
    const budgetId = await seedOrphanBudget(s);
    await run(s.t, async (ctx) => {
      await ctx.db.insert("budgetLines", {
        budgetId,
        description: "Recap video",
        plannedCents: 32_500,
        sortOrder: 0,
        createdBy: s.userId,
        createdAt: Date.now(),
      });
    });

    const problems = await run(s.t, async (ctx) =>
      orphanBudgetProblems(ctx, (await ctx.db.get(budgetId))!),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("budgetLines");
  });

  test("refuses when a reimbursement request points at it", async () => {
    const s = await setupChapter(newT());
    const budgetId = await seedOrphanBudget(s);
    await run(s.t, async (ctx) => {
      await ctx.db.insert("reimbursementRequests", {
        chapterId: s.chapterId,
        payeeName: "Josh Adriano",
        budgetId,
        token: "tok-ltn-2026",
        status: "submitted",
        totalCents: 32_500,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const problems = await run(s.t, async (ctx) =>
      orphanBudgetProblems(ctx, (await ctx.db.get(budgetId))!),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("reimbursement request(s)");
  });
});
