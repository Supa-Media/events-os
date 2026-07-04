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
import { query, mutation, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import {
  computeDueDate,
  computeReadiness,
  isCompleteStatus,
  DAY_OFFSET_MODULES,
  type ModuleKey,
} from "@events-os/shared";
import {
  requireChapterId,
  requireEvent,
  requireEventType,
  requireOwned,
} from "./lib/context";
import {
  bumpVersion,
  maxOrder,
  eventActiveModules,
  templateActiveModules,
} from "./lib/templates";

const fieldsValidator = v.optional(v.record(v.string(), v.any()));

function isDayOffsetModule(module: string): boolean {
  return DAY_OFFSET_MODULES.includes(module as ModuleKey);
}

/**
 * Assert `module` is one of the event's resolved ACTIVE modules — rejecting
 * arbitrary/disabled module strings so an item can't be written against a
 * surface the event doesn't have. Throws a ConvexError when it isn't.
 */
async function requireActiveEventModule(
  ctx: QueryCtx,
  event: Doc<"events">,
  module: string,
): Promise<void> {
  const active = await eventActiveModules(ctx, event);
  if (!active.some((m) => m.key === module)) {
    throw new ConvexError({
      code: "UNKNOWN_MODULE",
      message: `"${module}" is not an active module on this event.`,
    });
  }
}

/** Same as `requireActiveEventModule` but for a template's active modules. */
async function requireActiveTemplateModule(
  ctx: QueryCtx,
  eventType: Doc<"eventTypes">,
  module: string,
): Promise<void> {
  const active = await templateActiveModules(ctx, eventType);
  if (!active.some((m) => m.key === module)) {
    throw new ConvexError({
      code: "UNKNOWN_MODULE",
      message: `"${module}" is not an active module on this template.`,
    });
  }
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
        .withIndex("by_eventType_module", (q) =>
          q.eq("eventTypeId", eventTypeId).eq("module", module),
        )
        .collect()
    ).sort((a, b) => a.order - b.order);
    const items = (
      await ctx.db
        .query("templateItems")
        .withIndex("by_eventType_module", (q) =>
          q.eq("eventTypeId", eventTypeId).eq("module", module),
        )
        .collect()
    ).sort((a, b) => a.order - b.order);
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
    roleId: v.optional(v.id("templateRoles")),
    status: v.optional(v.string()),
    fields: fieldsValidator,
  },
  handler: async (ctx, args) => {
    const et = await requireEventType(ctx, args.eventTypeId);
    await requireActiveTemplateModule(ctx, et, args.module);
    const items = await ctx.db
      .query("templateItems")
      .withIndex("by_eventType_module", (q) =>
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
    roleId: v.optional(v.union(v.id("templateRoles"), v.null())),
    status: v.optional(v.union(v.string(), v.null())),
    // Manual row height (px); null resets the row back to auto-fit.
    rowHeight: v.optional(v.union(v.number(), v.null())),
    fields: fieldsValidator,
  },
  handler: async (ctx, { itemId, ...patch }) => {
    const item = await ctx.db.get(itemId);
    if (!item) return itemId;
    await requireEventType(ctx, item.eventTypeId);
    const fields: Record<string, unknown> = {};
    if (patch.title !== undefined) fields.title = patch.title;
    if (patch.offsetDays !== undefined) fields.offsetDays = patch.offsetDays;
    if (patch.offsetMinutes !== undefined)
      fields.offsetMinutes = patch.offsetMinutes;
    if (patch.roleId !== undefined) fields.roleId = patch.roleId ?? undefined;
    if (patch.status !== undefined) fields.status = patch.status ?? undefined;
    if (patch.rowHeight !== undefined)
      fields.rowHeight = patch.rowHeight ?? undefined;
    if (patch.fields !== undefined)
      fields.fields = mergeFields(item.fields, patch.fields);
    await ctx.db.patch(itemId, fields);
    await bumpVersion(ctx, item.eventTypeId);
    return itemId;
  },
});

/**
 * Toggle whether a column on a template item is marked "pre-plan" (a cell that
 * needs explicit sign-off before the event). Marks live on the templateItem's
 * `prePlanColumns`; they clone onto every event spun up from the template.
 */
export const toggleTemplatePrePlan = mutation({
  args: { itemId: v.id("templateItems"), colKey: v.string() },
  handler: async (ctx, { itemId, colKey }) => {
    const item = await ctx.db.get(itemId);
    if (!item) return itemId;
    await requireEventType(ctx, item.eventTypeId);
    const current = item.prePlanColumns ?? [];
    const next = current.includes(colKey)
      ? current.filter((k) => k !== colKey)
      : [...current, colKey];
    await ctx.db.patch(itemId, {
      prePlanColumns: next.length > 0 ? next : undefined,
    });
    await bumpVersion(ctx, item.eventTypeId);
    return itemId;
  },
});

export const removeTemplateItem = mutation({
  args: { itemId: v.id("templateItems") },
  handler: async (ctx, { itemId }) => {
    const item = await ctx.db.get(itemId);
    if (!item) return itemId;
    await requireEventType(ctx, item.eventTypeId);
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
    await requireEventType(ctx, eventTypeId);
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
        .withIndex("by_event_module", (q) =>
          q.eq("eventId", eventId).eq("module", module),
        )
        .collect()
    ).sort((a, b) => a.order - b.order);

    const rawItems = (
      await ctx.db
        .query("eventItems")
        .withIndex("by_event_module", (q) =>
          q.eq("eventId", eventId).eq("module", module),
        )
        .collect()
    ).sort((a, b) => a.order - b.order);

    // Map each event role → its assigned person, so an item's owner can be
    // auto-derived from its role (with an explicit ownerPersonId as override).
    const assignments = await ctx.db
      .query("roleAssignments")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();
    const roleToPerson = new Map<string, Id<"people">>(
      assignments.map((a) => [String(a.roleId), a.personId]),
    );

    const items = await Promise.all(
      rawItems.map(async (it) => {
        let roleLabel: string | null = null;
        if (it.roleId) {
          const role = await ctx.db.get(it.roleId as Id<"eventRoles">);
          roleLabel = role?.label ?? null;
        }
        // Explicit owner wins; otherwise inherit the person holding the role.
        const inheritedId = it.roleId
          ? roleToPerson.get(String(it.roleId))
          : undefined;
        const effectiveOwnerId = it.ownerPersonId ?? inheritedId;
        const ownerIsInherited = !it.ownerPersonId && !!inheritedId;
        let owner: { _id: Id<"people">; name: string } | null = null;
        if (effectiveOwnerId) {
          const person = await ctx.db.get(effectiveOwnerId as Id<"people">);
          if (person) owner = { _id: person._id, name: person.name };
        }
        return { ...it, roleLabel, owner, ownerIsInherited };
      }),
    );

    const opts = statusOptions(columns);
    const total = rawItems.length;
    const complete = opts
      ? rawItems.filter((it) => isCompleteStatus(opts, it.status)).length
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
    roleId: v.optional(v.id("eventRoles")),
    ownerPersonId: v.optional(v.id("people")),
    status: v.optional(v.string()),
    fields: fieldsValidator,
  },
  handler: async (ctx, args) => {
    const event = await requireEvent(ctx, args.eventId);
    await requireActiveEventModule(ctx, event, args.module);
    const items = await ctx.db
      .query("eventItems")
      .withIndex("by_event_module", (q) =>
        q.eq("eventId", args.eventId).eq("module", args.module),
      )
      .collect();
    const dueDate =
      isDayOffsetModule(args.module) && args.offsetDays !== undefined
        ? computeDueDate(event.eventDate, args.offsetDays)
        : undefined;
    return await ctx.db.insert("eventItems", {
      eventId: args.eventId,
      chapterId: event.chapterId,
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
    // null unschedules the item (clears its offset and derived due date).
    offsetDays: v.optional(v.union(v.number(), v.null())),
    offsetMinutes: v.optional(v.number()),
    roleId: v.optional(v.union(v.id("eventRoles"), v.null())),
    ownerPersonId: v.optional(v.union(v.id("people"), v.null())),
    status: v.optional(v.union(v.string(), v.null())),
    // Manual row height (px); null resets the row back to auto-fit.
    rowHeight: v.optional(v.union(v.number(), v.null())),
    fields: fieldsValidator,
  },
  handler: async (ctx, { itemId, ...patch }) => {
    const item = await ctx.db.get(itemId);
    if (!item) return itemId;
    const event = await requireEvent(ctx, item.eventId);
    const fields: Record<string, unknown> = {};
    if (patch.title !== undefined) fields.title = patch.title;
    if (patch.offsetMinutes !== undefined)
      fields.offsetMinutes = patch.offsetMinutes;
    if (patch.roleId !== undefined) fields.roleId = patch.roleId ?? undefined;
    if (patch.ownerPersonId !== undefined)
      fields.ownerPersonId = patch.ownerPersonId ?? undefined;
    if (patch.status !== undefined) fields.status = patch.status ?? undefined;
    if (patch.rowHeight !== undefined)
      fields.rowHeight = patch.rowHeight ?? undefined;
    if (patch.fields !== undefined)
      fields.fields = mergeFields(item.fields, patch.fields);
    if (patch.offsetDays !== undefined) {
      fields.offsetDays = patch.offsetDays ?? undefined;
      if (isDayOffsetModule(item.module)) {
        fields.dueDate =
          patch.offsetDays == null
            ? undefined
            : computeDueDate(event.eventDate, patch.offsetDays);
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
    const item = await ctx.db.get(itemId);
    if (!item) return itemId;
    await requireEvent(ctx, item.eventId);
    await ctx.db.patch(itemId, { status: status ?? undefined });
    return itemId;
  },
});

/**
 * Tick / untick a pre-plan cell on an event item. `colKey` must be one of the
 * item's `prePlanColumns` (the template author's marks). Toggling adds/removes
 * the key in `prePlanChecked`; pre-plan% = checked ÷ marked across the event.
 */
export const togglePrePlanChecked = mutation({
  args: { itemId: v.id("eventItems"), colKey: v.string() },
  handler: async (ctx, { itemId, colKey }) => {
    const item = await ctx.db.get(itemId);
    if (!item) return itemId;
    await requireEvent(ctx, item.eventId);
    // Only checkable if the cell was actually marked pre-plan on this row.
    const marked = item.prePlanColumns ?? [];
    if (!marked.includes(colKey)) return itemId;
    const current = item.prePlanChecked ?? [];
    const next = current.includes(colKey)
      ? current.filter((k) => k !== colKey)
      : [...current, colKey];
    await ctx.db.patch(itemId, {
      prePlanChecked: next.length > 0 ? next : undefined,
    });
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
    const item = await ctx.db.get(itemId);
    if (!item) return itemId;
    await requireEvent(ctx, item.eventId);
    if (personId) {
      await requireOwned(ctx, "people", personId, "Person");
    }
    await ctx.db.patch(itemId, { ownerPersonId: personId ?? undefined });
    return itemId;
  },
});

export const removeEventItem = mutation({
  args: { itemId: v.id("eventItems") },
  handler: async (ctx, { itemId }) => {
    const item = await ctx.db.get(itemId);
    if (!item) return itemId;
    await requireEvent(ctx, item.eventId);
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
    await requireEvent(ctx, eventId);
    for (let i = 0; i < orderedIds.length; i++) {
      const item = await ctx.db.get(orderedIds[i]);
      if (item && item.eventId === eventId && item.module === module) {
        await ctx.db.patch(orderedIds[i], { order: i });
      }
    }
    return eventId;
  },
});
