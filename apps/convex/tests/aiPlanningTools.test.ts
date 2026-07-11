/**
 * Characterization tests for the planning-agent internal tools in ai.ts:
 *
 *   - readinessSummary  — the `get_readiness` snapshot's shape and contents
 *   - removeItem        — revertible delete: `__deleted` change + re-insert on Undo
 *   - assignRole        — one-person-per-role upsert semantics (+ unassign)
 *   - rescheduleEvent   — due-date re-derivation + past-due feasibility report
 *
 * These are internalQuery/internalMutations reachable from the assistant
 * action, so they follow the same tenant-boundary conventions the aiTenant
 * suite characterizes; here we cover their behavior.
 */
import { describe, expect, test } from "vitest";
import { internal, api } from "../_generated/api";
import {
  computeDueDate,
  DAY_MS,
  TASK_STATUS_OPTIONS,
} from "@events-os/shared";
import { newT, run, setupChapter, type TestConvex } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * Seed a planning-ready event in `chapterId`:
 *   - event T-10 out, owned by nobody
 *   - two roles (Event Lead assigned to Sarah, Comms Lead unassigned)
 *   - a planning_doc status column + three tasks:
 *       overdue (T-20, not done), due tomorrow (T-9), done (T-20)
 *   - two people (Sarah, and placeholder "Flower Team 1") + engagements
 */
async function seedPlanningEvent(
  t: TestConvex,
  chapterId: Id<"chapters">,
  userId: Id<"users">,
) {
  return await run(t, async (ctx) => {
    const now = Date.now();
    const eventDate = now + 10 * DAY_MS;
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId,
      name: "WWS",
      slug: "wws",
      version: 1,
      isArchived: false,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Park Worship",
      eventDate,
      status: "planning",
      moduleReadiness: [{ key: "comms", ready: true }],
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });

    const eventLeadId = await ctx.db.insert("eventRoles", {
      eventId,
      key: "event_lead",
      label: "Event Lead",
      order: 0,
    });
    const commsLeadId = await ctx.db.insert("eventRoles", {
      eventId,
      key: "comms_lead",
      label: "Comms Lead",
      order: 1,
    });

    const sarahId = await ctx.db.insert("people", {
      chapterId,
      name: "Sarah",
      createdAt: now,
    });
    const placeholderId = await ctx.db.insert("people", {
      chapterId,
      name: "Flower Team 1",
      isPlaceholder: true,
      createdAt: now,
    });
    await ctx.db.insert("roleAssignments", {
      eventId,
      chapterId,
      roleId: eventLeadId,
      personId: sarahId,
      createdAt: now,
    });

    // planning_doc status column so complete/incomplete detection works.
    await ctx.db.insert("eventColumns", {
      eventId,
      module: "planning_doc",
      key: "status",
      label: "Status",
      kind: "system",
      type: "status",
      options: TASK_STATUS_OPTIONS,
      isVisible: true,
      order: 0,
    });

    const overdueId = await ctx.db.insert("eventItems", {
      eventId,
      chapterId,
      module: "planning_doc",
      title: "Apply for park permit",
      order: 0,
      offsetDays: -20,
      dueDate: computeDueDate(eventDate, -20),
      status: "not_started",
      roleId: eventLeadId,
    });
    const dueSoonId = await ctx.db.insert("eventItems", {
      eventId,
      chapterId,
      module: "planning_doc",
      title: "Post volunteer call",
      order: 1,
      offsetDays: -9,
      dueDate: computeDueDate(eventDate, -9),
      status: "not_started",
      // No role, no owner → the owner chain dead-ends (unowned).
    });
    const doneId = await ctx.db.insert("eventItems", {
      eventId,
      chapterId,
      module: "planning_doc",
      title: "Confirm venue",
      order: 2,
      offsetDays: -20,
      dueDate: computeDueDate(eventDate, -20),
      status: "done",
      roleId: eventLeadId,
    });

    await ctx.db.insert("engagements", {
      chapterId,
      eventId,
      personId: sarahId,
      type: "volunteer",
      status: "confirmed",
      createdAt: now,
    });
    await ctx.db.insert("engagements", {
      chapterId,
      eventId,
      personId: placeholderId,
      type: "volunteer",
      status: "invited",
      createdAt: now,
    });

    const runId = await ctx.db.insert("aiRuns", {
      chapterId,
      userId,
      feature: "assistant",
      eventId,
      model: "test-model",
      status: "running",
      itemsTouched: 0,
      costUsd: 0,
      createdAt: now,
    });

    return {
      eventId,
      eventDate,
      eventLeadId,
      commsLeadId,
      sarahId,
      placeholderId,
      overdueId,
      dueSoonId,
      doneId,
      runId,
    };
  });
}

describe("ai.readinessSummary (get_readiness)", () => {
  test("summarizes phases, window, roles, items, and crew on a seeded event", async () => {
    const t = newT();
    const { chapterId, userId } = await setupChapter(t);
    const seeded = await seedPlanningEvent(t, chapterId, userId);

    const s = await t.query(internal.ai.readinessSummary, {
      eventId: seeded.eventId,
      chapterId,
    });
    expect(s).not.toBeNull();

    // Event + T-window: 10 days out → Build window (T-14→T-7).
    expect(s!.event.name).toBe("Park Worship");
    expect(s!.event.status).toBe("planning");
    expect(s!.daysToEvent).toBe(10);
    expect(s!.tWindow).toContain("T-10");
    expect(s!.tWindow).toContain("Build");

    // Phase scores are 0-100 (or null) for all four phases.
    expect(Object.keys(s!.phases).sort()).toEqual([
      "dayOf",
      "planning",
      "post",
      "prePlan",
    ]);
    // planning_doc: done=1 of 3 planning items → a real 0-100 number.
    expect(typeof s!.phases.planning).toBe("number");

    // Role + workstream-owner coverage.
    expect(s!.unassignedRoles).toEqual(["Comms Lead"]);
    // Only core defaults exist and no module owners resolve except those whose
    // owner role is assigned: event_lead is assigned, comms_lead isn't.
    expect(s!.workstreamsMissingOwner).toContain("Comms Schedule");
    expect(s!.workstreamsMissingOwner).not.toContain("Planning Doc");

    // moduleReadiness flags flow through.
    const comms = s!.workstreamReadiness.find((w) => w.key === "comms");
    expect(comms?.ready).toBe(true);
    const planning = s!.workstreamReadiness.find(
      (w) => w.key === "planning_doc",
    );
    expect(planning?.ready).toBe(false);

    // Items: the permit is overdue; the volunteer call is due in 3 days and
    // unowned (no owner, no role, planning_doc's owner role IS assigned — but
    // the row has neither owner nor role... it falls to the module owner, so
    // it is NOT unowned); the done task appears nowhere.
    expect(s!.items.overdue.count).toBe(1);
    expect(s!.items.overdue.titles[0]).toContain("Apply for park permit");
    expect(s!.items.dueInNext3Days.count).toBe(1);
    expect(s!.items.dueInNext3Days.titles[0]).toContain("Post volunteer call");
    // planning_doc's owner (event_lead → Sarah) catches the ownerless row.
    expect(s!.items.unowned.count).toBe(0);

    // Crew: statuses + the placeholder still engaged.
    expect(s!.crew.engagementStatus).toEqual({
      invited: 1,
      confirmed: 1,
      declined: 0,
    });
    expect(s!.crew.placeholdersStillEngaged).toEqual(["Flower Team 1"]);
  });

  test("flags unowned items when the whole owner chain dead-ends", async () => {
    const t = newT();
    const { chapterId, userId } = await setupChapter(t);
    const seeded = await seedPlanningEvent(t, chapterId, userId);
    // Unassign the event lead → planning_doc has no owner person → the
    // role-less "Post volunteer call" row now dead-ends.
    await run(t, async (ctx) => {
      const assignments = await ctx.db
        .query("roleAssignments")
        .withIndex("by_event", (q) => q.eq("eventId", seeded.eventId))
        .collect();
      for (const a of assignments) await ctx.db.delete(a._id);
    });

    const s = await t.query(internal.ai.readinessSummary, {
      eventId: seeded.eventId,
      chapterId,
    });
    expect(s!.items.unowned.count).toBeGreaterThanOrEqual(1);
    expect(
      s!.items.unowned.titles.some((title) =>
        title.includes("Post volunteer call"),
      ),
    ).toBe(true);
    expect(s!.unassignedRoles).toEqual(["Event Lead", "Comms Lead"]);
  });

  test("cross-chapter → returns null", async () => {
    const t = newT();
    const a = await setupChapter(t, { email: "ra@publicworship.life" });
    const b = await setupChapter(t, {
      email: "rb@publicworship.life",
      chapterName: "Other",
    });
    const seeded = await seedPlanningEvent(t, a.chapterId, a.userId);
    const s = await t.query(internal.ai.readinessSummary, {
      eventId: seeded.eventId,
      chapterId: b.chapterId,
    });
    expect(s).toBeNull();
  });
});

describe("ai.removeItem (remove_item) + revert", () => {
  test("deletes the row, logs a __deleted snapshot, and revert re-inserts it", async () => {
    const t = newT();
    const setup = await setupChapter(t);
    const { chapterId, userId, as } = setup;
    const seeded = await seedPlanningEvent(t, chapterId, userId);

    await t.mutation(internal.ai.removeItem, {
      runId: seeded.runId,
      itemId: seeded.overdueId,
      chapterId,
    });

    // Row is gone; the change log holds the full snapshot under __deleted.
    expect(await run(t, (ctx) => ctx.db.get(seeded.overdueId))).toBeNull();
    const changes = await run(t, (ctx) =>
      ctx.db
        .query("aiChanges")
        .withIndex("by_run", (q) => q.eq("runId", seeded.runId))
        .collect(),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].key).toBe("__deleted");
    expect(changes[0].before.title).toBe("Apply for park permit");
    expect(changes[0].before._id).toBeUndefined();

    // Revert the run → the item is re-inserted with its old fields.
    const result = await as.mutation(api.ai.revertAiRun, {
      runId: seeded.runId,
    });
    expect(result.reverted).toBe(1);
    expect(result.skipped).toBe(0);

    const items = await run(t, (ctx) =>
      ctx.db
        .query("eventItems")
        .withIndex("by_event_module", (q) =>
          q.eq("eventId", seeded.eventId).eq("module", "planning_doc"),
        )
        .collect(),
    );
    const restored = items.find((it) => it.title === "Apply for park permit");
    expect(restored).toBeDefined();
    expect(restored!.status).toBe("not_started");
    expect(restored!.offsetDays).toBe(-20);
    expect(restored!.dueDate).toBe(computeDueDate(seeded.eventDate, -20));
    expect(String(restored!.roleId)).toBe(String(seeded.eventLeadId));

    // The change is marked reverted, so a second revert is a no-op.
    const after = await run(t, (ctx) =>
      ctx.db
        .query("aiChanges")
        .withIndex("by_run", (q) => q.eq("runId", seeded.runId))
        .collect(),
    );
    expect(after[0].revertedAt).toBeDefined();
  });
});

describe("ai.assignRole / unassignRole (assign_role)", () => {
  test("upserts one person per role, replacing any current holder", async () => {
    const t = newT();
    const { chapterId, userId } = await setupChapter(t);
    const seeded = await seedPlanningEvent(t, chapterId, userId);
    const miriamId = await run(t, (ctx) =>
      ctx.db.insert("people", {
        chapterId,
        name: "Miriam",
        createdAt: Date.now(),
      }),
    );

    // Comms Lead is unassigned → assign Sarah, then replace with Miriam.
    await t.mutation(internal.ai.assignRole, {
      eventId: seeded.eventId,
      chapterId,
      roleId: seeded.commsLeadId,
      personId: seeded.sarahId,
    });
    await t.mutation(internal.ai.assignRole, {
      eventId: seeded.eventId,
      chapterId,
      roleId: seeded.commsLeadId,
      personId: miriamId,
    });

    const rows = await run(t, (ctx) =>
      ctx.db
        .query("roleAssignments")
        .withIndex("by_event_role", (q) =>
          q.eq("eventId", seeded.eventId).eq("roleId", seeded.commsLeadId),
        )
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(String(rows[0].personId)).toBe(String(miriamId));

    // Unassign clears the role entirely.
    await t.mutation(internal.ai.unassignRole, {
      eventId: seeded.eventId,
      chapterId,
      roleId: seeded.commsLeadId,
    });
    const cleared = await run(t, (ctx) =>
      ctx.db
        .query("roleAssignments")
        .withIndex("by_event_role", (q) =>
          q.eq("eventId", seeded.eventId).eq("roleId", seeded.commsLeadId),
        )
        .collect(),
    );
    expect(cleared).toHaveLength(0);
  });

  test("rejects a role from a different event", async () => {
    const t = newT();
    const { chapterId, userId } = await setupChapter(t);
    const a = await seedPlanningEvent(t, chapterId, userId);
    const b = await seedPlanningEvent(t, chapterId, userId);
    // b's role on a's event → refused (returns null, writes nothing).
    const res = await t.mutation(internal.ai.assignRole, {
      eventId: a.eventId,
      chapterId,
      roleId: b.commsLeadId,
      personId: a.sarahId,
    });
    expect(res).toBeNull();
    const rows = await run(t, (ctx) =>
      ctx.db
        .query("roleAssignments")
        .withIndex("by_event_role", (q) =>
          q.eq("eventId", a.eventId).eq("roleId", b.commsLeadId),
        )
        .collect(),
    );
    expect(rows).toHaveLength(0);
  });
});

describe("ai.rescheduleEvent (reschedule_event)", () => {
  test("re-derives day-offset due dates and reports past-due feasibility", async () => {
    const t = newT();
    const { chapterId, userId } = await setupChapter(t);
    const seeded = await seedPlanningEvent(t, chapterId, userId);

    // Pull the event in to 5 days out: the T-20 permit stays overdue, and the
    // T-9 volunteer call (due tomorrow before) now lands in the past too. The
    // DONE T-20 task also lands in the past but is complete → not reported.
    const newDate = Date.now() + 5 * DAY_MS;
    const res = await t.mutation(internal.ai.rescheduleEvent, {
      eventId: seeded.eventId,
      chapterId,
      eventDate: newDate,
    });
    expect(res).not.toBeNull();
    expect(res!.shifted).toBe(3);
    expect(res!.pastDueCount).toBe(2);
    expect(res!.pastDueTitles).toContain("Apply for park permit");
    expect(res!.pastDueTitles).toContain("Post volunteer call");
    expect(res!.pastDueTitles).not.toContain("Confirm venue");

    const event = await run(t, (ctx) => ctx.db.get(seeded.eventId));
    expect(event!.eventDate).toBe(newDate);
    const items = await run(t, (ctx) =>
      ctx.db
        .query("eventItems")
        .withIndex("by_event", (q) => q.eq("eventId", seeded.eventId))
        .collect(),
    );
    for (const it of items) {
      expect(it.dueDate).toBe(computeDueDate(newDate, it.offsetDays!));
    }
  });
});
