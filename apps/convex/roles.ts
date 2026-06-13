/**
 * Roles — editable, chapter-scoped event-team role definitions.
 *
 * A new chapter is seeded with the 4 the events team settled on (Event Lead,
 * Comms Lead, Logistics Lead, Production Lead), but they're plain data: rename,
 * reorder, add, or archive freely. A template declares which roles it uses, and
 * items/run-of-show rows reference a role; on a live event a person is assigned
 * to each role (see roleAssignments).
 */
import { query, mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  requireChapterId,
  requireInChapter,
  getChapterIdOrNull,
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

/** The chapter's active roles, ordered. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const roles = await ctx.db
      .query("roles")
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", chapterId))
      .collect();
    return roles
      .filter((r: any) => r.isArchived !== true)
      .sort((a: any, b: any) => a.order - b.order);
  },
});

/** Add a role to the chapter (appended to the end). */
export const create = mutation({
  args: {
    label: v.string(),
    description: v.optional(v.string()),
    key: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    const roles = await ctx.db
      .query("roles")
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", chapterId))
      .collect();
    return await ctx.db.insert("roles", {
      chapterId: chapterId as Id<"chapters">,
      key: args.key ?? toKey(args.label),
      label: args.label,
      description: args.description,
      order: maxOrder(roles) + 1,
      isArchived: false,
      createdAt: Date.now(),
    });
  },
});

/** Rename / re-describe a role. */
export const update = mutation({
  args: {
    roleId: v.id("roles"),
    label: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, { roleId, ...patch }) => {
    const chapterId = await requireChapterId(ctx);
    const role = await ctx.db.get(roleId);
    await requireInChapter(ctx, chapterId, role, "Role");
    const fields: Record<string, unknown> = {};
    if (patch.label !== undefined) fields.label = patch.label;
    if (patch.description !== undefined) fields.description = patch.description;
    await ctx.db.patch(roleId, fields);
    return roleId;
  },
});

/** Reorder the chapter's roles to match the given id array. */
export const reorder = mutation({
  args: { orderedIds: v.array(v.id("roles")) },
  handler: async (ctx, { orderedIds }) => {
    const chapterId = await requireChapterId(ctx);
    for (let i = 0; i < orderedIds.length; i++) {
      const role = await ctx.db.get(orderedIds[i]);
      if (role && role.chapterId === chapterId) {
        await ctx.db.patch(orderedIds[i], { order: i });
      }
    }
    return null;
  },
});

/** Archive a role (soft delete; hidden from `list`). */
export const archive = mutation({
  args: { roleId: v.id("roles") },
  handler: async (ctx, { roleId }) => {
    const chapterId = await requireChapterId(ctx);
    const role = await ctx.db.get(roleId);
    await requireInChapter(ctx, chapterId, role, "Role");
    await ctx.db.patch(roleId, { isArchived: true });
    return roleId;
  },
});
