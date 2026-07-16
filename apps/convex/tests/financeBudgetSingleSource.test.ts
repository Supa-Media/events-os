/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * WP-U2 — the budgets row is the single source of truth for an event/project's
 * planned amount; the entity's own field (`events.budget` /
 * `projects.budgetUsd`) is a transition-period MIRROR kept in sync by the
 * shared `setBudgetAmount` helper.
 *
 * Covers the four legs of the mechanism:
 *  1. ENTITY-side edits (events.updateDetails / projects.update) write THROUGH
 *     to the budget row when one exists (and still summon one via the D8 path
 *     when none does).
 *  2. FINANCE-side edits (finances.updateBudget) mirror the amount back onto
 *     the entity field.
 *  3. Readers (events.get, projects.get/list) report the ROW's amount, even
 *     when the mirror has drifted.
 *  4. The `reconcileEntityBudgetDrift` migration: row wins, drift is logged,
 *     re-runs are no-ops.
 */

function tsInMonth(year: number, month: number): number {
  return Date.UTC(year, month - 1, 15, 17, 0, 0);
}

/** Seed an eventType + event directly (same shape as the backfill tests). */
async function seedEvent(
  s: ChapterSetup,
  opts: { name?: string; eventDate?: number; budget?: number } = {},
): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Worship with Strangers",
      slug: "wws",
      version: 1,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: opts.name ?? "May Worship",
      eventDate: opts.eventDate ?? tsInMonth(2026, 5),
      budget: opts.budget,
      status: "planning",
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

/** The one_time budget row attached to a ref (via by_ref), or null. */
async function budgetForRef(
  s: ChapterSetup,
  refKind: "event" | "project",
  refId: string,
): Promise<Doc<"budgets"> | null> {
  return await run(s.t, (ctx) =>
    ctx.db
      .query("budgets")
      .withIndex("by_ref", (q) => q.eq("refKind", refKind).eq("scopeRefId", refId))
      .first(),
  );
}

/** Grant the setup user a chapter-manager finance role (for updateBudget). */
async function asChapterManager(s: ChapterSetup): Promise<Id<"people">> {
  return await run(s.t, async (ctx) => {
    const personId = await ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    });
    await ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "chapter",
      createdAt: Date.now(),
    });
    return personId;
  });
}

describe("entity-side edits write through to the budget row (WP-U2)", () => {
  test("events.updateDetails amount edit updates the row AND the mirror stays in sync", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = (await s.as.mutation(api.events.createFromTemplate, {
      eventTypeId: await run(s.t, (ctx) =>
        ctx.db.insert("eventTypes", {
          chapterId: s.chapterId,
          name: "WWS",
          slug: "wws",
          version: 1,
          createdBy: s.userId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      ),
      name: "Funded Event",
      eventDate: tsInMonth(2026, 6),
      budget: 300, // create-time hook summons the row at $300
    })) as Id<"events">;
    const before = await budgetForRef(s, "event", eventId);
    expect(before?.amountCents).toBe(30000);

    await s.as.mutation(api.events.updateDetails, { eventId, budget: 450 });

    const row = await budgetForRef(s, "event", eventId);
    expect(row?.amountCents).toBe(45000); // the ROW took the edit
    expect(row?._id).toBe(before?._id); // same row — no duplicate summoned
    const ev = await run(s.t, (ctx) => ctx.db.get(eventId));
    expect(ev?.budget).toBe(450); // mirror synced row→field
  });

  test("projects.update amount edit updates the row AND the mirror stays in sync", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Funded Project",
      budgetUsd: 100,
    })) as Id<"projects">;
    const before = await budgetForRef(s, "project", projectId);
    expect(before?.amountCents).toBe(10000);

    await s.as.mutation(api.projects.update, { projectId, budgetUsd: 275 });

    const row = await budgetForRef(s, "project", projectId);
    expect(row?.amountCents).toBe(27500);
    expect(row?._id).toBe(before?._id);
    const project = await run(s.t, (ctx) => ctx.db.get(projectId));
    expect(project?.budgetUsd).toBe(275);
  });

  test("clearing the entity amount zeroes the row (never deletes it) and clears the mirror", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Cleared Project",
      budgetUsd: 100,
    })) as Id<"projects">;

    await s.as.mutation(api.projects.update, { projectId, budgetUsd: null });

    const row = await budgetForRef(s, "project", projectId);
    expect(row).not.toBeNull(); // never deleted
    expect(row?.amountCents).toBe(0); // the row took the clear as $0
    const project = await run(s.t, (ctx) => ctx.db.get(projectId));
    expect(project?.budgetUsd).toBeUndefined(); // mirror rule: $0 → unset
  });

  test("no-budget entity edit still summons via the D8 path (no row → create, not write-through)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, { name: "Starts Free", budget: undefined });
    expect(await budgetForRef(s, "event", eventId)).toBeNull();

    await s.as.mutation(api.events.updateDetails, { eventId, budget: 350 });

    const row = await budgetForRef(s, "event", eventId);
    expect(row?.amountCents).toBe(35000);
    expect(row?.type).toBe("one_time");
    expect(row?.cadence).toBe("per_instance");
    const ev = await run(s.t, (ctx) => ctx.db.get(eventId));
    expect(ev?.budget).toBe(350);
  });
});

describe("finance-side edits mirror onto the entity field (WP-U2)", () => {
  test("updateBudget amountCents on an event budget syncs events.budget", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const eventId = await seedEvent(s, { name: "Finance-Edited", budget: 200 });
    await t.mutation(internal.finances.backfillEventBudgets, {});
    const row = await budgetForRef(s, "event", eventId);
    expect(row?.amountCents).toBe(20000);

    await s.as.mutation(api.finances.updateBudget, {
      budgetId: row!._id,
      patch: { amountCents: 62500 },
    });

    const after = await budgetForRef(s, "event", eventId);
    expect(after?.amountCents).toBe(62500);
    const ev = await run(s.t, (ctx) => ctx.db.get(eventId));
    expect(ev?.budget).toBe(625); // mirror synced row→field
  });

  test("updateBudget amountCents on a project budget syncs projects.budgetUsd", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Finance-Edited Project",
      budgetUsd: 100,
    })) as Id<"projects">;
    const row = await budgetForRef(s, "project", projectId);

    await s.as.mutation(api.finances.updateBudget, {
      budgetId: row!._id,
      patch: { amountCents: 88800 },
    });

    const project = await run(s.t, (ctx) => ctx.db.get(projectId));
    expect(project?.budgetUsd).toBe(888);
  });

  test("updateBudget amountCents to 0 clears the mirror to unset (not a literal $0)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Zeroed From Finance",
      budgetUsd: 50,
    })) as Id<"projects">;
    const row = await budgetForRef(s, "project", projectId);

    await s.as.mutation(api.finances.updateBudget, {
      budgetId: row!._id,
      patch: { amountCents: 0 },
    });

    expect((await budgetForRef(s, "project", projectId))?.amountCents).toBe(0);
    const project = await run(s.t, (ctx) => ctx.db.get(projectId));
    expect(project?.budgetUsd).toBeUndefined();
  });

  test("updateBudget on a recurring budget (no ref) has nothing to mirror and doesn't throw", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 10000,
      type: "recurring",
      cadence: "monthly",
      year: 2026,
      label: "Ops",
    });

    await s.as.mutation(api.finances.updateBudget, {
      budgetId,
      patch: { amountCents: 20000 },
    });

    const row = await run(s.t, (ctx) => ctx.db.get(budgetId));
    expect(row?.amountCents).toBe(20000);
  });

  test("setBudgetAmount survives a deleted ref (budget row outlives its project)", async () => {
    // `updateBudget` itself re-verifies the ref (verifyBudgetRefs) and rejects
    // a deleted one before reaching the mirror — this exercises the shared
    // helper directly, since other callers (and future ones, e.g. WP-3.2's
    // approval retrigger) rely on the mirror not crashing on a stale ref.
    const t = newT();
    const s = await setupChapter(t);
    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Doomed Project",
      budgetUsd: 100,
    })) as Id<"projects">;
    const row = await budgetForRef(s, "project", projectId);
    await run(s.t, (ctx) => ctx.db.delete(projectId)); // ref gone, row stays

    const { setBudgetAmount } = await import("../finances");
    await run(s.t, (ctx) => setBudgetAmount(ctx, row!._id, 5000));

    expect((await run(s.t, (ctx) => ctx.db.get(row!._id)))?.amountCents).toBe(5000);
  });
});

describe("readers report the ROW's amount (WP-U2 sweep)", () => {
  test("events.get reads the row even when the mirror field has drifted", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, { name: "Drifted Event", budget: 200 });
    await t.mutation(internal.finances.backfillEventBudgets, {});
    // Simulate pre-WP-U2 drift: the entity field was edited without the row.
    await run(s.t, (ctx) => ctx.db.patch(eventId, { budget: 999 }));

    const data = await s.as.query(api.events.get, { eventId });
    expect(data?.event.budget).toBe(200); // the ROW's $200, not the drifted $999
    expect(data?.budgetId).not.toBeNull();
  });

  test("events.get budgetPct is computed against the row's amount", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, { name: "Pct Event", budget: 100 });
    await t.mutation(internal.finances.backfillEventBudgets, {});
    // Drift the mirror to something that would change the percentage.
    await run(s.t, (ctx) => ctx.db.patch(eventId, { budget: 1 }));

    const data = await s.as.query(api.events.get, { eventId });
    // No item costs seeded → spent 0, pct 0 — but the denominator is the row.
    expect(data?.event.budget).toBe(100);
    expect(data?.budgetPct).toBe(0);
  });

  test("events.get with no budget row reports no planned amount (the 'add budget' empty state)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, { name: "No Budget Yet", budget: undefined });

    const data = await s.as.query(api.events.get, { eventId });
    expect(data?.event.budget).toBeUndefined();
    expect(data?.budgetId).toBeNull();
  });

  test("projects.get and projects.list read the row even when the mirror has drifted", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Drifted Project",
      budgetUsd: 300,
    })) as Id<"projects">;
    await run(s.t, (ctx) => ctx.db.patch(projectId, { budgetUsd: 777 }));

    const got = await s.as.query(api.projects.get, { projectId });
    expect(got?.budgetUsd).toBe(300); // the ROW's $300, not the drifted $777

    const listed = await s.as.query(api.projects.list, {});
    expect(listed.find((p) => p._id === projectId)?.budgetUsd).toBe(300);
  });

  test("a reader reflects a finance-side row edit immediately", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Live Reader",
      budgetUsd: 100,
    })) as Id<"projects">;
    const row = await budgetForRef(s, "project", projectId);

    await s.as.mutation(api.finances.updateBudget, {
      budgetId: row!._id,
      patch: { amountCents: 41000 },
    });

    const got = await s.as.query(api.projects.get, { projectId });
    expect(got?.budgetUsd).toBe(410);
  });
});

describe("reconcileEntityBudgetDrift (internal migration — row wins)", () => {
  test("overwrites a drifted event field to match the row and logs the drift", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, { name: "Drifted Event", budget: 200 });
    await t.mutation(internal.finances.backfillEventBudgets, {});
    const row = await budgetForRef(s, "event", eventId);
    await run(s.t, (ctx) => ctx.db.patch(eventId, { budget: 999 }));

    const result = await t.mutation(internal.finances.reconcileEntityBudgetDrift, {});
    expect(result.fixed).toBe(1);
    expect(result.isDone).toBe(true);
    expect(result.drifts).toHaveLength(1);
    expect(result.drifts[0]).toMatchObject({
      refKind: "event",
      refId: eventId,
      refName: "Drifted Event",
      budgetId: row!._id,
      entityValueUsd: 999,
      rowAmountUsd: 200,
    });

    const ev = await run(s.t, (ctx) => ctx.db.get(eventId));
    expect(ev?.budget).toBe(200); // row wins
  });

  test("overwrites a drifted project field to match the row and logs the drift", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Drifted Project",
      budgetUsd: 300,
    })) as Id<"projects">;
    await run(s.t, (ctx) => ctx.db.patch(projectId, { budgetUsd: 12 }));

    const result = await t.mutation(internal.finances.reconcileEntityBudgetDrift, {});
    expect(result.fixed).toBe(1);
    expect(result.drifts[0]).toMatchObject({
      refKind: "project",
      refName: "Drifted Project",
      entityValueUsd: 12,
      rowAmountUsd: 300,
    });

    const project = await run(s.t, (ctx) => ctx.db.get(projectId));
    expect(project?.budgetUsd).toBe(300);
  });

  test("a zero-amount row clears the entity field to unset (the mirror rule)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Zero Row",
    })) as Id<"projects">;
    // A $0 "plan" budget (e.g. summoned by the For picker) + a drifted field.
    await run(s.t, async (ctx) => {
      await ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 0,
        type: "one_time",
        refKind: "project",
        scopeRefId: projectId,
        cadence: "per_instance",
        year: 2026,
        createdAt: Date.now(),
      });
      await ctx.db.patch(projectId, { budgetUsd: 55 });
    });

    const result = await t.mutation(internal.finances.reconcileEntityBudgetDrift, {});
    expect(result.fixed).toBe(1);
    expect(result.drifts[0]).toMatchObject({ entityValueUsd: 55, rowAmountUsd: null });

    const project = await run(s.t, (ctx) => ctx.db.get(projectId));
    expect(project?.budgetUsd).toBeUndefined();
  });

  test("is idempotent — a second run fixes nothing and logs no drift", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Settled Project",
      budgetUsd: 300,
    })) as Id<"projects">;
    await run(s.t, (ctx) => ctx.db.patch(projectId, { budgetUsd: 42 }));

    const first = await t.mutation(internal.finances.reconcileEntityBudgetDrift, {});
    expect(first.fixed).toBe(1);

    const second = await t.mutation(internal.finances.reconcileEntityBudgetDrift, {});
    expect(second.fixed).toBe(0);
    expect(second.alreadySynced).toBe(1);
    expect(second.drifts).toHaveLength(0);
  });

  test("in-sync rows count as alreadySynced; recurring budgets aren't scanned", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    // One in-sync project + one recurring budget (no ref → excluded entirely).
    await s.as.mutation(api.projects.create, { name: "In Sync", budgetUsd: 100 });
    await s.as.mutation(api.finances.createBudget, {
      amountCents: 10000,
      type: "recurring",
      cadence: "monthly",
      year: 2026,
      label: "Ops",
    });

    const result = await t.mutation(internal.finances.reconcileEntityBudgetDrift, {});
    expect(result.scanned).toBe(1); // only the one_time project budget
    expect(result.alreadySynced).toBe(1);
    expect(result.fixed).toBe(0);
  });

  test("a budget whose ref was deleted is skipped, not crashed on", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Deleted Ref",
      budgetUsd: 100,
    })) as Id<"projects">;
    await run(s.t, (ctx) => ctx.db.delete(projectId));

    const result = await t.mutation(internal.finances.reconcileEntityBudgetDrift, {});
    expect(result.skipped).toBe(1);
    expect(result.fixed).toBe(0);
  });

  test("paginates: a small page size still converges to isDone with the same totals", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // Three drifted projects.
    for (const name of ["P1", "P2", "P3"]) {
      const projectId = (await s.as.mutation(api.projects.create, {
        name,
        budgetUsd: 100,
      })) as Id<"projects">;
      await run(s.t, (ctx) => ctx.db.patch(projectId, { budgetUsd: 5 }));
    }

    let cursor: string | null = null;
    let isDone = false;
    let fixed = 0;
    let pages = 0;
    while (!isDone) {
      const result: {
        fixed: number;
        continueCursor: string;
        isDone: boolean;
      } = await t.mutation(internal.finances.reconcileEntityBudgetDrift, {
        paginationOpts: { numItems: 1, cursor },
      });
      fixed += result.fixed;
      cursor = result.continueCursor;
      isDone = result.isDone;
      pages++;
      expect(pages).toBeLessThan(10); // safety against a non-advancing cursor
    }
    expect(fixed).toBe(3);
  });

  test("scopes to a single chapter when chapterId is passed", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = (await s.as.mutation(api.projects.create, {
      name: "Scoped",
      budgetUsd: 100,
    })) as Id<"projects">;
    await run(s.t, (ctx) => ctx.db.patch(projectId, { budgetUsd: 7 }));

    const result = await t.mutation(internal.finances.reconcileEntityBudgetDrift, {
      chapterId: s.chapterId,
    });
    expect(result.fixed).toBe(1);
    const project = await run(s.t, (ctx) => ctx.db.get(projectId));
    expect(project?.budgetUsd).toBe(100);
  });
});
