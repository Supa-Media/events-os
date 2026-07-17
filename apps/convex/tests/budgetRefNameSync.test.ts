import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * WP-wave4 (item 2) — ref name/date sync (read-time derivation). A one_time
 * budget's DISPLAY name/date is resolved LIVE from its linked event/project
 * at read time (`finances.ts#resolveBudgetRef`) — a rename or deadline
 * change follows everywhere without a stale write-through. The stored
 * `budget.label` is only ever a FALLBACK, for a budget with no ref or whose
 * ref has vanished.
 *
 * Covers: dashboardChapter's one-time cards, dashboardCentral's central
 * one-time cards (a project budget transferred to central), tagDrilldown's
 * budget rows, and the deleted-ref fallback.
 */

async function seedManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Manager",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

async function seedEvent(
  s: ChapterSetup,
  opts: { name?: string; eventDate?: number } = {},
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
      name: opts.name ?? "Sunday Gathering",
      eventDate: opts.eventDate ?? Date.now(),
      status: "planning",
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

describe("dashboardChapter one-time cards follow the ref's LIVE name/date (WP-wave4 item 2)", () => {
  test("renaming a project updates its budget card's name — no write-through needed", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const year = 2026;
    const projectId = await seedProject(s, "Pitch Deck for EP");
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 50000,
      type: "one_time",
      refKind: "project",
      cadence: "per_instance",
      year,
      scopeRefId: projectId,
    });

    let dash = await s.as.query(api.finances.dashboardChapter, { year, period: "ytd" });
    expect(dash.oneTimeBudgets.find((b) => b.id === budgetId)?.name).toBe("Pitch Deck for EP");

    await s.as.mutation(api.projects.update, { projectId, name: "Album Launch" });

    dash = await s.as.query(api.finances.dashboardChapter, { year, period: "ytd" });
    expect(dash.oneTimeBudgets.find((b) => b.id === budgetId)?.name).toBe("Album Launch");
  });

  test("changing a project's deadline updates its budget card's dateLabel", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const year = 2026;
    // Noon UTC (mirrors other suites' `tsInMonth` helper) so the Eastern-time
    // date never rolls over to the prior day.
    const firstDeadline = Date.UTC(year, 2, 1, 17, 0, 0); // March 1
    const projectId = await seedProject(s, "Love Wins", { deadline: firstDeadline });
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 50000,
      type: "one_time",
      refKind: "project",
      cadence: "per_instance",
      year,
      scopeRefId: projectId,
    });

    let dash = await s.as.query(api.finances.dashboardChapter, { year, period: "ytd" });
    let card = dash.oneTimeBudgets.find((b) => b.id === budgetId);
    // `easternDateStr` formats as YYYY-MM-DD (America/New_York).
    expect(card?.dateLabel).toBe("2026-03-01");

    const newDeadline = Date.UTC(year, 8, 15, 17, 0, 0); // September 15
    await s.as.mutation(api.projects.update, { projectId, deadline: newDeadline });

    dash = await s.as.query(api.finances.dashboardChapter, { year, period: "ytd" });
    card = dash.oneTimeBudgets.find((b) => b.id === budgetId);
    expect(card?.dateLabel).toBe("2026-09-15");
  });

  test("renaming an event updates its budget card's name", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const year = 2026;
    const eventId = await seedEvent(s, { name: "Sunday Gathering" });
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 40000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year,
      scopeRefId: eventId,
    });

    await s.as.mutation(api.events.updateDetails, { eventId, name: "Fall Retreat Worship" });

    const dash = await s.as.query(api.finances.dashboardChapter, { year, period: "ytd" });
    expect(dash.oneTimeBudgets.find((b) => b.id === budgetId)?.name).toBe("Fall Retreat Worship");
  });

  test("a deleted ref falls back to the budget's own stored label — never a crash or blank card", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const year = 2026;
    const eventId = await seedEvent(s, { name: "Doomed Event" });
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 15000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year,
      scopeRefId: eventId,
      label: "Fallback Label",
    });

    // Delete the event row directly — a budget row outlives its ref (no
    // cascade), exactly the case `resolveBudgetRef`'s fallback exists for.
    await run(t, (ctx) => ctx.db.delete(eventId));

    const dash = await s.as.query(api.finances.dashboardChapter, { year, period: "ytd" });
    const card = dash.oneTimeBudgets.find((b) => b.id === budgetId);
    expect(card).toBeDefined();
    expect(card?.name).toBe("Fallback Label");
    expect(card?.dateLabel).toBeNull();
  });
});

describe("dashboardCentral one-time cards follow the ref's LIVE name too (WP-wave4 item 2)", () => {
  test("renaming a project with a CENTRAL one-time budget updates its central dashboard card", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" }); // superuser: implicit central manager
    const year = 2026;
    const projectId = await seedProject(s, "Music Recording");
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 80000,
      type: "one_time",
      refKind: "project",
      cadence: "per_instance",
      year,
      scopeRefId: projectId,
      central: true,
    });

    let dashCentral = await s.as.query(api.finances.dashboardCentral, { year, period: "ytd" });
    expect(dashCentral.centralBudgets.find((b) => b.id === budgetId)?.name).toBe("Music Recording");

    await s.as.mutation(api.projects.update, { projectId, name: "Debut Album" });

    dashCentral = await s.as.query(api.finances.dashboardCentral, { year, period: "ytd" });
    const card = dashCentral.centralBudgets.find((b) => b.id === budgetId);
    expect(card?.name).toBe("Debut Album");
    expect(card?.refKind).toBe("project");
    expect(card?.scopeRefId).toBe(projectId);
  });
});

describe("tagDrilldown budget rows follow the ref's LIVE name too (WP-wave4 item 2)", () => {
  test("renaming a project updates its row's name in the tag drill-down sheet", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const year = 2026;
    const projectId = await seedProject(s, "Pitch Deck for EP");
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 50000,
      type: "one_time",
      refKind: "project",
      cadence: "per_instance",
      year,
      scopeRefId: projectId,
    });
    const tagId = await s.as.mutation(api.finances.createBudgetTag, {
      name: "Music",
      kind: "custom",
    });
    await s.as.mutation(api.finances.updateBudget, {
      budgetId,
      patch: {},
      tagIds: [tagId],
    });

    let drill = await s.as.query(api.finances.tagDrilldown, {
      year,
      period: "ytd",
      scope: "chapter",
      tagId,
    });
    expect(drill.budgets.find((b) => b.id === budgetId)?.name).toBe("Pitch Deck for EP");

    await s.as.mutation(api.projects.update, { projectId, name: "Album Launch" });

    drill = await s.as.query(api.finances.tagDrilldown, {
      year,
      period: "ytd",
      scope: "chapter",
      tagId,
    });
    expect(drill.budgets.find((b) => b.id === budgetId)?.name).toBe("Album Launch");
  });
});
