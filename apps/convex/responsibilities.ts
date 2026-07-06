/**
 * Responsibilities — recurring org duties, fanned out by role.
 *
 * Rows are DEFINITIONS: "Meet with directs, bi-weekly, all Directors" is one
 * row that shows up as an individual responsibility for every person whose
 * role matches (plus anyone assigned directly). The whole chapter can read
 * them (they're the org's how-to documentation); editing is open like the
 * People roster.
 */
import { query, mutation, QueryCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import { RESPONSIBILITY_CADENCES } from "@events-os/shared";
import {
  requireUserId,
  requireChapterId,
  requireOwned,
  getChapterIdOrNull,
} from "./lib/context";
import { isChapterAdmin, viewerPerson } from "./lib/org";

const cadence = v.union(...RESPONSIBILITY_CADENCES.map((c) => v.literal(c)));

/**
 * Editing responsibilities is for managers and admins. These rows feed the
 * check-in accountability loop, so the person being held to a duty must not
 * be able to quietly delete or unassign it before their 1:1.
 */
async function requireCanEdit(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<void> {
  if (await isChapterAdmin(ctx, chapterId)) return;
  const viewer = await viewerPerson(ctx, chapterId);
  if (viewer) {
    const firstReport = await ctx.db
      .query("people")
      .withIndex("by_manager", (q) => q.eq("managerId", viewer._id))
      .first();
    if (firstReport !== null) return;
  }
  throw new ConvexError({
    code: "FORBIDDEN",
    message: "Only managers and admins can edit responsibilities.",
  });
}

/** All the chapter's responsibility definitions, oldest first. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    return await ctx.db
      .query("responsibilities")
      .withIndex("by_chapter", (q) =>
        q.eq("chapterId", chapterId as Id<"chapters">),
      )
      .collect();
  },
});

/** Create a responsibility definition. */
export const create = mutation({
  args: {
    title: v.string(),
    description: v.optional(v.string()),
    howTo: v.optional(v.string()),
    cadence: v.optional(cadence),
    assigneeRoles: v.optional(v.array(v.string())),
    assigneePersonIds: v.optional(v.array(v.id("people"))),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    const userId = await requireUserId(ctx);
    await requireCanEdit(ctx, chapterId as Id<"chapters">);
    for (const personId of args.assigneePersonIds ?? []) {
      await requireOwned(ctx, "people", personId, "Assignee");
    }
    const now = Date.now();
    return await ctx.db.insert("responsibilities", {
      chapterId: chapterId as Id<"chapters">,
      title: args.title,
      description: args.description,
      howTo: args.howTo,
      cadence: args.cadence ?? "ad_hoc",
      assigneeRoles: args.assigneeRoles,
      assigneePersonIds: args.assigneePersonIds,
      notes: args.notes,
      createdBy: userId as Id<"users">,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Patch a responsibility. `null` = explicit clear; `undefined` = unchanged. */
export const update = mutation({
  args: {
    responsibilityId: v.id("responsibilities"),
    title: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
    howTo: v.optional(v.union(v.string(), v.null())),
    cadence: v.optional(cadence),
    assigneeRoles: v.optional(v.union(v.array(v.string()), v.null())),
    assigneePersonIds: v.optional(
      v.union(v.array(v.id("people")), v.null()),
    ),
    notes: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { responsibilityId, ...patch }) => {
    const row = await requireOwned(
      ctx,
      "responsibilities",
      responsibilityId,
      "Responsibility",
    );
    await requireCanEdit(ctx, row.chapterId);
    if (Array.isArray(patch.assigneePersonIds)) {
      for (const personId of patch.assigneePersonIds) {
        await requireOwned(ctx, "people", personId, "Assignee");
      }
    }
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      // null = explicit clear (store undefined); undefined = leave unchanged.
      if (value !== undefined) fields[key] = value === null ? undefined : value;
    }
    fields.updatedAt = Date.now();
    await ctx.db.patch(responsibilityId, fields);
    return responsibilityId;
  },
});

/** Delete a responsibility definition (check-in history keeps its snapshot). */
export const remove = mutation({
  args: { responsibilityId: v.id("responsibilities") },
  handler: async (ctx, { responsibilityId }) => {
    const row = await requireOwned(
      ctx,
      "responsibilities",
      responsibilityId,
      "Responsibility",
    );
    await requireCanEdit(ctx, row.chapterId);
    await ctx.db.delete(responsibilityId);
    return responsibilityId;
  },
});
