/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import { runSyncLinkedBudgetIdentity } from "../migrations/0027_sync_linked_budget_identity";

/**
 * Migration 0027: one-off backfill of the write-through sync
 * (`syncBudgetIdentityForRef`) onto every EXISTING linked one_time budget
 * whose stored label/year/month already drifted from its live entity before
 * the sync hooks existed.
 */

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
  opts: { deadline?: number; startDate?: number } = {},
): Promise<Id<"projects">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("projects", {
      chapterId: s.chapterId,
      name,
      status: "in_progress",
      deadline: opts.deadline,
      startDate: opts.startDate,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

/** Seed a v2 one_time budget row directly (bypassing createBudget) so its
 *  stored label/year/month can be deliberately STALE, simulating a row that
 *  predates the sync hooks. */
async function seedLinkedBudget(
  s: ChapterSetup,
  opts: {
    refKind: "event" | "project";
    scopeRefId: string;
    label?: string;
    year: number;
    month?: number;
  },
): Promise<Id<"budgets">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("budgets", {
      chapterId: s.chapterId,
      amountCents: 10000,
      label: opts.label,
      type: "one_time",
      refKind: opts.refKind,
      scopeRefId: opts.scopeRefId,
      cadence: "per_instance",
      year: opts.year,
      month: opts.month,
      createdAt: Date.now(),
    }),
  );
}

async function getBudget(s: ChapterSetup, budgetId: Id<"budgets">) {
  return await run(s.t, (ctx) => ctx.db.get(budgetId));
}

describe("0027_sync_linked_budget_identity", () => {
  test("re-derives a stale project budget's label/year/month from its live deadline", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = await seedProject(s, "Old Name", { deadline: tsOnDay(2026, 3, 1) });
    const budgetId = await seedLinkedBudget(s, {
      refKind: "project",
      scopeRefId: projectId,
      label: "Stale Label",
      year: 2025,
      month: 7,
    });
    // Rename the project AFTER the stale budget was seeded — simulates a
    // rename that predates the sync hooks.
    await run(s.t, (ctx) => ctx.db.patch(projectId, { name: "New Name" }));

    const result = await run(t, (ctx) => runSyncLinkedBudgetIdentity(ctx));
    expect(result).toMatchObject({ scanned: 1, linked: 1, synced: 1, unchanged: 0, refNotFound: 0 });

    const budget = await getBudget(s, budgetId);
    expect(budget?.label).toBe("New Name");
    expect(budget?.year).toBe(2026);
    expect(budget?.month).toBe(3);
  });

  test("re-derives a stale event budget's label/year/month from its live eventDate", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, { name: "Renamed Later", eventDate: tsOnDay(2026, 6, 7) });
    const budgetId = await seedLinkedBudget(s, {
      refKind: "event",
      scopeRefId: eventId,
      label: "Old Event Name",
      year: 2025,
      month: 1,
    });

    const result = await run(t, (ctx) => runSyncLinkedBudgetIdentity(ctx));
    expect(result).toMatchObject({ scanned: 1, linked: 1, synced: 1 });

    const budget = await getBudget(s, budgetId);
    expect(budget?.label).toBe("Renamed Later");
    expect(budget?.year).toBe(2026);
    expect(budget?.month).toBe(6);
  });

  test("skips (untouched) a budget whose ref no longer resolves", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const eventId = await seedEvent(s, { name: "Doomed Event", eventDate: tsOnDay(2026, 5, 1) });
    const budgetId = await seedLinkedBudget(s, {
      refKind: "event",
      scopeRefId: eventId,
      label: "Fallback Label",
      year: 2025,
      month: 1,
    });
    await run(s.t, (ctx) => ctx.db.delete(eventId));

    const result = await run(t, (ctx) => runSyncLinkedBudgetIdentity(ctx));
    expect(result).toMatchObject({ scanned: 1, linked: 1, synced: 0, unchanged: 0, refNotFound: 1 });

    const budget = await getBudget(s, budgetId);
    expect(budget?.label).toBe("Fallback Label");
    expect(budget?.year).toBe(2025);
    expect(budget?.month).toBe(1);
  });

  test("is idempotent — a second run patches nothing further", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = await seedProject(s, "Love Wins", { deadline: tsOnDay(2026, 3, 1) });
    await seedLinkedBudget(s, {
      refKind: "project",
      scopeRefId: projectId,
      label: "Stale",
      year: 2025,
      month: 1,
    });

    const first = await run(t, (ctx) => runSyncLinkedBudgetIdentity(ctx));
    expect(first.synced).toBe(1);

    const second = await run(t, (ctx) => runSyncLinkedBudgetIdentity(ctx));
    expect(second).toMatchObject({ scanned: 1, linked: 1, synced: 0, unchanged: 1, refNotFound: 0 });
  });

  test("review fix: leaves the approval fields byte-identical — the identity sync must never touch approval state", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const projectId = await seedProject(s, "Old Name", { deadline: tsOnDay(2026, 3, 1) });
    const approverPersonId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Approver",
        createdAt: Date.now(),
      }),
    );
    const approvedAt = Date.now() - 1000;
    const budgetId = await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 10000,
        label: "Stale Label",
        type: "one_time",
        refKind: "project",
        scopeRefId: projectId,
        cadence: "per_instance",
        year: 2025,
        month: 7,
        createdAt: Date.now(),
        approvalStatus: "approved",
        approvedCents: 10000,
        approvedByPersonId: approverPersonId,
        approvedAt,
        approvalParty: "two_party",
      }),
    );
    await run(s.t, (ctx) => ctx.db.patch(projectId, { name: "New Name" }));

    const result = await run(t, (ctx) => runSyncLinkedBudgetIdentity(ctx));
    expect(result).toMatchObject({ synced: 1 });

    const budget = await getBudget(s, budgetId);
    // The identity fields DID change (proves the sync actually ran)...
    expect(budget?.label).toBe("New Name");
    expect(budget?.year).toBe(2026);
    expect(budget?.month).toBe(3);
    // ...but every approval field is byte-identical to what was seeded.
    expect(budget?.approvalStatus).toBe("approved");
    expect(budget?.approvedCents).toBe(10000);
    expect(budget?.approvedByPersonId).toBe(approverPersonId);
    expect(budget?.approvedAt).toBe(approvedAt);
    expect(budget?.approvalParty).toBe("two_party");
  });

  test("skips recurring/unlinked budgets entirely — never touched", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const budgetId = await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 5000,
        label: "General Ops",
        type: "recurring",
        cadence: "monthly",
        year: 2026,
        month: 1,
        createdAt: Date.now(),
      }),
    );

    const result = await run(t, (ctx) => runSyncLinkedBudgetIdentity(ctx));
    expect(result).toMatchObject({ scanned: 1, linked: 0, synced: 0, unchanged: 0, refNotFound: 0 });

    const budget = await getBudget(s, budgetId);
    expect(budget?.label).toBe("General Ops");
  });
});
