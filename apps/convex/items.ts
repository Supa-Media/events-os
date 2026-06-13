/**
 * Items — the unified rows behind every planning module (planning doc, supplies,
 * comms, run-of-show), on both templates and live events.
 *
 * The few fields the backend reasons about are promoted columns on each item
 * (title, offset, status, role, owner); everything else lives in the `fields`
 * bag keyed by custom-column key. Day-offset modules (planning_doc, comms) carry
 * a signed `offsetDays` and a back-calculated `dueDate`; run-of-show carries
 * `offsetMinutes`. Editing the event date re-derives every due date (see
 * events.reschedule).
 */
import { query, mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  computeDueDate,
  computeReadiness,
  isCompleteStatus,
  DAY_OFFSET_MODULES,
  type ModuleKey,
} from "@events-os/shared";
import { requireChapterId, requireInChapter } from "./lib/context";
import { bumpVersion, maxOrder } from "./lib/templates";

const fieldsValidator = v.optional(v.record(v.string(), v.any()));

function isDayOffsetModule(module: string): boolean {
  return DAY_OFFSET_MODULES.includes(module as ModuleKey);
}

/** Merge a `fields` patch into existing fields (so single-cell edits don't wipe). */
function mergeFields(
  existing: Record<string, any> | undefined,
  patch: Record<string, any> | undefined,
): Record<string, any> | undefined {
  if (patch === undefined) return existing;
  const merged = { ...(existing ?? {}) };
  for (const [k, val] of Object.entries(patch)) {
    if (val === null) delete merged[k];
    else merged[k] = val;
  }
  return merged;
}

/** The status column's options for a module's column set, if any. */
function statusOptions(columns: Array<any>): Array<any> | undefined {
  return columns.find((c) => c.key === "status" && c.type === "status")
    ?.options;
}

// ── Template items ────────────────────────────────────────────────────────────
/** A template module: its ordered columns + items. */
export const listForTemplate = query({
  args: { eventTypeId: v.id("eventTypes"), module: v.string() },
  handler: async (ctx, { eventTypeId, module }) => {
    const chapterId = await requireChapterId(ctx);
    const et = await ctx.db.get(eventTypeId);
    if (!et || et.chapterId !== chapterId)
      return { columns: [], items: [] };
    const columns = (
      await ctx.db
        .query("templateColumns")
        .withIndex("by_eventType_module", (q: any) =>
          q.eq("eventTypeId", eventTypeId).eq("module", module),
        )
        .collect()
    ).sort((a: any, b: any) => a.order - b.order);
    const items = (
      await ctx.db
        .query("templateItems")
        .withIndex("by_eventType_module", (q: any) =>
          q.eq("eventTypeId", eventTypeId).eq("module", module),
        )
        .collect()
    ).sort((a: any, b: any) => a.order - b.order);
    return { columns, items };
  },
});

export const addTemplateItem = mutation({
  args: {
    eventTypeId: v.id("eventTypes"),
    module: v.string(),
    title: v.optional(v.string()),
    offsetDays: v.optional(v.number()),
    offsetMinutes: v.optional(v.number()),
    roleId: v.optional(v.id("roles")),
    status: v.optional(v.string()),
    fields: fieldsValidator,
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    const et = await ctx.db.get(args.eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    const items = await ctx.db
      .query("templateItems")
      .withIndex("by_eventType_module", (q: any) =>
        q.eq("eventTypeId", args.eventTypeId).eq("module", args.module),
      )
      .collect();
    const id = await ctx.db.insert("templateItems", {
      eventTypeId: args.eventTypeId,
      module: args.module,
      title: args.title ?? "",
      order: maxOrder(items) + 1,
      offsetDays: args.offsetDays,
      offsetMinutes: args.offsetMinutes,
      roleId: args.roleId,
      status: args.status,
      fields: args.fields,
    });
    await bumpVersion(ctx, args.eventTypeId);
    return id;
  },
});

export const updateTemplateItem = mutation({
  args: {
    itemId: v.id("templateItems"),
    title: v.optional(v.string()),
    offsetDays: v.optional(v.number()),
    offsetMinutes: v.optional(v.number()),
    roleId: v.optional(v.union(v.id("roles"), v.null())),
    status: v.optional(v.union(v.string(), v.null())),
    fields: fieldsValidator,
  },
  handler: async (ctx, { itemId, ...patch }) => {
    const chapterId = await requireChapterId(ctx);
    const item = await ctx.db.get(itemId);
    if (!item) return itemId;
    const et = await ctx.db.get(item.eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    const fields: Record<string, unknown> = {};
    if (patch.title !== undefined) fields.title = patch.title;
    if (patch.offsetDays !== undefined) fields.offsetDays = patch.offsetDays;
    if (patch.offsetMinutes !== undefined)
      fields.offsetMinutes = patch.offsetMinutes;
    if (patch.roleId !== undefined) fields.roleId = patch.roleId ?? undefined;
    if (patch.status !== undefined) fields.status = patch.status ?? undefined;
    if (patch.fields !== undefined)
      fields.fields = mergeFields(item.fields, patch.fields);
    await ctx.db.patch(itemId, fields);
    await bumpVersion(ctx, item.eventTypeId);
    return itemId;
  },
});

export const removeTemplateItem = mutation({
  args: { itemId: v.id("templateItems") },
  handler: async (ctx, { itemId }) => {
    const chapterId = await requireChapterId(ctx);
    const item = await ctx.db.get(itemId);
    if (!item) return itemId;
    const et = await ctx.db.get(item.eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    await ctx.db.delete(itemId);
    await bumpVersion(ctx, item.eventTypeId);
    return itemId;
  },
});

export const reorderTemplateItems = mutation({
  args: {
    eventTypeId: v.id("eventTypes"),
    module: v.string(),
    orderedIds: v.array(v.id("templateItems")),
  },
  handler: async (ctx, { eventTypeId, module, orderedIds }) => {
    const chapterId = await requireChapterId(ctx);
    const et = await ctx.db.get(eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    for (let i = 0; i < orderedIds.length; i++) {
      const item = await ctx.db.get(orderedIds[i]);
      if (item && item.eventTypeId === eventTypeId && item.module === module) {
        await ctx.db.patch(orderedIds[i], { order: i });
      }
    }
    await bumpVersion(ctx, eventTypeId);
    return eventTypeId;
  },
});

// ── Event items ───────────────────────────────────────────────────────────────
/** An event module: its cloned columns + items (with role/owner names) + readiness. */
export const listForEventModule = query({
  args: { eventId: v.id("events"), module: v.string() },
  handler: async (ctx, { eventId, module }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    if (!event || event.chapterId !== chapterId)
      return { columns: [], items: [], summary: { total: 0, complete: 0, readiness: 0 } };

    const columns = (
      await ctx.db
        .query("eventColumns")
        .withIndex("by_event_module", (q: any) =>
          q.eq("eventId", eventId).eq("module", module),
        )
        .collect()
    ).sort((a: any, b: any) => a.order - b.order);

    const rawItems = (
      await ctx.db
        .query("eventItems")
        .withIndex("by_event_module", (q: any) =>
          q.eq("eventId", eventId).eq("module", module),
        )
        .collect()
    ).sort((a: any, b: any) => a.order - b.order);

    const items = await Promise.all(
      rawItems.map(async (it: any) => {
        let roleLabel: string | null = null;
        if (it.roleId) {
          const role = await ctx.db.get(it.roleId as Id<"roles">);
          roleLabel = role?.label ?? null;
        }
        let owner: { _id: Id<"people">; name: string } | null = null;
        if (it.ownerPersonId) {
          const person = await ctx.db.get(it.ownerPersonId as Id<"people">);
          if (person) owner = { _id: person._id, name: person.name };
        }
        return { ...it, roleLabel, owner };
      }),
    );

    const opts = statusOptions(columns);
    const total = rawItems.length;
    const complete = opts
      ? rawItems.filter((it: any) => isCompleteStatus(opts, it.status)).length
      : 0;

    return {
      columns,
      items,
      summary: { total, complete, readiness: computeReadiness(total, complete) },
    };
  },
});

export const addEventItem = mutation({
  args: {
    eventId: v.id("events"),
    module: v.string(),
    title: v.optional(v.string()),
    offsetDays: v.optional(v.number()),
    offsetMinutes: v.optional(v.number()),
    roleId: v.optional(v.id("roles")),
    ownerPersonId: v.optional(v.id("people")),
    status: v.optional(v.string()),
    fields: fieldsValidator,
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(args.eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    const items = await ctx.db
      .query("eventItems")
      .withIndex("by_event_module", (q: any) =>
        q.eq("eventId", args.eventId).eq("module", args.module),
      )
      .collect();
    const dueDate =
      isDayOffsetModule(args.module) && args.offsetDays !== undefined
        ? computeDueDate(event!.eventDate, args.offsetDays)
        : undefined;
    return await ctx.db.insert("eventItems", {
      eventId: args.eventId,
      chapterId: chapterId as Id<"chapters">,
      module: args.module,
      title: args.title ?? "",
      order: maxOrder(items) + 1,
      offsetDays: args.offsetDays,
      offsetMinutes: args.offsetMinutes,
      dueDate,
      roleId: args.roleId,
      ownerPersonId: args.ownerPersonId,
      status: args.status,
      fields: args.fields,
    });
  },
});

export const updateEventItem = mutation({
  args: {
    itemId: v.id("eventItems"),
    title: v.optional(v.string()),
    offsetDays: v.optional(v.number()),
    offsetMinutes: v.optional(v.number()),
    roleId: v.optional(v.union(v.id("roles"), v.null())),
    ownerPersonId: v.optional(v.union(v.id("people"), v.null())),
    status: v.optional(v.union(v.string(), v.null())),
    fields: fieldsValidator,
  },
  handler: async (ctx, { itemId, ...patch }) => {
    const chapterId = await requireChapterId(ctx);
    const item = await ctx.db.get(itemId);
    if (!item) return itemId;
    const event = await ctx.db.get(item.eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    const fields: Record<string, unknown> = {};
    if (patch.title !== undefined) fields.title = patch.title;
    if (patch.offsetMinutes !== undefined)
      fields.offsetMinutes = patch.offsetMinutes;
    if (patch.roleId !== undefined) fields.roleId = patch.roleId ?? undefined;
    if (patch.ownerPersonId !== undefined)
      fields.ownerPersonId = patch.ownerPersonId ?? undefined;
    if (patch.status !== undefined) fields.status = patch.status ?? undefined;
    if (patch.fields !== undefined)
      fields.fields = mergeFields(item.fields, patch.fields);
    if (patch.offsetDays !== undefined) {
      fields.offsetDays = patch.offsetDays;
      if (isDayOffsetModule(item.module)) {
        fields.dueDate = computeDueDate(event!.eventDate, patch.offsetDays);
      }
    }
    await ctx.db.patch(itemId, fields);
    return itemId;
  },
});

/** Set an item's status (the common one-tap edit). */
export const setStatus = mutation({
  args: { itemId: v.id("eventItems"), status: v.union(v.string(), v.null()) },
  handler: async (ctx, { itemId, status }) => {
    const chapterId = await requireChapterId(ctx);
    const item = await ctx.db.get(itemId);
    await requireInChapter(
      ctx,
      chapterId,
      item ? await ctx.db.get(item.eventId) : null,
      "Event",
    );
    await ctx.db.patch(itemId, { status: status ?? undefined });
    return itemId;
  },
});

/** Assign or clear an item's owner. */
export const assignOwner = mutation({
  args: {
    itemId: v.id("eventItems"),
    personId: v.optional(v.union(v.id("people"), v.null())),
  },
  handler: async (ctx, { itemId, personId }) => {
    const chapterId = await requireChapterId(ctx);
    const item = await ctx.db.get(itemId);
    if (!item) return itemId;
    const event = await ctx.db.get(item.eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    if (personId) {
      const person = await ctx.db.get(personId);
      await requireInChapter(ctx, chapterId, person, "Person");
    }
    await ctx.db.patch(itemId, { ownerPersonId: personId ?? undefined });
    return itemId;
  },
});

export const removeEventItem = mutation({
  args: { itemId: v.id("eventItems") },
  handler: async (ctx, { itemId }) => {
    const chapterId = await requireChapterId(ctx);
    const item = await ctx.db.get(itemId);
    if (!item) return itemId;
    const event = await ctx.db.get(item.eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    await ctx.db.delete(itemId);
    return itemId;
  },
});

export const reorderEventItems = mutation({
  args: {
    eventId: v.id("events"),
    module: v.string(),
    orderedIds: v.array(v.id("eventItems")),
  },
  handler: async (ctx, { eventId, module, orderedIds }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    for (let i = 0; i < orderedIds.length; i++) {
      const item = await ctx.db.get(orderedIds[i]);
      if (item && item.eventId === eventId && item.module === module) {
        await ctx.db.patch(orderedIds[i], { order: i });
      }
    }
    return eventId;
  },
});
