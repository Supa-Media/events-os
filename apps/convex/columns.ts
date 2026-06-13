/**
 * Columns — the configurable schema for a module's grid.
 *
 * `system` columns are backed by promoted item fields (title, offset, due_date,
 * status, role, owner) and aren't deletable. `custom` columns store their value
 * in the item's `fields` bag and are fully add/edit/delete-able — this is what
 * makes templates "very extensible when making them." Editing a template column
 * bumps the template version; events keep their cloned snapshot (eventColumns).
 */
import { query, mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireChapterId, requireInChapter } from "./lib/context";
import { bumpVersion } from "./lib/templates";

const optionValidator = v.object({
  value: v.string(),
  label: v.string(),
  color: v.optional(v.string()),
  isComplete: v.optional(v.boolean()),
});

/** Slug a label into a stable custom-column key. */
function toKey(label: string): string {
  return (
    label
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "field"
  );
}

function maxOrder(rows: Array<{ order: number }>): number {
  return rows.reduce((max, r) => (r.order > max ? r.order : max), -1);
}

/** Columns for one module of a template, ordered. */
export const listForTemplate = query({
  args: { eventTypeId: v.id("eventTypes"), module: v.string() },
  handler: async (ctx, { eventTypeId, module }) => {
    const chapterId = await requireChapterId(ctx);
    const et = await ctx.db.get(eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    const cols = await ctx.db
      .query("templateColumns")
      .withIndex("by_eventType_module", (q: any) =>
        q.eq("eventTypeId", eventTypeId).eq("module", module),
      )
      .collect();
    return cols.sort((a: any, b: any) => a.order - b.order);
  },
});

/** Add a custom column to a template module (appended to the end). */
export const addColumn = mutation({
  args: {
    eventTypeId: v.id("eventTypes"),
    module: v.string(),
    label: v.string(),
    type: v.string(),
    options: v.optional(v.array(optionValidator)),
    config: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    const et = await ctx.db.get(args.eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    const cols = await ctx.db
      .query("templateColumns")
      .withIndex("by_eventType_module", (q: any) =>
        q.eq("eventTypeId", args.eventTypeId).eq("module", args.module),
      )
      .collect();

    // Ensure a unique key within the module.
    let key = toKey(args.label);
    const taken = new Set(cols.map((c: any) => c.key));
    if (taken.has(key)) {
      let i = 2;
      while (taken.has(`${key}_${i}`)) i++;
      key = `${key}_${i}`;
    }

    const id = await ctx.db.insert("templateColumns", {
      eventTypeId: args.eventTypeId,
      module: args.module,
      key,
      label: args.label,
      kind: "custom",
      type: args.type,
      options: args.options,
      config: args.config,
      isVisible: true,
      order: maxOrder(cols) + 1,
    });
    await bumpVersion(ctx, args.eventTypeId);
    return id;
  },
});

/** Edit a template column (label, options, visibility, width). */
export const updateColumn = mutation({
  args: {
    columnId: v.id("templateColumns"),
    label: v.optional(v.string()),
    options: v.optional(v.array(optionValidator)),
    config: v.optional(v.any()),
    isVisible: v.optional(v.boolean()),
    width: v.optional(v.number()),
  },
  handler: async (ctx, { columnId, ...patch }) => {
    const chapterId = await requireChapterId(ctx);
    const col = await ctx.db.get(columnId);
    if (!col) return columnId;
    const et = await ctx.db.get(col.eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    const fields: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(patch)) {
      if (val !== undefined) fields[k] = val;
    }
    await ctx.db.patch(columnId, fields);
    await bumpVersion(ctx, col.eventTypeId);
    return columnId;
  },
});

/** Remove a CUSTOM template column (system columns can only be hidden). */
export const removeColumn = mutation({
  args: { columnId: v.id("templateColumns") },
  handler: async (ctx, { columnId }) => {
    const chapterId = await requireChapterId(ctx);
    const col = await ctx.db.get(columnId);
    if (!col) return columnId;
    const et = await ctx.db.get(col.eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    if (col.kind === "system") {
      // System columns are structural; hide instead of delete.
      await ctx.db.patch(columnId, { isVisible: false });
      await bumpVersion(ctx, col.eventTypeId);
      return columnId;
    }
    await ctx.db.delete(columnId);
    await bumpVersion(ctx, col.eventTypeId);
    return columnId;
  },
});

/** Reorder a template module's columns to match the given id array. */
export const reorderColumns = mutation({
  args: {
    eventTypeId: v.id("eventTypes"),
    module: v.string(),
    orderedIds: v.array(v.id("templateColumns")),
  },
  handler: async (ctx, { eventTypeId, module, orderedIds }) => {
    const chapterId = await requireChapterId(ctx);
    const et = await ctx.db.get(eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    for (let i = 0; i < orderedIds.length; i++) {
      const col = await ctx.db.get(orderedIds[i]);
      if (col && col.eventTypeId === eventTypeId && col.module === module) {
        await ctx.db.patch(orderedIds[i], { order: i });
      }
    }
    await bumpVersion(ctx, eventTypeId);
    return eventTypeId;
  },
});

// ── Event-side column tweaks (show/hide/reorder per live event) ───────────────
/** Toggle a column's visibility on a live event (no template change). */
export const setEventColumnVisibility = mutation({
  args: { columnId: v.id("eventColumns"), isVisible: v.boolean() },
  handler: async (ctx, { columnId, isVisible }) => {
    const chapterId = await requireChapterId(ctx);
    const col = await ctx.db.get(columnId);
    if (!col) return columnId;
    const event = await ctx.db.get(col.eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    await ctx.db.patch(columnId, { isVisible });
    return columnId;
  },
});

/** Reorder an event module's columns. */
export const reorderEventColumns = mutation({
  args: {
    eventId: v.id("events"),
    module: v.string(),
    orderedIds: v.array(v.id("eventColumns")),
  },
  handler: async (ctx, { eventId, module, orderedIds }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    for (let i = 0; i < orderedIds.length; i++) {
      const col = await ctx.db.get(orderedIds[i]);
      if (col && col.eventId === eventId && col.module === module) {
        await ctx.db.patch(orderedIds[i], { order: i });
      }
    }
    return eventId;
  },
});
