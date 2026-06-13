/**
 * Tasks on a specific event.
 *
 * Auto-scheduled off the single event date (`dueDate = eventDate -
 * tMinusOffsetDays`). Rolls up into per-event readiness.
 */
import { query, mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { computeDueDate, computeReadiness } from "@events-os/shared";
import { requireChapterId, requireInChapter } from "./lib/context";

const taskStatusUnion = v.union(
  v.literal("not_started"),
  v.literal("in_progress"),
  v.literal("done"),
);

/** Max `order` over a list of rows (returns -1 when empty, so next = 0). */
function maxOrder(rows: Array<{ order: number }>): number {
  return rows.reduce((max, r) => (r.order > max ? r.order : max), -1);
}

/** List an event's tasks (sorted by due date) with assignees + a summary. */
export const listForEvent = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    await requireInChapter(ctx, chapterId, event, "Event");

    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();

    const withAssignees = await Promise.all(
      tasks
        .sort((a: any, b: any) => a.dueDate - b.dueDate)
        .map(async (t: any) => {
          let assignee: { _id: Id<"people">; name: string } | null = null;
          if (t.assigneePersonId) {
            const person = await ctx.db.get(t.assigneePersonId);
            if (person) assignee = { _id: person._id, name: person.name };
          }
          return { ...t, assignee };
        }),
    );

    const total = tasks.length;
    const done = tasks.filter((t: any) => t.status === "done").length;
    return {
      tasks: withAssignees,
      summary: { total, done, readiness: computeReadiness(total, done) },
    };
  },
});

/** Set a task's status. */
export const setStatus = mutation({
  args: { taskId: v.id("tasks"), status: taskStatusUnion },
  handler: async (ctx, { taskId, status }) => {
    const chapterId = await requireChapterId(ctx);
    const task = await ctx.db.get(taskId);
    await requireInChapter(ctx, chapterId, task, "Task");
    await ctx.db.patch(taskId, { status });
    return taskId;
  },
});

/** Assign or clear a task's assignee. */
export const assign = mutation({
  args: { taskId: v.id("tasks"), personId: v.optional(v.id("people")) },
  handler: async (ctx, { taskId, personId }) => {
    const chapterId = await requireChapterId(ctx);
    const task = await ctx.db.get(taskId);
    await requireInChapter(ctx, chapterId, task, "Task");
    if (personId) {
      const person = await ctx.db.get(personId);
      await requireInChapter(ctx, chapterId, person, "Person");
    }
    await ctx.db.patch(taskId, { assigneePersonId: personId ?? undefined });
    return taskId;
  },
});

/** Add an ad-hoc task to a live event; due date derived from the event date. */
export const add = mutation({
  args: {
    eventId: v.id("events"),
    title: v.string(),
    tMinusOffsetDays: v.number(),
    owningRole: v.string(),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(args.eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_event", (q: any) => q.eq("eventId", args.eventId))
      .collect();
    return await ctx.db.insert("tasks", {
      eventId: args.eventId,
      chapterId: chapterId as Id<"chapters">,
      title: args.title,
      tMinusOffsetDays: args.tMinusOffsetDays,
      dueDate: computeDueDate(event!.eventDate, args.tMinusOffsetDays),
      owningRole: args.owningRole,
      status: "not_started",
      order: maxOrder(tasks) + 1,
      createdAt: Date.now(),
    });
  },
});

/** Remove a task from an event. */
export const remove = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const chapterId = await requireChapterId(ctx);
    const task = await ctx.db.get(taskId);
    await requireInChapter(ctx, chapterId, task, "Task");
    await ctx.db.delete(taskId);
    return taskId;
  },
});
