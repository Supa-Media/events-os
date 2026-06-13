/**
 * Events — dated instances of an event type.
 *
 * The core object the app revolves around. Created from a template, with its
 * tasks/run-of-show cloned as snapshots. Moving the event date re-derives every
 * task's due date (the whole timeline shifts).
 */
import { query, mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { computeDueDate, computeReadiness } from "@events-os/shared";
import { requireUserId, requireChapterId, requireInChapter } from "./lib/context";

const statusUnion = v.union(
  v.literal("planning"),
  v.literal("ready"),
  v.literal("completed"),
  v.literal("cancelled"),
);

/** Roll up a list of tasks into { total, done, readiness }. */
function rollup(tasks: Array<{ status: string }>) {
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "done").length;
  return { total, done, readiness: computeReadiness(total, done) };
}

/**
 * THE TEMPLATING ENGINE. Snapshot a template into a live event: clone its tasks
 * (with back-calculated due dates) and run-of-show rows.
 */
export const createFromTemplate = mutation({
  args: {
    eventTypeId: v.id("eventTypes"),
    name: v.string(),
    eventDate: v.number(),
    location: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    const userId = await requireUserId(ctx);
    const eventType = await ctx.db.get(args.eventTypeId);
    await requireInChapter(ctx, chapterId, eventType, "Event type");
    const now = Date.now();

    const eventId = await ctx.db.insert("events", {
      chapterId: chapterId as Id<"chapters">,
      eventTypeId: args.eventTypeId,
      templateVersion: eventType!.version,
      name: args.name,
      eventDate: args.eventDate,
      location: args.location,
      status: "planning",
      createdBy: userId as Id<"users">,
      createdAt: now,
      updatedAt: now,
    });

    const templateTasks = await ctx.db
      .query("templateTasks")
      .withIndex("by_eventType", (q: any) =>
        q.eq("eventTypeId", args.eventTypeId),
      )
      .collect();
    for (const t of templateTasks) {
      await ctx.db.insert("tasks", {
        eventId,
        chapterId: chapterId as Id<"chapters">,
        title: t.title,
        tMinusOffsetDays: t.tMinusOffsetDays,
        dueDate: computeDueDate(args.eventDate, t.tMinusOffsetDays),
        owningRole: t.owningRole,
        status: "not_started",
        order: t.order,
        createdAt: now,
      });
    }

    const templateRows = await ctx.db
      .query("templateRunOfShow")
      .withIndex("by_eventType", (q: any) =>
        q.eq("eventTypeId", args.eventTypeId),
      )
      .collect();
    for (const r of templateRows) {
      await ctx.db.insert("eventRunOfShow", {
        eventId,
        offsetMinutes: r.offsetMinutes,
        segment: r.segment,
        owningRole: r.owningRole,
        notes: r.notes,
        order: r.order,
      });
    }

    return eventId;
  },
});

/** List chapter events (default upcoming) with readiness + task counts. */
export const list = query({
  args: {
    scope: v.optional(v.union(v.literal("upcoming"), v.literal("all"))),
  },
  handler: async (ctx, { scope }) => {
    const chapterId = await requireChapterId(ctx);
    const now = Date.now();
    const all = await ctx.db
      .query("events")
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", chapterId))
      .collect();
    const filtered =
      scope === "all"
        ? all
        : all.filter(
            (e: any) => e.eventDate >= now && e.status !== "cancelled",
          );

    const enriched = await Promise.all(
      filtered.map(async (event: any) => {
        const eventType = await ctx.db.get(event.eventTypeId as Id<"eventTypes">);
        const tasks = await ctx.db
          .query("tasks")
          .withIndex("by_event", (q: any) => q.eq("eventId", event._id))
          .collect();
        const r = rollup(tasks);
        return {
          ...event,
          eventTypeName: eventType?.name ?? "Unknown",
          readiness: r.readiness,
          taskTotal: r.total,
          taskDone: r.done,
        };
      }),
    );
    return enriched.sort((a, b) => a.eventDate - b.eventDate);
  },
});

/** Fetch a single event plus its event-type name. */
export const get = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    if (!event || event.chapterId !== chapterId) return null;
    const eventType = await ctx.db.get(event.eventTypeId as Id<"eventTypes">);
    return { event, eventTypeName: eventType?.name ?? "Unknown" };
  },
});

/**
 * Move an event's date and re-derive every task's due date from the new date.
 */
export const reschedule = mutation({
  args: { eventId: v.id("events"), eventDate: v.number() },
  handler: async (ctx, { eventId, eventDate }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    await ctx.db.patch(eventId, { eventDate, updatedAt: Date.now() });
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    for (const t of tasks) {
      await ctx.db.patch(t._id, {
        dueDate: computeDueDate(eventDate, t.tMinusOffsetDays),
      });
    }
    return eventId;
  },
});

/** Set an event's lifecycle status. */
export const setStatus = mutation({
  args: { eventId: v.id("events"), status: statusUnion },
  handler: async (ctx, { eventId, status }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    await ctx.db.patch(eventId, { status, updatedAt: Date.now() });
    return eventId;
  },
});

/** Delete an event and all its tasks, run-of-show rows, and role assignments. */
export const remove = mutation({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    await requireInChapter(ctx, chapterId, event, "Event");

    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    for (const t of tasks) await ctx.db.delete(t._id);

    const rows = await ctx.db
      .query("eventRunOfShow")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);

    const assignments = await ctx.db
      .query("roleAssignments")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    for (const a of assignments) await ctx.db.delete(a._id);

    await ctx.db.delete(eventId);
    return eventId;
  },
});

/** Upcoming events with readiness + blocker count, for the pipeline dashboard. */
export const pipeline = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await requireChapterId(ctx);
    const now = Date.now();
    const all = await ctx.db
      .query("events")
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", chapterId))
      .collect();
    const upcoming = all.filter(
      (e: any) => e.eventDate >= now && e.status !== "cancelled",
    );

    const enriched = await Promise.all(
      upcoming.map(async (event: any) => {
        const eventType = await ctx.db.get(event.eventTypeId as Id<"eventTypes">);
        const tasks = await ctx.db
          .query("tasks")
          .withIndex("by_event", (q: any) => q.eq("eventId", event._id))
          .collect();
        const r = rollup(tasks);
        const blockerCount = tasks.filter(
          (t: any) => t.status !== "done" && t.dueDate < now,
        ).length;
        return {
          ...event,
          eventTypeName: eventType?.name ?? "Unknown",
          readiness: r.readiness,
          taskTotal: r.total,
          taskDone: r.done,
          blockerCount,
        };
      }),
    );
    return enriched.sort((a, b) => a.eventDate - b.eventDate);
  },
});

/** Mobile day-of view: event, run-of-show, role holders, and tasks. */
export const dayOf = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    if (!event || event.chapterId !== chapterId) return null;
    const eventType = await ctx.db.get(event.eventTypeId as Id<"eventTypes">);

    const runOfShow = await ctx.db
      .query("eventRunOfShow")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();

    const eventTypeRoles: string[] = eventType?.roles ?? [];
    const assignments = await ctx.db
      .query("roleAssignments")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    const roles = await Promise.all(
      eventTypeRoles.map(async (role) => {
        const assignment = assignments.find((a: any) => a.role === role);
        const person = assignment ? await ctx.db.get(assignment.personId) : null;
        return { role, person };
      }),
    );

    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();

    return {
      event,
      eventTypeName: eventType?.name ?? "Unknown",
      runOfShow: runOfShow.sort((a: any, b: any) => a.order - b.order),
      roles,
      tasks: tasks.sort((a: any, b: any) => a.dueDate - b.dueDate),
    };
  },
});
