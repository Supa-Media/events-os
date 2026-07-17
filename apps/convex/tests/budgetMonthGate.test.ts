/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Budget identity & dates (item 4) — `oneTimeCardAppliesToDash`'s month-gate
 * fix. Before this fix, the stored `budget.month` short-circuited the gate
 * ahead of the linked ref's real date (`b.month === dp.month` OR'd first) —
 * a budget whose stored month happened to match the viewed month (e.g. its
 * CREATION month, before the write-through sync in `budgetIdentitySync.
 * test.ts` existed) would show up there regardless of what its entity's real
 * date said. Now a resolvable `refDate` decides on its own; the stored
 * `month` is only consulted as a fallback when there's no ref date to
 * resolve.
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

/** Noon UTC on a given Eastern month/day so the date never rolls over. */
function tsOnDay(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day, 17, 0, 0);
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

describe("oneTimeCardAppliesToDash: the entity's real date wins over the stored month when resolvable", () => {
  test("a budget created in July for a project due in March shows on March's dashboard, not July's", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const projectId = await seedProject(s, "Spring Gala", { deadline: tsOnDay(2026, 3, 1) });
    // Created with a stale/mismatched stored month (simulating a legacy row,
    // or a creation before the deadline was set) to isolate the gate's own
    // logic from the (now-fixed) creation-time derivation.
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 50000,
      type: "one_time",
      refKind: "project",
      cadence: "per_instance",
      year: 2026,
      month: 7,
      scopeRefId: projectId,
    });

    const marchDash = await s.as.query(api.finances.dashboardChapter, { year: 2026, month: 3 });
    expect(marchDash.oneTimeBudgets.some((b) => b.id === budgetId)).toBe(true);

    const julyDash = await s.as.query(api.finances.dashboardChapter, { year: 2026, month: 7 });
    expect(julyDash.oneTimeBudgets.some((b) => b.id === budgetId)).toBe(false);
  });

  test("year sync + month gate together: a budget created for a project due the following year appears under the correct year, not the creation year", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    // Real flow: create the budget (year auto-derives from the deadline via
    // the create-time hook path), then confirm the dashboard only shows it
    // in 2027, never 2026.
    const projectId = await seedProject(s, "New Year Launch", {
      deadline: tsOnDay(2027, 1, 15),
    });
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 30000,
      type: "one_time",
      refKind: "project",
      cadence: "per_instance",
      year: 2027,
      month: 1,
      scopeRefId: projectId,
    });

    const dash2027 = await s.as.query(api.finances.dashboardChapter, { year: 2027, month: 1 });
    expect(dash2027.oneTimeBudgets.some((b) => b.id === budgetId)).toBe(true);

    const dash2026 = await s.as.query(api.finances.dashboardChapter, { year: 2026, period: "ytd" });
    expect(dash2026.oneTimeBudgets.some((b) => b.id === budgetId)).toBe(false);
  });

  test("a budget whose ref has vanished falls back to its stored month for the gate (no refDate to resolve)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const eventId = await seedEvent(s, { name: "Doomed Event", eventDate: tsOnDay(2026, 5, 1) });
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 15000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year: 2026,
      month: 5,
      scopeRefId: eventId,
      label: "Fallback Label",
    });
    await run(t, (ctx) => ctx.db.delete(eventId));

    const mayDash = await s.as.query(api.finances.dashboardChapter, { year: 2026, month: 5 });
    expect(mayDash.oneTimeBudgets.some((b) => b.id === budgetId)).toBe(true);

    const juneDash = await s.as.query(api.finances.dashboardChapter, { year: 2026, month: 6 });
    expect(juneDash.oneTimeBudgets.some((b) => b.id === budgetId)).toBe(false);
  });
});
