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
import { v, ConvexError } from "convex/values";
import { COLUMN_TYPES, type ColumnType } from "@events-os/shared";
import {
  requireEvent,
  requireEventType,
  requireOwned,
} from "./lib/context";
import { bumpVersion } from "./lib/templates";

const KNOWN_COLUMN_TYPES = new Set<string>(COLUMN_TYPES);

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
    await requireEventType(ctx, eventTypeId);
    const cols = await ctx.db
      .query("templateColumns")
      .withIndex("by_eventType_module", (q) =>
        q.eq("eventTypeId", eventTypeId).eq("module", module),
      )
      .collect();
    return cols.sort((a, b) => a.order - b.order);
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
    await requireEventType(ctx, args.eventTypeId);
    // Reject unknown column types so a bad client can't write a type the grid
    // can't render (the value would silently break rendering/parsing).
    if (!KNOWN_COLUMN_TYPES.has(args.type)) {
      throw new ConvexError({
        code: "INVALID_COLUMN_TYPE",
        message: `Unknown column type "${args.type}".`,
      });
    }
    const cols = await ctx.db
      .query("templateColumns")
      .withIndex("by_eventType_module", (q) =>
        q.eq("eventTypeId", args.eventTypeId).eq("module", args.module),
      )
      .collect();

    // Ensure a unique key within the module.
    let key = toKey(args.label);
    const taken = new Set(cols.map((c) => c.key));
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
      // Runtime-guarded above (KNOWN_COLUMN_TYPES) so this is a real ColumnType;
      // the cast bridges the `v.string()` arg to the tightened column `type` union.
      type: args.type as ColumnType,
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
    const col = await ctx.db.get(columnId);
    if (!col) return columnId;
    await requireEventType(ctx, col.eventTypeId);
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
    const col = await ctx.db.get(columnId);
    if (!col) return columnId;
    await requireEventType(ctx, col.eventTypeId);
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
    await requireEventType(ctx, eventTypeId);
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
    const col = await ctx.db.get(columnId);
    if (!col) return columnId;
    await requireEvent(ctx, col.eventId);
    await ctx.db.patch(columnId, { isVisible });
    return columnId;
  },
});

/**
 * Edit an EVENT column (label, options, width). Mirrors `updateColumn` for the
 * template side so select/status/multiselect options can be added/removed/renamed
 * on a live event too (event columns diverge from the template once edited —
 * that's expected). Option `value`s are preserved by the client editor so item
 * data isn't orphaned.
 */
export const updateEventColumn = mutation({
  args: {
    columnId: v.id("eventColumns"),
    label: v.optional(v.string()),
    options: v.optional(v.array(optionValidator)),
    config: v.optional(v.any()),
    width: v.optional(v.number()),
  },
  handler: async (ctx, { columnId, ...patch }) => {
    const col = await ctx.db.get(columnId);
    if (!col) return columnId;
    await requireEvent(ctx, col.eventId);
    const fields: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(patch)) {
      if (val !== undefined) fields[k] = val;
    }
    await ctx.db.patch(columnId, fields);
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
    await requireEvent(ctx, eventId);
    for (let i = 0; i < orderedIds.length; i++) {
      const col = await ctx.db.get(orderedIds[i]);
      if (col && col.eventId === eventId && col.module === module) {
        await ctx.db.patch(orderedIds[i], { order: i });
      }
    }
    return eventId;
  },
});
