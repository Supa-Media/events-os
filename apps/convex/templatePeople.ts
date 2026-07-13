/**
 * Template Crew (placeholder people).
 *
 * Chapter-scoped CRUD for the stand-in crew authored on a TEMPLATE. Each row is
 * scoped to one `eventType`; access is enforced by resolving the caller's
 * chapter (`requireChapterId`) and asserting the owning eventType belongs to it
 * (`requireInChapter`). On event creation these rows are materialized into real
 * chapter `people` (flagged `isPlaceholder`) by `instantiateEvent`.
 */
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireChapterId, requireInChapter } from "./lib/context";
import { maxOrder } from "./lib/templates";
import { deleteTemplatePlacementsForRef } from "./lib/placements";

/** A template's placeholder crew, ordered. */
export const list = query({
  args: { eventTypeId: v.id("eventTypes") },
  handler: async (ctx, { eventTypeId }) => {
    const chapterId = await requireChapterId(ctx);
    const et = await ctx.db.get(eventTypeId);
    if (!et || et.chapterId !== chapterId) return [];
    const rows = await ctx.db
      .query("templatePeople")
      .withIndex("by_template", (q: any) => q.eq("eventTypeId", eventTypeId))
      .collect();
    return rows.sort((a: any, b: any) => a.order - b.order);
  },
});

/** Add a placeholder crew member to a template (appended to the end). */
export const create = mutation({
  args: {
    eventTypeId: v.id("eventTypes"),
    name: v.string(),
    team: v.optional(v.string()),
    teams: v.optional(v.array(v.string())),
    role: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    const et = await ctx.db.get(args.eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    const rows = await ctx.db
      .query("templatePeople")
      .withIndex("by_template", (q: any) =>
        q.eq("eventTypeId", args.eventTypeId),
      )
      .collect();
    return await ctx.db.insert("templatePeople", {
      eventTypeId: args.eventTypeId,
      name: args.name,
      team: args.team,
      teams: args.teams,
      role: args.role,
      order: maxOrder(rows) + 1,
      createdAt: Date.now(),
    });
  },
});

/** Rename / re-team / re-role a placeholder crew member. */
export const update = mutation({
  args: {
    templatePersonId: v.id("templatePeople"),
    name: v.optional(v.string()),
    team: v.optional(v.union(v.string(), v.null())),
    teams: v.optional(v.union(v.array(v.string()), v.null())),
    role: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { templatePersonId, ...patch }) => {
    const chapterId = await requireChapterId(ctx);
    const row = await ctx.db.get(templatePersonId);
    if (!row) return templatePersonId;
    const et = await ctx.db.get(row.eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      // null = explicit clear (store undefined); undefined = leave unchanged.
      if (value !== undefined) fields[key] = value === null ? undefined : value;
    }
    await ctx.db.patch(templatePersonId, fields);
    return templatePersonId;
  },
});

/** Hard-delete a placeholder crew member (template config, no live references). */
export const remove = mutation({
  args: { templatePersonId: v.id("templatePeople") },
  handler: async (ctx, { templatePersonId }) => {
    const chapterId = await requireChapterId(ctx);
    const row = await ctx.db.get(templatePersonId);
    if (!row) return templatePersonId;
    const et = await ctx.db.get(row.eventTypeId);
    await requireInChapter(ctx, chapterId, et, "Event type");
    // Cascade: drop any site-map chips pointing at this placeholder crew row.
    await deleteTemplatePlacementsForRef(
      ctx,
      String(row.eventTypeId),
      "volunteer",
      String(templatePersonId),
    );
    await ctx.db.delete(templatePersonId);
    return templatePersonId;
  },
});
