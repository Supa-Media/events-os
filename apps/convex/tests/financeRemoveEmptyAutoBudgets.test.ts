/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * `removeEmptyAutoBudgets` (internal, no-auth): the ops cleanup for the
 * dashboard clutter the owner flagged — every budget-less event/project got a
 * zero-amount `budgets` row from `backfillEventBudgets` (#125) and
 * `backfillProjectBudgets`/`projects.create`'s create-time hook BEFORE the
 * owner rule ("budgets only exist when money does") landed. This deletes
 * those, but NEVER a budget with linked spend or a nonzero amount.
 */

/** Insert a one_time budget row directly (bypassing every hook), simulating
 *  a pre-owner-rule auto-created row. */
async function seedAutoBudget(
  s: ChapterSetup,
  opts: {
    refKind: "event" | "project";
    scopeRefId: string;
    amountCents?: number;
  },
): Promise<Id<"budgets">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("budgets", {
      chapterId: s.chapterId,
      amountCents: opts.amountCents ?? 0,
      type: "one_time",
      refKind: opts.refKind,
      scopeRefId: opts.scopeRefId,
      cadence: "per_instance",
      year: 2026,
      createdAt: Date.now(),
    }),
  );
}

async function seedEvent(s: ChapterSetup, name = "Some Event"): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Generic Template",
      slug: "generic",
      version: 1,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name,
      eventDate: Date.now(),
      status: "planning",
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function seedProject(s: ChapterSetup, name = "Some Project"): Promise<Id<"projects">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("projects", {
      chapterId: s.chapterId,
      name,
      status: "not_started",
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

/** A minimal manual transaction linked to a budget (bypasses the mutation's
 *  gating — direct insert, like other finance test fixtures). */
async function seedLinkedTransaction(s: ChapterSetup, budgetId: Id<"budgets">): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: 500,
      postedAt: Date.now(),
      budgetId,
      status: "categorized",
      createdBy: s.userId,
      createdAt: Date.now(),
    }),
  );
}

describe("removeEmptyAutoBudgets (internal)", () => {
  test("deletes an empty auto-created EVENT budget (0 amount, no txns, no line items)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const budgetId = await seedAutoBudget(s, { refKind: "event", scopeRefId: eventId });

    const result = await t.mutation(internal.finances.removeEmptyAutoBudgets, {});
    expect(result.deleted).toBe(1);

    const budget = await run(s.t, (ctx) => ctx.db.get(budgetId));
    expect(budget).toBeNull();
  });

  test("deletes an empty auto-created PROJECT budget (0 amount, no txns)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = await seedProject(s);
    const budgetId = await seedAutoBudget(s, { refKind: "project", scopeRefId: projectId });

    const result = await t.mutation(internal.finances.removeEmptyAutoBudgets, {});
    expect(result.deleted).toBe(1);

    const budget = await run(s.t, (ctx) => ctx.db.get(budgetId));
    expect(budget).toBeNull();
  });

  test("also deletes the empty budget's tag links (no orphans)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = await seedProject(s);
    const budgetId = await seedAutoBudget(s, { refKind: "project", scopeRefId: projectId });
    const tagId = await run(s.t, (ctx) =>
      ctx.db.insert("budgetTags", {
        chapterId: s.chapterId,
        name: "Projects",
        kind: "custom",
        createdAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) =>
      ctx.db.insert("budgetTagLinks", {
        budgetId,
        tagId,
        chapterId: s.chapterId,
        createdAt: Date.now(),
      }),
    );

    await t.mutation(internal.finances.removeEmptyAutoBudgets, {});

    const links = await run(s.t, (ctx) =>
      ctx.db
        .query("budgetTagLinks")
        .withIndex("by_budget", (q) => q.eq("budgetId", budgetId))
        .collect(),
    );
    expect(links).toEqual([]);
  });

  test("NEVER deletes a budget with a nonzero amount", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = await seedProject(s);
    const budgetId = await seedAutoBudget(s, {
      refKind: "project",
      scopeRefId: projectId,
      amountCents: 10000,
    });

    const result = await t.mutation(internal.finances.removeEmptyAutoBudgets, {});
    expect(result.deleted).toBe(0);
    expect(result.keptNonzero).toBe(1);

    const budget = await run(s.t, (ctx) => ctx.db.get(budgetId));
    expect(budget).not.toBeNull();
  });

  test("NEVER deletes a zero-amount budget with a linked transaction (real spend)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const budgetId = await seedAutoBudget(s, { refKind: "event", scopeRefId: eventId });
    await seedLinkedTransaction(s, budgetId);

    const result = await t.mutation(internal.finances.removeEmptyAutoBudgets, {});
    expect(result.deleted).toBe(0);
    expect(result.keptWithSpend).toBe(1);

    const budget = await run(s.t, (ctx) => ctx.db.get(budgetId));
    expect(budget).not.toBeNull();
  });

  test("keeps a zero-amount EVENT budget whose event still carries legacy budgetLineItems", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const budgetId = await seedAutoBudget(s, { refKind: "event", scopeRefId: eventId });
    await run(s.t, (ctx) =>
      ctx.db.insert("budgetLineItems", {
        eventId,
        chapterId: s.chapterId,
        label: "PA rental",
        category: "production",
        plannedCents: 20000,
        order: 0,
        createdBy: s.userId,
        createdAt: Date.now(),
      }),
    );

    const result = await t.mutation(internal.finances.removeEmptyAutoBudgets, {});
    expect(result.deleted).toBe(0);
    expect(result.keptWithLineItems).toBe(1);

    const budget = await run(s.t, (ctx) => ctx.db.get(budgetId));
    expect(budget).not.toBeNull();
  });

  test("keeps a $0 EVENT budget that has WP-3.1 budgetLines planning (v2)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s);
    const budgetId = await seedAutoBudget(s, { refKind: "event", scopeRefId: eventId });
    await run(s.t, (ctx) =>
      ctx.db.insert("budgetLines", {
        budgetId,
        description: "PA rental",
        plannedCents: 20000,
        sortOrder: 0,
        createdBy: s.userId,
        createdAt: Date.now(),
      }),
    );

    const result = await t.mutation(internal.finances.removeEmptyAutoBudgets, {});
    expect(result.deleted).toBe(0);
    expect(result.keptWithLineItems).toBe(1);

    const budget = await run(s.t, (ctx) => ctx.db.get(budgetId));
    expect(budget).not.toBeNull();
    const lines = await run(s.t, (ctx) =>
      ctx.db
        .query("budgetLines")
        .withIndex("by_budget", (q) => q.eq("budgetId", budgetId))
        .collect(),
    );
    expect(lines).toHaveLength(1);
  });

  test("keeps a $0 PROJECT budget that has WP-3.1 budgetLines planning (v2)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = await seedProject(s);
    const budgetId = await seedAutoBudget(s, { refKind: "project", scopeRefId: projectId });
    await run(s.t, (ctx) =>
      ctx.db.insert("budgetLines", {
        budgetId,
        description: "Venue deposit",
        plannedCents: 50000,
        sortOrder: 0,
        createdBy: s.userId,
        createdAt: Date.now(),
      }),
    );

    const result = await t.mutation(internal.finances.removeEmptyAutoBudgets, {});
    expect(result.deleted).toBe(0);
    expect(result.keptWithLineItems).toBe(1);

    const budget = await run(s.t, (ctx) => ctx.db.get(budgetId));
    expect(budget).not.toBeNull();
  });

  test("deleting an empty budget leaves zero orphaned budgetLines rows", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = await seedProject(s);
    const budgetId = await seedAutoBudget(s, { refKind: "project", scopeRefId: projectId });
    // No budgetLines rows — this budget is genuinely empty and should be
    // deleted (and cascade, though there's nothing to cascade here).
    const result = await t.mutation(internal.finances.removeEmptyAutoBudgets, {});
    expect(result.deleted).toBe(1);

    const remainingLines = await run(s.t, (ctx) =>
      ctx.db
        .query("budgetLines")
        .withIndex("by_budget", (q) => q.eq("budgetId", budgetId))
        .collect(),
    );
    expect(remainingLines).toHaveLength(0);
  });

  test("ignores recurring budgets and legacy-scope-only budgets (never touches them)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // A recurring budget with no refKind — not an auto-created one_time row.
    const recurringId = await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 0,
        type: "recurring",
        cadence: "monthly",
        year: 2026,
        month: 5,
        createdAt: Date.now(),
      }),
    );

    const result = await t.mutation(internal.finances.removeEmptyAutoBudgets, {});
    expect(result.deleted).toBe(0);
    expect(result.scanned).toBe(0);

    const budget = await run(s.t, (ctx) => ctx.db.get(recurringId));
    expect(budget).not.toBeNull();
  });

  test("scopes to a single chapter when chapterId is passed", async () => {
    const t = newT();
    const s = await setupChapter(t, { chapterName: "Chapter A" });
    const other = await setupChapter(t, { chapterName: "Chapter B", email: "other@publicworship.life" });

    const projectA = await seedProject(s, "Project A");
    const projectB = await seedProject(other, "Project B");
    const budgetA = await seedAutoBudget(s, { refKind: "project", scopeRefId: projectA });
    const budgetB = await seedAutoBudget(other, { refKind: "project", scopeRefId: projectB });

    const result = await t.mutation(internal.finances.removeEmptyAutoBudgets, {
      chapterId: s.chapterId,
    });
    expect(result.deleted).toBe(1);

    expect(await run(s.t, (ctx) => ctx.db.get(budgetA))).toBeNull();
    expect(await run(s.t, (ctx) => ctx.db.get(budgetB))).not.toBeNull();
  });

  test("is idempotent — a second run deletes nothing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = await seedProject(s);
    await seedAutoBudget(s, { refKind: "project", scopeRefId: projectId });

    const first = await t.mutation(internal.finances.removeEmptyAutoBudgets, {});
    expect(first.deleted).toBe(1);

    const second = await t.mutation(internal.finances.removeEmptyAutoBudgets, {});
    expect(second.deleted).toBe(0);
    expect(second.scanned).toBe(0);
  });
});
