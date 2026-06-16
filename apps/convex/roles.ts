/**
 * Roles — event-team role definitions, owned by a TEMPLATE and cloned to each
 * EVENT on creation (the codebase's clone-on-create pattern).
 *
 * A template is seeded with the defaults the events team settled on (Event Lead,
 * Comms Lead, Logistics Lead, Production Lead), but they're plain data: rename,
 * reorder, add, or delete freely per template. When an event is created its
 * template's roles are cloned into `eventRoles`, after which the event edits its
 * own copy independently. Items reference a role within their own scope, and on a
 * live event a person is assigned to each event role (see roleAssignments).
 *
 * `key` stays stable across rename so item/owner references keep resolving.
 */
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import {
  requireChapterId,
  requireEvent,
  requireEventType,
} from "./lib/context";

/** Kebab-case slug from a display name. */
function toKey(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Max `order` over a list of rows (returns -1 when empty, so next = 0). */
function maxOrder(rows: Array<{ order: number }>): number {
  return rows.reduce((max, r) => (r.order > max ? r.order : max), -1);
}

// ── Template roles ────────────────────────────────────────────────────────────

/** A template's roles (not archived), ordered. */
export const listForTemplate = query({
  args: { eventTypeId: v.id("eventTypes") },
  handler: async (ctx, { eventTypeId }) => {
    const chapterId = await requireChapterId(ctx);
    const et = await ctx.db.get(eventTypeId);
    if (!et || et.chapterId !== chapterId) return [];
    const roles = await ctx.db
      .query("templateRoles")
      .withIndex("by_template", (q) => q.eq("eventTypeId", eventTypeId))
      .collect();
    return roles
      .filter((r) => r.isArchived !== true)
      .sort((a, b) => a.order - b.order);
  },
});

/** Add a role to a template (appended to the end). */
export const createForTemplate = mutation({
  args: {
    eventTypeId: v.id("eventTypes"),
    label: v.string(),
    description: v.optional(v.string()),
    key: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireEventType(ctx, args.eventTypeId);
    const roles = await ctx.db
      .query("templateRoles")
      .withIndex("by_template", (q) => q.eq("eventTypeId", args.eventTypeId))
      .collect();
    return await ctx.db.insert("templateRoles", {
      eventTypeId: args.eventTypeId,
      key: args.key ?? toKey(args.label),
      label: args.label,
      description: args.description,
      order: maxOrder(roles) + 1,
      isArchived: false,
    });
  },
});

/** Rename / re-describe a template role (key stays stable). */
export const updateTemplateRole = mutation({
  args: {
    roleId: v.id("templateRoles"),
    label: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, { roleId, ...patch }) => {
    const role = await ctx.db.get(roleId);
    if (!role) return roleId;
    await requireEventType(ctx, role.eventTypeId);
    const fields: Record<string, unknown> = {};
    if (patch.label !== undefined) fields.label = patch.label;
    if (patch.description !== undefined) fields.description = patch.description;
    await ctx.db.patch(roleId, fields);
    return roleId;
  },
});

/** Hard-delete a template role (template config, no live references). */
export const deleteTemplateRole = mutation({
  args: { roleId: v.id("templateRoles") },
  handler: async (ctx, { roleId }) => {
    const role = await ctx.db.get(roleId);
    if (!role) return roleId;
    await requireEventType(ctx, role.eventTypeId);
    await ctx.db.delete(roleId);
    return roleId;
  },
});

/** Reorder a template's roles to match the given id array. */
export const reorderTemplateRoles = mutation({
  args: { orderedIds: v.array(v.id("templateRoles")) },
  handler: async (ctx, { orderedIds }) => {
    const chapterId = await requireChapterId(ctx);
    for (let i = 0; i < orderedIds.length; i++) {
      const role = await ctx.db.get(orderedIds[i]);
      if (!role) continue;
      const et = await ctx.db.get(role.eventTypeId);
      if (et && et.chapterId === chapterId) {
        await ctx.db.patch(orderedIds[i], { order: i });
      }
    }
    return null;
  },
});

// ── Event roles ───────────────────────────────────────────────────────────────

/** An event's roles, ordered. */
export const listForEvent = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    if (!event || event.chapterId !== chapterId) return [];
    const roles = await ctx.db
      .query("eventRoles")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();
    return roles.sort((a, b) => a.order - b.order);
  },
});

/** Add a role to an event (appended to the end). */
export const createForEvent = mutation({
  args: {
    eventId: v.id("events"),
    label: v.string(),
    description: v.optional(v.string()),
    key: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireEvent(ctx, args.eventId);
    const roles = await ctx.db
      .query("eventRoles")
      .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
      .collect();
    return await ctx.db.insert("eventRoles", {
      eventId: args.eventId,
      key: args.key ?? toKey(args.label),
      label: args.label,
      description: args.description,
      order: maxOrder(roles) + 1,
    });
  },
});

/** Rename / re-describe an event role (key stays stable). */
export const updateEventRole = mutation({
  args: {
    roleId: v.id("eventRoles"),
    label: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, { roleId, ...patch }) => {
    const role = await ctx.db.get(roleId);
    if (!role) return roleId;
    await requireEvent(ctx, role.eventId);
    const fields: Record<string, unknown> = {};
    if (patch.label !== undefined) fields.label = patch.label;
    if (patch.description !== undefined) fields.description = patch.description;
    await ctx.db.patch(roleId, fields);
    return roleId;
  },
});

/**
 * Hard-delete an event role. Also removes any roleAssignments referencing it so
 * no dangling refs are left behind.
 */
export const deleteEventRole = mutation({
  args: { roleId: v.id("eventRoles") },
  handler: async (ctx, { roleId }) => {
    const role = await ctx.db.get(roleId);
    if (!role) return roleId;
    await requireEvent(ctx, role.eventId);
    const assignments = await ctx.db
      .query("roleAssignments")
      .withIndex("by_event_role", (q) =>
        q.eq("eventId", role.eventId).eq("roleId", roleId),
      )
      .collect();
    for (const a of assignments) await ctx.db.delete(a._id);
    await ctx.db.delete(roleId);
    return roleId;
  },
});

/** Reorder an event's roles to match the given id array. */
export const reorderEventRoles = mutation({
  args: { orderedIds: v.array(v.id("eventRoles")) },
  handler: async (ctx, { orderedIds }) => {
    const chapterId = await requireChapterId(ctx);
    for (let i = 0; i < orderedIds.length; i++) {
      const role = await ctx.db.get(orderedIds[i]);
      if (!role) continue;
      const event = await ctx.db.get(role.eventId);
      if (event && event.chapterId === chapterId) {
        await ctx.db.patch(orderedIds[i], { order: i });
      }
    }
    return null;
  },
});

// Re-exported helpers for use by other backend modules.
export { toKey, maxOrder };
