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
import type { MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { RESPONSIBILITY_CADENCES } from "@events-os/shared";
import {
  requireUserId,
  requireChapterId,
  requireOwned,
  getChapterIdOrNull,
} from "./lib/context";
import {
  requireManagerOrAdmin,
  canViewChapterWork,
} from "./lib/org";
import { makeShareId } from "./lib/platformGuides";

/**
 * Materialize plain how-to TEXT into a standalone `note` doc and return its id,
 * so a duty points at a doc via `howToDocId` (the legacy plain-text `howTo`
 * field is never written). Mirrors the `materializeHowToDocs` migration: a doc
 * is authored AS a roster person (`docs.createdBy` is an `Id<"people">`), so we
 * attribute it to the creating user's linked roster person, else the oldest
 * person in the chapter. Returns null when the text is empty or the chapter has
 * no roster person to own the doc (caller leaves `howToDocId` unset).
 */
async function materializeHowToDoc(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  userId: Id<"users">,
  title: string,
  text: string | null | undefined,
): Promise<Id<"docs"> | null> {
  const body = text?.trim();
  if (!body) return null;
  const linked = await ctx.db
    .query("people")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  let author: Id<"people"> | null =
    linked && linked.chapterId === chapterId ? linked._id : null;
  if (!author) {
    const anyPerson = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .first();
    author = anyPerson?._id ?? null;
  }
  if (!author) return null;
  const now = Date.now();
  return (await ctx.db.insert("docs", {
    chapterId,
    kind: "note",
    title: title || "How-to",
    body,
    shareId: makeShareId(),
    createdBy: author,
    createdAt: now,
    updatedAt: now,
  })) as Id<"docs">;
}

const cadence = v.union(...RESPONSIBILITY_CADENCES.map((c) => v.literal(c)));

// Editing responsibilities is for managers and admins (requireManagerOrAdmin):
// these rows feed the check-in accountability loop, so the person being held
// to a duty must not be able to quietly delete or unassign it before their 1:1.

/**
 * The chapter's responsibility definitions, oldest first, each with a summary
 * of its How-To doc (kind/title/url) joined in so list surfaces can render the
 * affordance without a doc query per row.
 *
 * Read is transparent: admins and every roster member get the whole catalog, so
 * any person's workload page can show the duties they carry — part of seeing the
 * work everyone has. (Editing still gates on manager/admin in the mutations.) A
 * caller with no roster row and no admin rights gets nothing.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    if (!(await canViewChapterWork(ctx, chapterId as Id<"chapters">))) {
      return [];
    }
    const rows = await ctx.db
      .query("responsibilities")
      .withIndex("by_chapter", (q) =>
        q.eq("chapterId", chapterId as Id<"chapters">),
      )
      .collect();
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
    // Legacy plain-text `howTo` is no longer written; materialize any supplied
    // text into a note doc and point at it via `howToDocId`.
    const howToDocId =
      (await materializeHowToDoc(
        ctx,
        chapterId as Id<"chapters">,
        userId as Id<"users">,
        args.title,
        args.howTo,
      )) ?? undefined;
    const now = Date.now();
    return await ctx.db.insert("responsibilities", {
      chapterId: chapterId as Id<"chapters">,
      title: args.title,
      description: args.description,
      howToDocId,
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
    // Legacy plain-text `howTo` is no longer written. Accept the arg (OTA-lagged
    // clients) but drop it; when it carries text and no doc is being set, fold
    // it into a note doc and point the duty at it via `howToDocId`.
    delete fields.howTo;
    if (
      typeof patch.howTo === "string" &&
      patch.howTo.trim() &&
      patch.howToDocId === undefined &&
      !row.howToDocId
    ) {
      const docId = await materializeHowToDoc(
        ctx,
        row.chapterId,
        (await requireUserId(ctx)) as Id<"users">,
        patch.title ?? row.title,
        patch.howTo,
      );
      if (docId) fields.howToDocId = docId;
    }
    fields.updatedAt = Date.now();
    await ctx.db.patch(responsibilityId, fields);
    return responsibilityId;
  },
});

/**
 * Directly assign one person to a duty. Targeted — membership is read and
 * rewritten inside this transaction — so two people editing assignments at
 * once can't clobber each other the way whole-array `update` patches computed
 * from stale client state can. No-op when already assigned.
 */
export const addAssignee = mutation({
  args: {
    responsibilityId: v.id("responsibilities"),
    personId: v.id("people"),
  },
  handler: async (ctx, { responsibilityId, personId }) => {
    const row = await requireOwned(
      ctx,
      "responsibilities",
      responsibilityId,
      "Responsibility",
    );
    await requireManagerOrAdmin(ctx, row.chapterId);
    await requireOwned(ctx, "people", personId, "Assignee");
    const current = row.assigneePersonIds ?? [];
    if (!current.includes(personId)) {
      await ctx.db.patch(responsibilityId, {
        assigneePersonIds: [...current, personId],
        updatedAt: Date.now(),
      });
    }
    return responsibilityId;
  },
});

/**
 * Remove one person's DIRECT assignment from a duty. Role-derived application
 * is deliberately untouched: a duty that reaches them via their title keeps
 * applying until the definition's roles change (Duties grid) or their title
 * does — unassigning a role-match per person would silently fork the fan-out.
 * No-op when not directly assigned.
 */
export const removeAssignee = mutation({
  args: {
    responsibilityId: v.id("responsibilities"),
    personId: v.id("people"),
  },
  handler: async (ctx, { responsibilityId, personId }) => {
    const row = await requireOwned(
      ctx,
      "responsibilities",
      responsibilityId,
      "Responsibility",
    );
    await requireManagerOrAdmin(ctx, row.chapterId);
    const current = row.assigneePersonIds ?? [];
    if (current.includes(personId)) {
      const next = current.filter((id) => id !== personId);
      await ctx.db.patch(responsibilityId, {
        assigneePersonIds: next.length > 0 ? next : undefined,
        updatedAt: Date.now(),
      });
    }
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
