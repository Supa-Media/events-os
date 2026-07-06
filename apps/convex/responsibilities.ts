/**
 * Responsibilities — recurring org duties, fanned out by role.
 *
 * Rows are DEFINITIONS: "Meet with directs, bi-weekly, all Directors" is one
 * row that shows up as an individual responsibility for every person whose
 * role matches (plus anyone assigned directly). Managers and admins work the
 * whole catalog (the Duties tab); everyone else only receives the duties that
 * land on them, and editing is manager/admin-only throughout.
 */
import { query, mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  RESPONSIBILITY_CADENCES,
  responsibilityAppliesTo,
} from "@events-os/shared";
import {
  requireUserId,
  requireChapterId,
  requireOwned,
  getChapterIdOrNull,
} from "./lib/context";
import {
  requireManagerOrAdmin,
  isChapterAdmin,
  viewerPerson,
} from "./lib/org";

const cadence = v.union(...RESPONSIBILITY_CADENCES.map((c) => v.literal(c)));

// Editing responsibilities is for managers and admins (requireManagerOrAdmin):
// these rows feed the check-in accountability loop, so the person being held
// to a duty must not be able to quietly delete or unassign it before their 1:1.

/**
 * The caller's readable slice of the chapter's responsibility definitions,
 * oldest first, each with a summary of its How-To doc (kind/title/url) joined
 * in so list surfaces can render the affordance without a doc query per row.
 *
 * Managers and admins get the whole catalog — the Duties tab, subtree
 * rollups, and quick-assign all need it. Everyone else gets ONLY the duties
 * that land on them (direct assignment or role match): enough to render
 * their own My-work view without exposing the org-wide duty database.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    let rows = await ctx.db
      .query("responsibilities")
      .withIndex("by_chapter", (q) =>
        q.eq("chapterId", chapterId as Id<"chapters">),
      )
      .collect();
    if (!(await isChapterAdmin(ctx, chapterId as Id<"chapters">))) {
      const self = await viewerPerson(ctx, chapterId as Id<"chapters">);
      if (!self) return [];
      const firstReport = await ctx.db
        .query("people")
        .withIndex("by_manager", (q) => q.eq("managerId", self._id))
        .first();
      if (firstReport === null) {
        rows = rows.filter((r) =>
          responsibilityAppliesTo(r, { _id: self._id, role: self.role }),
        );
      }
    }
    return await Promise.all(
      rows.map(async (r) => {
        if (!r.howToDocId) return { ...r, howToDoc: null };
        const doc = await ctx.db.get(r.howToDocId);
        return {
          ...r,
          howToDoc:
            doc && doc.chapterId === chapterId
              ? {
                  _id: doc._id,
                  kind: doc.kind,
                  title: doc.title,
                  url: doc.url ?? null,
                  // Only notes render their body on list surfaces — don't
                  // stream every markdown runbook to every subscriber.
                  body: doc.kind === "note" ? (doc.body ?? null) : null,
                }
              : null,
        };
      }),
    );
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
    await requireManagerOrAdmin(ctx, chapterId as Id<"chapters">);
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
    howToDocId: v.optional(v.union(v.id("docs"), v.null())),
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
    await requireManagerOrAdmin(ctx, row.chapterId);
    if (Array.isArray(patch.assigneePersonIds)) {
      for (const personId of patch.assigneePersonIds) {
        await requireOwned(ctx, "people", personId, "Assignee");
      }
    }
    if (patch.howToDocId != null) {
      await requireOwned(ctx, "docs", patch.howToDocId, "How-To doc");
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
    await requireManagerOrAdmin(ctx, row.chapterId);
    await ctx.db.delete(responsibilityId);
    return responsibilityId;
  },
});
