/**
 * Event Types / Templates.
 *
 * The reusable blueprint for a kind of event: a roles set + active components,
 * with its task list (`templateTasks`) and run-of-show (`templateRunOfShow`).
 * `version` bumps on every structural edit; events clone the template at
 * creation so in-flight events are never disrupted by later edits.
 */
import { query, mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  requireUserId,
  requireChapterId,
  requireInChapter,
  getChapterIdOrNull,
} from "./lib/context";

/** Kebab-case slug from a display name. */
function toSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Max `order` over a list of rows (returns -1 when empty, so next = 0). */
function maxOrder(rows: Array<{ order: number }>): number {
  return rows.reduce((max, r) => (r.order > max ? r.order : max), -1);
}

/** Bump a template's version and touch updatedAt. */
async function bumpVersion(ctx: any, eventTypeId: Id<"eventTypes">) {
  const et = await ctx.db.get(eventTypeId);
  if (et) {
    await ctx.db.patch(eventTypeId, {
      version: (et.version ?? 1) + 1,
      updatedAt: Date.now(),
    });
  }
}

/** List the chapter's active event types with a task count, sorted by name. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const types = await ctx.db
      .query("eventTypes")
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", chapterId))
      .collect();
    const active = types.filter((t: any) => t.isArchived !== true);
    const withCounts = await Promise.all(
      active.map(async (t: any) => {
        const tasks = await ctx.db
          .query("templateTasks")
          .withIndex("by_eventType", (q: any) => q.eq("eventTypeId", t._id))
          .collect();
        return {
          _id: t._id,
          name: t.name,
          slug: t.slug,
          description: t.description,
          roles: t.roles,
          activeComponents: t.activeComponents,
          version: t.version,
          taskCount: tasks.length,
        };
      }),
    );
    return withCounts.sort((a, b) => a.name.localeCompare(b.name));
  },
});

/** Full template detail: the event type plus its ordered tasks + run-of-show. */
export const get = query({
  args: { eventTypeId: v.id("eventTypes") },
  handler: async (ctx, { eventTypeId }) => {
    const chapterId = await requireChapterId(ctx);
    const eventType = await ctx.db.get(eventTypeId);
    if (!eventType || eventType.chapterId !== chapterId) return null;
    const tasks = await ctx.db
      .query("templateTasks")
      .withIndex("by_eventType", (q: any) => q.eq("eventTypeId", eventTypeId))
      .collect();
    const runOfShow = await ctx.db
      .query("templateRunOfShow")
      .withIndex("by_eventType", (q: any) => q.eq("eventTypeId", eventTypeId))
      .collect();
    return {
      eventType,
      tasks: tasks.sort((a: any, b: any) => a.order - b.order),
      runOfShow: runOfShow.sort((a: any, b: any) => a.order - b.order),
    };
  },
});

/**
 * Create a new template. If `deriveFromEventTypeId` is given, copy that parent's
 * templateTasks + templateRunOfShow so a variant starts structurally aligned.
 */
export const create = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    roles: v.array(v.string()),
    activeComponents: v.array(v.string()),
    deriveFromEventTypeId: v.optional(v.id("eventTypes")),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    const userId = await requireUserId(ctx);
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: chapterId as Id<"chapters">,
      name: args.name,
      slug: toSlug(args.name),
      description: args.description,
      deriveFromEventTypeId: args.deriveFromEventTypeId,
      roles: args.roles,
      activeComponents: args.activeComponents,
      version: 1,
      isArchived: false,
      createdBy: userId as Id<"users">,
      createdAt: now,
      updatedAt: now,
    });

    if (args.deriveFromEventTypeId) {
      const parent = await ctx.db.get(args.deriveFromEventTypeId);
      await requireInChapter(ctx, chapterId, parent, "Event type");
      const parentTasks = await ctx.db
        .query("templateTasks")
        .withIndex("by_eventType", (q: any) =>
          q.eq("eventTypeId", args.deriveFromEventTypeId),
        )
        .collect();
      for (const t of parentTasks.sort((a: any, b: any) => a.order - b.order)) {
        await ctx.db.insert("templateTasks", {
          eventTypeId,
          title: t.title,
          tMinusOffsetDays: t.tMinusOffsetDays,
          owningRole: t.owningRole,
          order: t.order,
        });
      }
      const parentRows = await ctx.db
        .query("templateRunOfShow")
        .withIndex("by_eventType", (q: any) =>
          q.eq("eventTypeId", args.deriveFromEventTypeId),
        )
        .collect();
      for (const r of parentRows.sort((a: any, b: any) => a.order - b.order)) {
        await ctx.db.insert("templateRunOfShow", {
          eventTypeId,
          offsetMinutes: r.offsetMinutes,
          segment: r.segment,
          owningRole: r.owningRole,
          notes: r.notes,
          order: r.order,
        });
      }
    }

    return eventTypeId;
  },
});

/** Edit a template's metadata; bumps version. */
export const update = mutation({
  args: {
    eventTypeId: v.id("eventTypes"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    roles: v.optional(v.array(v.string())),
    activeComponents: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { eventTypeId, ...patch }) => {
    const chapterId = await requireChapterId(ctx);
    const et = await ctx.db.get(eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    const fields: Record<string, unknown> = {};
    if (patch.name !== undefined) {
      fields.name = patch.name;
      fields.slug = toSlug(patch.name);
    }
    if (patch.description !== undefined) fields.description = patch.description;
    if (patch.roles !== undefined) fields.roles = patch.roles;
    if (patch.activeComponents !== undefined)
      fields.activeComponents = patch.activeComponents;
    fields.version = (et!.version ?? 1) + 1;
    fields.updatedAt = Date.now();
    await ctx.db.patch(eventTypeId, fields);
    return eventTypeId;
  },
});

/** Archive a template (soft delete; hidden from `list`). */
export const archive = mutation({
  args: { eventTypeId: v.id("eventTypes") },
  handler: async (ctx, { eventTypeId }) => {
    const chapterId = await requireChapterId(ctx);
    const et = await ctx.db.get(eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    await ctx.db.patch(eventTypeId, { isArchived: true, updatedAt: Date.now() });
    return eventTypeId;
  },
});

/** Add a task to a template (appended to the end); bumps version. */
export const addTask = mutation({
  args: {
    eventTypeId: v.id("eventTypes"),
    title: v.string(),
    tMinusOffsetDays: v.number(),
    owningRole: v.string(),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    const et = await ctx.db.get(args.eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    const tasks = await ctx.db
      .query("templateTasks")
      .withIndex("by_eventType", (q: any) =>
        q.eq("eventTypeId", args.eventTypeId),
      )
      .collect();
    const templateTaskId = await ctx.db.insert("templateTasks", {
      eventTypeId: args.eventTypeId,
      title: args.title,
      tMinusOffsetDays: args.tMinusOffsetDays,
      owningRole: args.owningRole,
      order: maxOrder(tasks) + 1,
    });
    await bumpVersion(ctx, args.eventTypeId);
    return templateTaskId;
  },
});

/** Edit a template task; bumps the parent template's version. */
export const updateTask = mutation({
  args: {
    templateTaskId: v.id("templateTasks"),
    title: v.optional(v.string()),
    tMinusOffsetDays: v.optional(v.number()),
    owningRole: v.optional(v.string()),
  },
  handler: async (ctx, { templateTaskId, ...patch }) => {
    const chapterId = await requireChapterId(ctx);
    const task = await ctx.db.get(templateTaskId);
    if (!task) return templateTaskId;
    const et = await ctx.db.get(task.eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) fields[key] = value;
    }
    await ctx.db.patch(templateTaskId, fields);
    await bumpVersion(ctx, task.eventTypeId);
    return templateTaskId;
  },
});

/** Remove a template task; bumps the parent template's version. */
export const removeTask = mutation({
  args: { templateTaskId: v.id("templateTasks") },
  handler: async (ctx, { templateTaskId }) => {
    const chapterId = await requireChapterId(ctx);
    const task = await ctx.db.get(templateTaskId);
    if (!task) return templateTaskId;
    const et = await ctx.db.get(task.eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    await ctx.db.delete(templateTaskId);
    await bumpVersion(ctx, task.eventTypeId);
    return templateTaskId;
  },
});

/** Reorder a template's tasks to match the given id array. */
export const reorderTasks = mutation({
  args: {
    eventTypeId: v.id("eventTypes"),
    orderedIds: v.array(v.id("templateTasks")),
  },
  handler: async (ctx, { eventTypeId, orderedIds }) => {
    const chapterId = await requireChapterId(ctx);
    const et = await ctx.db.get(eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    for (let i = 0; i < orderedIds.length; i++) {
      const task = await ctx.db.get(orderedIds[i]);
      if (task && task.eventTypeId === eventTypeId) {
        await ctx.db.patch(orderedIds[i], { order: i });
      }
    }
    await bumpVersion(ctx, eventTypeId);
    return eventTypeId;
  },
});

/** Add a run-of-show row to a template (appended to the end). */
export const addRunOfShowRow = mutation({
  args: {
    eventTypeId: v.id("eventTypes"),
    offsetMinutes: v.number(),
    segment: v.string(),
    owningRole: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    const et = await ctx.db.get(args.eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    const rows = await ctx.db
      .query("templateRunOfShow")
      .withIndex("by_eventType", (q: any) =>
        q.eq("eventTypeId", args.eventTypeId),
      )
      .collect();
    return await ctx.db.insert("templateRunOfShow", {
      eventTypeId: args.eventTypeId,
      offsetMinutes: args.offsetMinutes,
      segment: args.segment,
      owningRole: args.owningRole,
      notes: args.notes,
      order: maxOrder(rows) + 1,
    });
  },
});

/** Remove a run-of-show row from a template. */
export const removeRunOfShowRow = mutation({
  args: { rowId: v.id("templateRunOfShow") },
  handler: async (ctx, { rowId }) => {
    const chapterId = await requireChapterId(ctx);
    const row = await ctx.db.get(rowId);
    if (!row) return rowId;
    const et = await ctx.db.get(row.eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    await ctx.db.delete(rowId);
    return rowId;
  },
});
