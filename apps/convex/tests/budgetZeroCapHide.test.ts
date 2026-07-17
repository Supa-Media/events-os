import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * WP-wave4 (item 9, owner addendum 2026-07-17) — "$0-summoned-budget
 * cleanup": a zero-cap, zero-spend REF-LINKED budget card ("$0.00 / $0.00")
 * is dashboard clutter (the legacy summon-on-pick flow's leftovers, item 5
 * retires the flow itself but existing prod rows survive until
 * `removeEmptyAutoBudgets` runs) — hidden as a belt-and-suspenders,
 * independent of that ops cleanup's own timing. A zero-cap budget WITH real
 * spend against it is the OPPOSITE signal (unfunded overspend) and must stay
 * loud, never hidden.
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

async function seedEvent(s: ChapterSetup, name: string): Promise<Id<"events">> {
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
      name,
      eventDate: Date.now(),
      status: "planning",
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

describe("dashboardChapter hides zero-cap, zero-spend ref-linked cards (WP-wave4 item 9)", () => {
  test("a $0-summoned event budget with no spend is hidden from the dashboard", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const year = 2026;
    const eventId = await seedEvent(s, "Task-shaped Event");
    const budgetId = await s.as.mutation(api.finances.summonBudgetForRef, {
      refKind: "event",
      scopeRefId: eventId,
    });

    const dash = await s.as.query(api.finances.dashboardChapter, { year, period: "ytd" });
    expect(dash.oneTimeBudgets.some((b) => b.id === budgetId)).toBe(false);
  });

  test("a $0-cap budget WITH real spend stays visible (loud unfunded-overspend signal, never hidden)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const year = 2026;
    const eventId = await seedEvent(s, "Overspent Event");
    const budgetId = await s.as.mutation(api.finances.summonBudgetForRef, {
      refKind: "event",
      scopeRefId: eventId,
    });
    await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 5000,
      postedAt: Date.now(),
      budgetId,
    });

    const dash = await s.as.query(api.finances.dashboardChapter, { year, period: "ytd" });
    const card = dash.oneTimeBudgets.find((b) => b.id === budgetId);
    expect(card).toBeDefined();
    expect(card?.pct).toBe(100); // unfunded-with-spend reads as loud 100%, never hidden
    expect(card?.status).toBe("warn");
  });

  test("a real (nonzero-amount) budget with no spend yet stays visible — the guard is zero-cap-AND-zero-spend, not zero-spend alone", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const year = 2026;
    const eventId = await seedEvent(s, "Freshly Planned Event");
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 50000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year,
      scopeRefId: eventId,
    });

    const dash = await s.as.query(api.finances.dashboardChapter, { year, period: "ytd" });
    expect(dash.oneTimeBudgets.some((b) => b.id === budgetId)).toBe(true);
  });
});
