import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { newT, run, setupChapter } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * "What's next" reporting-chain oversight (`api.events.todos`).
 *
 * A manager viewing an event OWNED by someone in their reporting chain (a direct
 * report, or a report's report, transitively) should see that event's at-risk
 * items in the Overseeing group — even when the manager holds no role on the
 * event. This lets them catch what a report is letting slip. Chapter admins get
 * the same oversight over every event. Peers / people outside the subtree do not.
 */

const STATUS_OPTIONS = [
  { value: "todo", label: "To do", isComplete: false },
  { value: "done", label: "Done", isComplete: true },
];

/** Drop the caller from chapter-admin to a plain member so oversight is driven
 *  purely by the manager tree (not the admin "sees everything" override). */
async function demoteToMember(
  t: ReturnType<typeof newT>,
  userId: Id<"users">,
  chapterId: Id<"chapters">,
) {
  await run(t, async (ctx) => {
    const membership = await ctx.db
      .query("userChapters")
      .withIndex("by_userId_chapterId", (q) =>
        q.eq("userId", userId).eq("chapterId", chapterId),
      )
      .first();
    if (membership) await ctx.db.patch(membership._id, { role: "member" });
  });
}

/** Insert a person; when `userId` is given the row is claimed by that account. */
function makePerson(
  t: ReturnType<typeof newT>,
  fields: {
    chapterId: Id<"chapters">;
    name: string;
    userId?: Id<"users">;
    managerId?: Id<"people">;
  },
): Promise<Id<"people">> {
  return run(t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: fields.chapterId,
      name: fields.name,
      userId: fields.userId,
      managerId: fields.managerId,
      isTeamMember: true,
      isActive: true,
      createdAt: Date.now(),
    }),
  );
}

/**
 * Seed an event owned by `ownerPersonId` with a single OVERDUE, incomplete
 * planning_doc item (the event date is 2 days in the past, and the undated item
 * inherits it as its effective due). The item carries no owner/role, so it only
 * ever surfaces through event-level oversight.
 */
async function seedOverdueEvent(
  t: ReturnType<typeof newT>,
  chapterId: Id<"chapters">,
  userId: Id<"users">,
  ownerPersonId: Id<"people">,
  itemTitle: string,
) {
  return await run(t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId,
      name: "T",
      slug: "t",
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
      name: "Owned Event",
      eventDate: now - 2 * 24 * 3600 * 1000,
      status: "planning",
      ownerPersonId,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("eventColumns", {
      eventId,
      module: "planning_doc",
      key: "status",
      label: "Status",
      kind: "system",
      type: "status",
      options: STATUS_OPTIONS,
      isVisible: true,
      order: 0,
    });
    await ctx.db.insert("eventItems", {
      eventId,
      chapterId,
      module: "planning_doc",
      title: itemTitle,
      order: 0,
      status: "todo",
    });
    return { eventId };
  });
}

describe("events.todos — reporting-chain oversight", () => {
  test("manager sees a direct report's overdue event item in Overseeing", async () => {
    const t = newT();
    const { as, chapterId, userId } = await setupChapter(t);
    await demoteToMember(t, userId, chapterId);

    const managerId = await makePerson(t, {
      chapterId,
      name: "Manager",
      userId,
    });
    const reportId = await makePerson(t, {
      chapterId,
      name: "Report",
      managerId,
    });
    const { eventId } = await seedOverdueEvent(
      t,
      chapterId,
      userId,
      reportId,
      "Report task",
    );

    const todos = await as.query(api.events.todos, { eventId });
    // Not the manager's own work — nothing in Yours.
    expect(todos.yours).toEqual([]);
    const labels = todos.overseeing.map((a) => a.label);
    expect(labels).toContain("Planning Doc: Report task");
    expect(
      todos.overseeing.every((a) => a.risk === "overdue"),
    ).toBe(true);
  });

  test("oversight is transitive — a report's report also surfaces", async () => {
    const t = newT();
    const { as, chapterId, userId } = await setupChapter(t);
    await demoteToMember(t, userId, chapterId);

    const managerId = await makePerson(t, {
      chapterId,
      name: "Manager",
      userId,
    });
    const reportId = await makePerson(t, {
      chapterId,
      name: "Report",
      managerId,
    });
    const subReportId = await makePerson(t, {
      chapterId,
      name: "Sub Report",
      managerId: reportId,
    });
    const { eventId } = await seedOverdueEvent(
      t,
      chapterId,
      userId,
      subReportId,
      "Sub task",
    );

    const todos = await as.query(api.events.todos, { eventId });
    expect(todos.overseeing.map((a) => a.label)).toContain(
      "Planning Doc: Sub task",
    );
  });

  test("events owned OUTSIDE the reporting chain do not surface", async () => {
    const t = newT();
    const { as, chapterId, userId } = await setupChapter(t);
    await demoteToMember(t, userId, chapterId);

    // The viewer is a plain member/manager with no reports over the owner.
    await makePerson(t, { chapterId, name: "Manager", userId });
    const outsiderId = await makePerson(t, { chapterId, name: "Outsider" });
    const { eventId } = await seedOverdueEvent(
      t,
      chapterId,
      userId,
      outsiderId,
      "Outsider task",
    );

    const todos = await as.query(api.events.todos, { eventId });
    expect(todos.yours).toEqual([]);
    expect(todos.overseeing).toEqual([]);
  });

  test("chapter admins oversee every owned event", async () => {
    const t = newT();
    // Default setupChapter membership role is "admin" — no demotion here.
    const { as, chapterId, userId } = await setupChapter(t);

    await makePerson(t, { chapterId, name: "Admin", userId });
    const strangerId = await makePerson(t, { chapterId, name: "Stranger" });
    const { eventId } = await seedOverdueEvent(
      t,
      chapterId,
      userId,
      strangerId,
      "Stranger task",
    );

    const todos = await as.query(api.events.todos, { eventId });
    expect(todos.overseeing.map((a) => a.label)).toContain(
      "Planning Doc: Stranger task",
    );
  });
});
