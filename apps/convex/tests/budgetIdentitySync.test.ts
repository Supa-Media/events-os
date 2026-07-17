/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Budget identity & dates — the write-through half.
 *
 * `budgetRefNameSync.test.ts` (WP-wave4 item 2, PR #225) already covers LIVE
 * display resolution — a rename/date-change shows up on the dashboard with
 * no write-through at all, via `resolveBudgetRef`. This suite covers the
 * complementary STORED write-through (`syncBudgetIdentityForRef`), which
 * live resolution can't substitute for: `dashboardChapter`/`dashboardCentral`
 * key their whole budget fetch on the STORED `year` (`by_chapter_and_period`)
 * — a budget whose stored year drifts from its entity's real year is never
 * even fetched into the right year's dashboard, however live the display
 * resolver is. Also covers `updateBudget` rejecting label/year/month edits on
 * a linked budget (those fields derive from the entity, always — never a
 * caller-supplied value). `budgetMonthGate.test.ts` covers the paired
 * `oneTimeCardAppliesToDash` month-gate fix.
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

async function getBudget(s: ChapterSetup, budgetId: Id<"budgets">) {
  return await run(s.t, (ctx) => ctx.db.get(budgetId));
}

describe("write-through sync: STORED label/year/month follow the linked entity", () => {
  test("renaming a project patches the budget's STORED label, not just the live-resolved dashboard name", async () => {
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

    await s.as.mutation(api.projects.update, { projectId, name: "Album Launch" });

    const budget = await getBudget(s, budgetId);
    expect(budget?.label).toBe("Album Launch");
  });

  test("changing a project's deadline (projects.update) patches the budget's STORED year/month", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const projectId = await seedProject(s, "Love Wins", {
      deadline: tsOnDay(2026, 3, 1),
    });
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 50000,
      type: "one_time",
      refKind: "project",
      cadence: "per_instance",
      year: 2026,
      month: 3,
      scopeRefId: projectId,
    });

    await s.as.mutation(api.projects.update, {
      projectId,
      deadline: tsOnDay(2026, 9, 15),
    });

    const budget = await getBudget(s, budgetId);
    expect(budget?.year).toBe(2026);
    expect(budget?.month).toBe(9);
  });

  test("a project's deadline crossing a year boundary patches the budget's STORED year too", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const projectId = await seedProject(s, "New Year Push", {
      deadline: tsOnDay(2026, 11, 1),
    });
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 20000,
      type: "one_time",
      refKind: "project",
      cadence: "per_instance",
      year: 2026,
      month: 11,
      scopeRefId: projectId,
    });

    await s.as.mutation(api.projects.update, {
      projectId,
      deadline: tsOnDay(2027, 1, 10),
    });

    const budget = await getBudget(s, budgetId);
    expect(budget?.year).toBe(2027);
    expect(budget?.month).toBe(1);
  });

  test("renaming an event (events.updateDetails) patches the budget's STORED label", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const eventId = await seedEvent(s, { name: "Sunday Gathering", eventDate: tsOnDay(2026, 6, 7) });
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 40000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year: 2026,
      month: 6,
      scopeRefId: eventId,
    });

    await s.as.mutation(api.events.updateDetails, { eventId, name: "Fall Retreat Worship" });

    const budget = await getBudget(s, budgetId);
    expect(budget?.label).toBe("Fall Retreat Worship");
  });

  test("rescheduling an event (events.reschedule) patches the budget's STORED year/month — updateDetails never touches eventDate", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const eventId = await seedEvent(s, { name: "Sunday Gathering", eventDate: tsOnDay(2026, 6, 7) });
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 40000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year: 2026,
      month: 6,
      scopeRefId: eventId,
    });

    await s.as.mutation(api.events.reschedule, { eventId, eventDate: tsOnDay(2026, 12, 20) });

    const budget = await getBudget(s, budgetId);
    expect(budget?.year).toBe(2026);
    expect(budget?.month).toBe(12);
  });

  test("no-op when nothing is linked — an unlinked recurring budget is untouched by a project rename", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const projectId = await seedProject(s, "Untracked Project");
    // A recurring budget that just happens to exist in the same chapter —
    // nothing links it to this project.
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 10000,
      type: "recurring",
      cadence: "monthly",
      year: 2026,
      month: 1,
      label: "General Ops",
    });

    await s.as.mutation(api.projects.update, { projectId, name: "Renamed Project" });

    const budget = await getBudget(s, budgetId);
    expect(budget?.label).toBe("General Ops");
    expect(budget?.year).toBe(2026);
    expect(budget?.month).toBe(1);
  });
});

describe("updateBudget rejects label/year/month edits on a linked (one_time + refKind + scopeRefId) budget", () => {
  test("patching label on an already-linked budget throws ConvexError", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const eventId = await seedEvent(s, { name: "Linked Event" });
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 10000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year: 2026,
      scopeRefId: eventId,
    });

    await expect(
      s.as.mutation(api.finances.updateBudget, {
        budgetId,
        patch: { label: "Custom Override" },
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("patching year on an already-linked budget throws ConvexError", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const eventId = await seedEvent(s, { name: "Linked Event" });
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 10000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year: 2026,
      scopeRefId: eventId,
    });

    await expect(
      s.as.mutation(api.finances.updateBudget, {
        budgetId,
        patch: { year: 2027 },
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("patching month on an already-linked budget throws ConvexError", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const eventId = await seedEvent(s, { name: "Linked Event" });
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 10000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year: 2026,
      month: 3,
      scopeRefId: eventId,
    });

    await expect(
      s.as.mutation(api.finances.updateBudget, {
        budgetId,
        patch: { month: 4 },
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("converting an unlinked budget onto a ref in the SAME patch call also rejects a simultaneous label (effective post-patch state)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const projectId = await seedProject(s, "Newly Linked Project");
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 10000,
      type: "recurring",
      cadence: "monthly",
      year: 2026,
      month: 1,
      label: "Was Recurring",
    });

    await expect(
      s.as.mutation(api.finances.updateBudget, {
        budgetId,
        patch: {
          type: "one_time",
          refKind: "project",
          scopeRefId: projectId,
          label: "Sneaking In A Custom Label",
        },
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("unlinked/recurring budgets keep current behavior — label/year/month edits still succeed", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 10000,
      type: "recurring",
      cadence: "monthly",
      year: 2026,
      month: 1,
      label: "General Ops",
    });

    await s.as.mutation(api.finances.updateBudget, {
      budgetId,
      patch: { label: "Renamed Ops Bucket", year: 2027, month: 2 },
    });

    const budget = await getBudget(s, budgetId);
    expect(budget?.label).toBe("Renamed Ops Bucket");
    expect(budget?.year).toBe(2027);
    expect(budget?.month).toBe(2);
  });

  test("amount/category/tag edits on a linked budget still succeed — only label/year/month are blocked", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const eventId = await seedEvent(s, { name: "Linked Event" });
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 10000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year: 2026,
      scopeRefId: eventId,
    });

    await s.as.mutation(api.finances.updateBudget, {
      budgetId,
      patch: { amountCents: 25000 },
    });

    const budget = await getBudget(s, budgetId);
    expect(budget?.amountCents).toBe(25000);
  });

  test("unlinking a budget (clearing refKind/scopeRefId) makes label/year/month editable again in the same call", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const eventId = await seedEvent(s, { name: "Linked Event" });
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 10000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year: 2026,
      scopeRefId: eventId,
    });

    await s.as.mutation(api.finances.updateBudget, {
      budgetId,
      patch: {
        type: "recurring",
        cadence: "monthly",
        label: "Now Untethered",
        year: 2026,
        month: 5,
      },
    });

    const budget = await getBudget(s, budgetId);
    expect(budget?.label).toBe("Now Untethered");
    expect(budget?.type).toBe("recurring");
  });
});
