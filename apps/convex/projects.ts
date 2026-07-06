/**
 * Projects — nestable units of work owned by roster people.
 *
 * The manager-facing tracking primitive: each project carries the state a
 * manager needs to know without meeting the owner (status, mini status note,
 * deadline, blocker, next steps), can nest sub-projects, and can point at an
 * event when the project IS an event. Chapter-scoped like everything else.
 */
import { query, mutation, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import { PROJECT_STATUSES } from "@events-os/shared";
import {
  requireUserId,
  requireChapterId,
  requireOwned,
  getChapterIdOrNull,
} from "./lib/context";
import { isChapterAdmin, manageablePersonIds, viewerPerson } from "./lib/org";

const projectStatus = v.union(...PROJECT_STATUSES.map((s) => v.literal(s)));

/**
 * The person accountable for a project: its owner, or the nearest ancestor's
 * owner (unowned sub-projects inherit their parent's scope). Undefined when
 * the whole chain is unowned — such projects are admin territory.
 */
async function effectiveOwnerId(
  ctx: QueryCtx,
  project: { ownerPersonId?: Id<"people">; parentProjectId?: Id<"projects"> },
): Promise<Id<"people"> | undefined> {
  let cur = project;
  for (let hops = 0; hops < 100; hops++) {
    if (cur.ownerPersonId) return cur.ownerPersonId;
    if (!cur.parentProjectId) return undefined;
    const parent: Doc<"projects"> | null = await ctx.db.get(cur.parentProjectId);
    if (!parent) return undefined;
    cur = parent;
  }
  return undefined;
}

/**
 * Assert work accountable to `ownerPersonId` is inside the caller's scope:
 * `manageable === null` means admin (no restriction); otherwise the owner must
 * sit in the caller's manager subtree (which includes themselves). Unowned
 * work (undefined) is admin-only.
 */
function assertInScope(
  manageable: Set<Id<"people">> | null,
  ownerPersonId: Id<"people"> | undefined,
  message = "You can only manage projects for people on your team.",
): void {
  if (manageable === null) return; // admin — no restriction
  if (ownerPersonId && manageable.has(ownerPersonId)) return;
  throw new ConvexError({ code: "FORBIDDEN", message });
}

/**
 * Assert that parenting `projectId` under `parentId` keeps the project tree
 * acyclic: walk up the proposed parent's chain and throw if it passes through
 * the project (or the project IS the parent). Bounded against corrupt chains.
 */
async function assertNoParentCycle(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  parentId: Id<"projects">,
): Promise<void> {
  let cur: Id<"projects"> | undefined = parentId;
  for (let hops = 0; cur && hops < 100; hops++) {
    if (cur === projectId) {
      throw new ConvexError({
        code: "PROJECT_CYCLE",
        message: "That would nest a project inside itself.",
      });
    }
    const doc: Doc<"projects"> | null = await ctx.db.get(cur);
    cur = doc?.parentProjectId;
  }
}

/**
 * The projects the caller may see, oldest first: the whole chapter for
 * admins, otherwise only projects whose effective owner sits in the caller's
 * manager subtree. The frontend assembles the nesting (parent → children) and
 * per-owner grouping itself so one reactive query serves both the Team
 * overview and the per-person workload page.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const all = await ctx.db
      .query("projects")
      .withIndex("by_chapter", (q) =>
        q.eq("chapterId", chapterId as Id<"chapters">),
      )
      .collect();
    const manageable = await manageablePersonIds(
      ctx,
      chapterId as Id<"chapters">,
    );
    let visible = all;
    if (manageable !== null) {
      // Effective-owner walk done in memory — `all` already holds every ancestor.
      const byId = new Map(all.map((p) => [p._id, p]));
      visible = all.filter((p) => {
        let cur: Doc<"projects"> | undefined = p;
        for (let hops = 0; cur && hops < 100; hops++) {
          if (cur.ownerPersonId) return manageable.has(cur.ownerPersonId);
          cur = cur.parentProjectId ? byId.get(cur.parentProjectId) : undefined;
        }
        return false; // fully unowned chain — admin territory
      });
    }
    // Join each card's collapsed preview: the latest comment, attributed.
    return await Promise.all(
      visible.map(async (p) => {
        const last = await ctx.db
          .query("projectComments")
          .withIndex("by_project", (q) => q.eq("projectId", p._id))
          .order("desc")
          .first();
        if (!last) return { ...p, lastComment: null };
        const author = await ctx.db.get(last.authorPersonId);
        return {
          ...p,
          lastComment: {
            body: last.body,
            authorName: author?.name ?? null,
            createdAt: last.createdAt,
          },
        };
      }),
    );
  },
});

/**
 * A project's full comment thread, oldest first — the progression record.
 * Visible to whoever can see the project (same effective-owner scope).
 */
export const comments = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const project = await requireOwned(ctx, "projects", projectId, "Project");
    const manageable = await manageablePersonIds(ctx, project.chapterId);
    if (manageable !== null) {
      const owner = await effectiveOwnerId(ctx, project);
      if (!owner || !manageable.has(owner)) return [];
    }
    const rows = await ctx.db
      .query("projectComments")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    return await Promise.all(
      rows.map(async (c) => {
        const author = await ctx.db.get(c.authorPersonId);
        return { ...c, authorName: author?.name ?? null };
      }),
    );
  },
});

/** Post a comment on a project — the unit of its history. */
export const addComment = mutation({
  args: { projectId: v.id("projects"), body: v.string() },
  handler: async (ctx, { projectId, body }) => {
    const project = await requireOwned(ctx, "projects", projectId, "Project");
    const manageable = await manageablePersonIds(ctx, project.chapterId);
    assertInScope(
      manageable,
      await effectiveOwnerId(ctx, project),
      "You can only comment on your team's projects.",
    );
    const author = await viewerPerson(ctx, project.chapterId);
    if (!author) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "You need a roster profile to comment.",
      });
    }
    const trimmed = body.trim();
    if (!trimmed) {
      throw new ConvexError({
        code: "INVALID",
        message: "A comment needs some text.",
      });
    }
    const userId = await requireUserId(ctx);
    return await ctx.db.insert("projectComments", {
      chapterId: project.chapterId,
      projectId,
      authorPersonId: author._id,
      body: trimmed,
      createdBy: userId as Id<"users">,
      createdAt: Date.now(),
    });
  },
});

/** Delete a comment — its author, or a chapter admin. */
export const removeComment = mutation({
  args: { commentId: v.id("projectComments") },
  handler: async (ctx, { commentId }) => {
    const comment = await requireOwned(
      ctx,
      "projectComments",
      commentId,
      "Comment",
    );
    if (!(await isChapterAdmin(ctx, comment.chapterId))) {
      const viewer = await viewerPerson(ctx, comment.chapterId);
      if (!viewer || viewer._id !== comment.authorPersonId) {
        throw new ConvexError({
          code: "FORBIDDEN",
          message: "Only the comment's author (or an admin) can delete it.",
        });
      }
    }
    await ctx.db.delete(commentId);
    return commentId;
  },
});

/** Create a project (optionally owned, nested, and/or event-backed). */
export const create = mutation({
  args: {
    name: v.string(),
    purpose: v.optional(v.string()),
    status: v.optional(projectStatus),
    ownerPersonId: v.optional(v.id("people")),
    parentProjectId: v.optional(v.id("projects")),
    eventId: v.optional(v.id("events")),
    startDate: v.optional(v.number()),
    deadline: v.optional(v.number()),
    budgetUsd: v.optional(v.number()),
    statusNote: v.optional(v.string()),
    blocker: v.optional(v.string()),
    nextSteps: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    const userId = await requireUserId(ctx);
    if (args.ownerPersonId) {
      await requireOwned(ctx, "people", args.ownerPersonId, "Owner");
    }
    let parent: Doc<"projects"> | undefined;
    if (args.parentProjectId) {
      parent = await requireOwned(ctx, "projects", args.parentProjectId, "Parent project");
    }
    if (args.eventId) {
      await requireOwned(ctx, "events", args.eventId, "Event");
    }
    const manageable = await manageablePersonIds(ctx, chapterId as Id<"chapters">);
    const parentOwner = parent ? await effectiveOwnerId(ctx, parent) : undefined;
    assertInScope(manageable, args.ownerPersonId ?? parentOwner);
    // Nesting under someone else's project would surface this row in THEIR
    // tree — the destination parent must be in scope too, not just the owner.
    if (parent) assertInScope(manageable, parentOwner);
    const now = Date.now();
    return await ctx.db.insert("projects", {
      chapterId: chapterId as Id<"chapters">,
      name: args.name,
      purpose: args.purpose,
      status: args.status ?? "not_started",
      ownerPersonId: args.ownerPersonId,
      parentProjectId: args.parentProjectId,
      eventId: args.eventId,
      startDate: args.startDate,
      deadline: args.deadline,
      budgetUsd: args.budgetUsd,
      statusNote: args.statusNote,
      blocker: args.blocker,
      nextSteps: args.nextSteps,
      createdBy: userId as Id<"users">,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Patch a project's fields. `null` = explicit clear; `undefined` = unchanged. */
export const update = mutation({
  args: {
    projectId: v.id("projects"),
    name: v.optional(v.string()),
    purpose: v.optional(v.union(v.string(), v.null())),
    status: v.optional(projectStatus),
    ownerPersonId: v.optional(v.union(v.id("people"), v.null())),
    parentProjectId: v.optional(v.union(v.id("projects"), v.null())),
    eventId: v.optional(v.union(v.id("events"), v.null())),
    startDate: v.optional(v.union(v.number(), v.null())),
    deadline: v.optional(v.union(v.number(), v.null())),
    budgetUsd: v.optional(v.union(v.number(), v.null())),
    statusNote: v.optional(v.union(v.string(), v.null())),
    blocker: v.optional(v.union(v.string(), v.null())),
    nextSteps: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { projectId, ...patch }) => {
    const project = await requireOwned(ctx, "projects", projectId, "Project");
    const manageable = await manageablePersonIds(ctx, project.chapterId);
    assertInScope(manageable, await effectiveOwnerId(ctx, project));
    if (patch.ownerPersonId != null) {
      await requireOwned(ctx, "people", patch.ownerPersonId, "Owner");
      // Non-admins may only hand work to people still inside their subtree.
      assertInScope(manageable, patch.ownerPersonId);
    }
    if (patch.parentProjectId != null) {
      const parent = await requireOwned(
        ctx,
        "projects",
        patch.parentProjectId,
        "Parent project",
      );
      await assertNoParentCycle(ctx, projectId, patch.parentProjectId);
      // Re-parenting surfaces this row in the destination tree — the new
      // parent's effective owner must be in scope too.
      assertInScope(manageable, await effectiveOwnerId(ctx, parent));
    }
    if (patch.ownerPersonId === null) {
      // Clearing the owner: the project must still resolve to an in-scope
      // owner through its (possibly new) parent chain, or the caller would
      // push it into admin-only unowned territory and lose it themselves.
      const parentId =
        patch.parentProjectId !== undefined
          ? patch.parentProjectId
          : project.parentProjectId;
      const chainOwner = parentId
        ? await effectiveOwnerId(ctx, { parentProjectId: parentId })
        : undefined;
      assertInScope(
        manageable,
        chainOwner,
        "Assign a different owner instead of leaving the project unowned.",
      );
    }
    if (patch.eventId != null) {
      await requireOwned(ctx, "events", patch.eventId, "Event");
    }
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      // null = explicit clear (store undefined); undefined = leave unchanged.
      if (value !== undefined) fields[key] = value === null ? undefined : value;
    }
    fields.updatedAt = Date.now();
    await ctx.db.patch(projectId, fields);
    return projectId;
  },
});

/**
 * Delete a project. Sub-projects are re-parented onto the removed project's
 * own parent (or become roots) rather than deleted — they're still real work.
 */
export const remove = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const project = await requireOwned(ctx, "projects", projectId, "Project");
    const manageable = await manageablePersonIds(ctx, project.chapterId);
    const effOwner = await effectiveOwnerId(ctx, project);
    assertInScope(manageable, effOwner);
    const children = await ctx.db
      .query("projects")
      .withIndex("by_parent", (q) => q.eq("parentProjectId", projectId))
      .collect();
    for (const child of children) {
      await ctx.db.patch(child._id, {
        parentProjectId: project.parentProjectId,
        // A child that inherited its owner through the deleted parent keeps
        // that owner explicitly, so it stays visible/scoped exactly as before
        // instead of falling into admin-only unowned territory.
        ownerPersonId: child.ownerPersonId ?? effOwner,
        updatedAt: Date.now(),
      });
    }
    // The thread belongs to the project — it goes with it.
    const thread = await ctx.db
      .query("projectComments")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    for (const c of thread) await ctx.db.delete(c._id);
    await ctx.db.delete(projectId);
    return projectId;
  },
});
