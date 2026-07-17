/**
 * Projects — nestable units of work owned by roster people.
 *
 * The manager-facing tracking primitive: each project carries the state a
 * manager needs to know without meeting the owner (status, mini status note,
 * deadline, blocker, next steps), can nest sub-projects, and can point at an
 * event when the project IS an event. Chapter-scoped like everything else.
 */
import { query, mutation, QueryCtx, MutationCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import {
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
  financeRoleAtLeast,
} from "@events-os/shared";
import {
  requireUserId,
  requireChapterId,
  requireOwned,
  getChapterIdOrNull,
} from "./lib/context";
import {
  isChapterAdmin,
  manageablePersonIds,
  viewerPerson,
  canViewChapterWork,
} from "./lib/org";
import { requireCentralReach } from "./lib/centralReach";
import { getFinanceRole, type FinanceAccess, type FinanceScope } from "./lib/finance";
import {
  assertIntegerCents,
  createProjectBudget,
  getBudgetForRef,
  setBudgetAmount,
} from "./finances";

/**
 * A project's money-attribution scope: "central" or "chapter" — a project's
 * ROW has no central union yet (WP-2.2 finding; see `finances.
 * transferProjectScope`'s doc comment), so this is always about where the
 * project's BUDGET currently lives, never `projects.chapterId` itself.
 */
const projectScopeChoice = v.union(v.literal("central"), v.literal("chapter"));

/**
 * True iff `access` can actually EXECUTE a central money move — central reach
 * AND at least the bookkeeper write rank. Mirrors `finances.
 * transferProjectScope`'s own gate (`requireCentralWrite(ctx, "bookkeeper")`)
 * exactly, so nothing here ever offers/defaults-to/claims-permission-for a
 * scope the mutation would then refuse. A plain `getFinanceRole(...).isCentral`
 * is NOT enough — that's reach only, and a central VIEWER has reach but no
 * write rank (they'd be rejected by `summonBudgetForRef`/`transferProjectScope`
 * just like a chapter viewer).
 */
function hasCentralWriteReach(access: FinanceAccess): boolean {
  return access.isCentral && financeRoleAtLeast(access.role, "bookkeeper");
}

const projectStatus = v.union(...PROJECT_STATUSES.map((s) => v.literal(s)));

/**
 * Combine the legacy one-slot `statusNote` / `nextSteps` into a single comment
 * body (or null when both are empty). Mirrors the `foldProjectStatusNotes`
 * migration's shape so a fresh write and a migrated row read identically.
 */
function composeStatusBody(
  statusNote?: string | null,
  nextSteps?: string | null,
): string | null {
  const parts: string[] = [];
  const s = statusNote?.trim();
  const n = nextSteps?.trim();
  if (s) parts.push(s);
  if (n) parts.push(`Next steps: ${n}`);
  return parts.length ? parts.join("\n\n") : null;
}

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
 * Who may EDIT projects: anyone on the roster, or a chapter admin. Editing is
 * open now (accountability comes from the update log, not from locking it down)
 * — this just requires the caller be part of the chapter. Returns their roster
 * person, the audit-log author, when they have one; an unlinked admin still
 * edits, just without a named author. Throws for everyone else.
 */
async function requireProjectEditor(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
): Promise<Doc<"people"> | null> {
  const author = await viewerPerson(ctx, chapterId);
  if (author) return author;
  if (await isChapterAdmin(ctx, chapterId)) return null;
  throw new ConvexError({
    code: "FORBIDDEN",
    message: "You need a roster profile to edit projects.",
  });
}

/** A short date for the update log, in the team's timezone. */
function fmtLogDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Append one entry to a project's update log (the audit trail). */
async function logProjectUpdate(
  ctx: MutationCtx,
  project: { _id: Id<"projects">; chapterId: Id<"chapters"> },
  author: Doc<"people"> | null,
  field: string,
  summary: string,
): Promise<void> {
  await ctx.db.insert("projectUpdates", {
    chapterId: project.chapterId,
    projectId: project._id,
    authorPersonId: author?._id,
    field,
    summary,
    createdAt: Date.now(),
  });
}

/**
 * The creation-time scope picker's options for the caller's own chapter: their
 * chapter's name, whether they hold central (org-wide) finance reach, and the
 * resulting default ("creator's highest hat" — owner spec). Uses the SAME
 * `getFinanceRole` primitive `finances.transferProjectScope`'s gate checks, so
 * the default this offers is never a scope the caller would then be refused
 * when `projects.create` re-checks it server-side.
 */
export const scopeOptions = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return null;
    const chapter = await ctx.db.get(chapterId);
    if (!chapter) return null;
    const access = await getFinanceRole(ctx, chapterId);
    const canCentral = hasCentralWriteReach(access);
    return {
      chapterId,
      chapterName: chapter.name,
      // Whether the picker should even be offered — a central VIEWER has
      // reach but no write rank, so they get no picker (same as a chapter-only
      // caller): the mutation would refuse "central" from them anyway.
      isCentral: canCentral,
      defaultScope: (canCentral ? "central" : "chapter") as "central" | "chapter",
    };
  },
});

/**
 * Resolve which chapter a peek-capable Projects read should scope to: the
 * caller's own chapter when `requestedChapterId` is absent (or equals it); a
 * DIFFERENT chapter requires the caller have central (org-wide) reach through
 * their OWN chapter — mirrors `finances.dashboardChapter`'s central drill-down
 * gate exactly (`lib/centralReach.ts` reuses the same underlying check, so
 * Projects doesn't invent a second central-reach concept).
 *
 * Returns `null` when there's nothing to scope to (no `requestedChapterId`
 * and no home chapter). Throws `NO_CHAPTER` when a foreign `requestedChapterId`
 * is passed but the caller has no home chapter to check central reach through
 * (never falls back to checking central-ness against the TARGET chapter).
 */
async function resolvePeekChapterId(
  ctx: QueryCtx,
  requestedChapterId: Id<"chapters"> | undefined,
): Promise<Id<"chapters"> | null> {
  const ownChapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
  const chapterId = requestedChapterId ?? ownChapterId;
  if (!chapterId) return null;
  if (requestedChapterId != null && requestedChapterId !== ownChapterId) {
    if (!ownChapterId) {
      throw new ConvexError({
        code: "NO_CHAPTER",
        message: "You don't belong to a chapter yet.",
      });
    }
    await requireCentralReach(ctx, ownChapterId);
    return chapterId;
  }
  // Own chapter (or no explicit chapterId at all): the normal transparent-read
  // gate, unchanged.
  if (!(await canViewChapterWork(ctx, chapterId))) return null;
  return chapterId;
}

/**
 * The projects the caller may see, oldest first. Read is transparent: admins
 * and every roster member see the whole chapter's projects, so the org tree and
 * every person's workload page can show the work everyone carries. (Editing
 * still gates on the manager subtree in the mutations below.) A caller with no
 * roster row and no admin rights sees nothing. The frontend assembles the
 * nesting (parent → children) and per-owner grouping itself so one reactive
 * query serves both the Team overview and the per-person workload page.
 *
 * `chapterId` optionally peeks into a DIFFERENT chapter than the caller's own
 * (central reach required — see `resolvePeekChapterId`); absent (or the
 * caller's own chapter) behaves exactly as before.
 */
export const list = query({
  args: {
    chapterId: v.optional(v.id("chapters")),
  },
  handler: async (ctx, args) => {
    const chapterId = await resolvePeekChapterId(ctx, args.chapterId);
    if (!chapterId) return [];
    const visible = await ctx.db
      .query("projects")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .collect();
    // Join each card's collapsed preview: the latest comment, attributed.
    // Author docs are shared across projects (one busy manager comments on
    // many) — fetch each distinct author once, not once per project.
    const lasts = await Promise.all(
      visible.map((p) =>
        ctx.db
          .query("projectComments")
          .withIndex("by_project", (q) => q.eq("projectId", p._id))
          .order("desc")
          .first(),
      ),
    );
    const authorName = new Map<Id<"people">, string | null>();
    for (const last of lasts) {
      if (!last || authorName.has(last.authorPersonId)) continue;
      const author = await ctx.db.get(last.authorPersonId);
      authorName.set(last.authorPersonId, author?.name ?? null);
    }
    // WP-U2 ("the budgets row is the single source of truth"): the card's
    // budget figure reads the budget ROW (via `by_ref`), not the project's
    // own `budgetUsd` field — that field is now only a transition-period
    // MIRROR (see `setBudgetAmount`). No row → no budget entered yet, same as
    // the field being unset.
    const budgetRows = await Promise.all(
      visible.map((p) => getBudgetForRef(ctx, "project", p._id)),
    );
    return visible.map((p, i) => {
      const last = lasts[i];
      const budgetRow = budgetRows[i];
      const budgetUsd =
        budgetRow && budgetRow.amountCents > 0 ? budgetRow.amountCents / 100 : undefined;
      return {
        ...p,
        budgetUsd,
        lastComment: last
          ? {
              body: last.body,
              authorName: authorName.get(last.authorPersonId) ?? null,
              createdAt: last.createdAt,
            }
          : null,
      };
    });
  },
});

/**
 * A single project for its own standalone page — transparent read (admins and
 * any roster member), with `canManage` telling the client whether to render the
 * page editable or read-only, plus the owner + parent names for the header.
 * Null when out of the chapter or the caller can't view chapter work, so a
 * shared link degrades to a calm not-found instead of leaking existence.
 *
 * `chapterId` optionally confirms the caller intends to peek into a project in
 * a DIFFERENT chapter than their own (central reach required — mirrors
 * `resolvePeekChapterId`'s gate above). It must match the project's OWN
 * chapter; passing it for a project that isn't actually in that chapter (or
 * omitting it for a foreign project) degrades to the existing not-found —
 * never leaks existence of a project in some THIRD chapter.
 */
export const get = query({
  args: {
    projectId: v.id("projects"),
    chapterId: v.optional(v.id("chapters")),
  },
  handler: async (ctx, { projectId, chapterId: requestedChapterId }) => {
    const ownChapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    const project = await ctx.db.get(projectId);
    if (!project) return null;
    const targetChapterId = requestedChapterId ?? ownChapterId;
    if (!targetChapterId || project.chapterId !== targetChapterId) return null;

    if (requestedChapterId != null && requestedChapterId !== ownChapterId) {
      if (!ownChapterId) return null;
      await requireCentralReach(ctx, ownChapterId);
    } else if (!(await canViewChapterWork(ctx, project.chapterId))) {
      return null;
    }

    const manageable = await manageablePersonIds(ctx, project.chapterId);
    const owner = await effectiveOwnerId(ctx, project);
    const canManage =
      manageable === null || (owner != null && manageable.has(owner));

    const ownerPerson = project.ownerPersonId
      ? await ctx.db.get(project.ownerPersonId)
      : null;
    const parent = project.parentProjectId
      ? await ctx.db.get(project.parentProjectId)
      : null;
    // WP-U2 ("the budgets row is the single source of truth"): read the
    // budget ROW rather than trusting `project.budgetUsd`, which is now only
    // a transition-period MIRROR (see `setBudgetAmount`).
    const budgetRow = await getBudgetForRef(ctx, "project", projectId);
    const budgetUsd =
      budgetRow && budgetRow.amountCents > 0 ? budgetRow.amountCents / 100 : undefined;

    // Money attribution ("Belongs to"): the project ROW never moves off its
    // home chapter (WP-2.2 finding — see `finances.transferProjectScope`'s doc
    // comment), so the real attribution is wherever its BUDGET currently lives
    // — central, once `transferProjectScope` has moved it, else the project's
    // own home chapter (no budget yet reads the same as "still home"). Central
    // reach to CHANGE it is the caller's own (`ownChapterId`), never the
    // project's — mirrors `transferProjectScope`'s `requireCentralWrite` gate
    // exactly, so this flag never promises an affordance the mutation refuses.
    const scope: FinanceScope = budgetRow ? (budgetRow.chapterId as FinanceScope) : project.chapterId;
    const scopeChapterName =
      scope === "central" ? null : ((await ctx.db.get(scope))?.name ?? null);
    // The project's HOME chapter's name, ALWAYS resolved regardless of the
    // current scope — unlike `scopeChapterName` (null while at Central, by
    // design, for the plain "current location" display), a client toggling
    // between "Central" and "back to my chapter" needs a concrete label for
    // the non-central option even while the project currently sits at
    // Central. Reuses `scopeChapterName` when it already IS the home chapter
    // (the common non-central case) instead of a second lookup.
    const homeChapterName =
      scope !== "central" && scope === project.chapterId
        ? scopeChapterName
        : ((await ctx.db.get(project.chapterId))?.name ?? null);
    const canChangeScope =
      ownChapterId != null && hasCentralWriteReach(await getFinanceRole(ctx, ownChapterId));

    return {
      ...project,
      budgetUsd,
      canManage,
      ownerName: ownerPerson?.name ?? null,
      parentName: parent?.name ?? null,
      scope,
      scopeChapterName,
      homeChapterName,
      canChangeScope,
    };
  },
});

/**
 * A project's comment thread, oldest first — the progression record. Visible
 * to whoever can see the project — transparent to admins and every roster
 * member, matching `list`. Returns NULL when the caller can't view chapter work
 * (no roster row) so denial is never mistaken for an empty thread. Bounded to
 * the latest 200 entries. (Posting still gates on the manager subtree.)
 */
export const comments = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const project = await requireOwned(ctx, "projects", projectId, "Project");
    if (!(await canViewChapterWork(ctx, project.chapterId))) return null;
    const rows = await ctx.db
      .query("projectComments")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .order("desc")
      .take(200);
    rows.reverse(); // oldest first for reading the progression top-down
    const authorName = new Map<Id<"people">, string | null>();
    for (const c of rows) {
      if (authorName.has(c.authorPersonId)) continue;
      const author = await ctx.db.get(c.authorPersonId);
      authorName.set(c.authorPersonId, author?.name ?? null);
    }
    return rows.map((c) => ({
      ...c,
      authorName: authorName.get(c.authorPersonId) ?? null,
    }));
  },
});

/**
 * A project's update log (audit trail), newest first — every field change and
 * the "created" entry, attributed. Transparent read (admins + any roster
 * member), matching `get`/`comments`; null when the caller can't view chapter
 * work. Bounded to the latest 100 entries.
 */
export const updateLog = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    // Resolve gracefully (like `get`): a shared link to a deleted or foreign
    // project must return null, never throw — otherwise this query (mounted
    // unconditionally on the project page) trips the app's error screen.
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return null;
    const project = await ctx.db.get(projectId);
    if (!project || project.chapterId !== chapterId) return null;
    if (!(await canViewChapterWork(ctx, project.chapterId))) return null;
    const rows = await ctx.db
      .query("projectUpdates")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .order("desc")
      .take(100);
    const authorName = new Map<Id<"people">, string | null>();
    for (const r of rows) {
      if (r.authorPersonId == null || authorName.has(r.authorPersonId)) continue;
      const author = await ctx.db.get(r.authorPersonId);
      authorName.set(r.authorPersonId, author?.name ?? null);
    }
    return rows.map((r) => ({
      _id: r._id,
      field: r.field,
      summary: r.summary,
      createdAt: r.createdAt,
      authorName:
        r.authorPersonId != null
          ? authorName.get(r.authorPersonId) ?? null
          : null,
    }));
  },
});

/** Post a comment on a project — the unit of its history. */
export const addComment = mutation({
  args: { projectId: v.id("projects"), body: v.string() },
  handler: async (ctx, { projectId, body }) => {
    const project = await requireOwned(ctx, "projects", projectId, "Project");
    // Anyone on the roster may comment now — same open policy as editing.
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
    const commentId = await ctx.db.insert("projectComments", {
      chapterId: project.chapterId,
      projectId,
      authorPersonId: author._id,
      body: trimmed,
      createdBy: userId as Id<"users">,
      createdAt: Date.now(),
    });
    // Tell the person accountable — a "hey, add an update" left in the thread
    // is useless if they never see it. Never for one's own comment, and only
    // when the owner is reachable by email.
    const ownerId = await effectiveOwnerId(ctx, project);
    if (ownerId && ownerId !== author._id) {
      const owner = await ctx.db.get(ownerId);
      const to = owner?.pwEmail ?? owner?.email;
      if (owner && to) {
        await ctx.scheduler.runAfter(
          0,
          internal.reminders.sendProjectCommentEmail,
          {
            to,
            recipientName: owner.name,
            projectId,
            projectName: project.name,
            authorName: author.name,
            body: trimmed,
          },
        );
      }
    }
    return commentId;
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

// `createProjectBudget` (the create-time budget hook — WP-3.4) now lives in
// `finances.ts` (WP-U), alongside `createEventBudget`, so both "D8 creation
// helpers" are colocated for the "For" picker's summon-on-pick flow. Imported
// above.

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
    blocker: v.optional(v.string()),
    // Money-attribution override for the creation-time scope picker. Omitted
    // by callers that don't show the picker (e.g. a sub-project's "Add
    // sub-project" quick-create) — the default below still applies, so every
    // creation path gets the "creator's highest hat" behavior for free.
    scope: v.optional(projectScopeChoice),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    const userId = await requireUserId(ctx);
    // Open to anyone on the roster (or an admin) — the update log keeps it
    // accountable. Structural checks (owner/parent/event in this chapter) stay.
    const author = await requireProjectEditor(ctx, chapterId as Id<"chapters">);
    if (args.ownerPersonId) {
      await requireOwned(ctx, "people", args.ownerPersonId, "Owner");
    }
    if (args.parentProjectId) {
      await requireOwned(ctx, "projects", args.parentProjectId, "Parent project");
    }
    if (args.eventId) {
      await requireOwned(ctx, "events", args.eventId, "Event");
    }
    const now = Date.now();
    const projectId = await ctx.db.insert("projects", {
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
      blocker: args.blocker,
      createdBy: userId as Id<"users">,
      createdAt: now,
      updatedAt: now,
    });
    // Owner rule ("budgets only exist when money does"): many projects are
    // work-tracking only (time, $0) — only summon a budget object when a
    // positive dollar amount was actually entered. A zero/absent/negative
    // budgetUsd gets no budget at all.
    if (args.budgetUsd != null && args.budgetUsd > 0) {
      await createProjectBudget(
        ctx,
        {
          _id: projectId,
          chapterId: chapterId as Id<"chapters">,
          name: args.name,
          startDate: args.startDate,
          deadline: args.deadline,
          createdAt: now,
          budgetUsd: args.budgetUsd,
        },
        userId as Id<"users">,
      );
    }
    await logProjectUpdate(
      ctx,
      { _id: projectId, chapterId: chapterId as Id<"chapters"> },
      author,
      "created",
      "Created the project",
    );

    // Money attribution ("creator's highest hat" default, owner spec): a
    // caller with central (org-wide) finance reach gets Central by default;
    // re-resolved SERVER-SIDE (never trusts a client-supplied `scope` alone)
    // so an unspecified `scope` still lands correctly for every creation path
    // — not just the one with a picker. The project ROW stays chapter-scoped
    // either way (WP-2.2 finding); "central" here moves its BUDGET, through
    // the SAME `transferProjectScope` retroactive changes use (no second
    // scope-move path). `summonBudgetForRef` first guarantees a (possibly $0)
    // budget row exists — idempotent, so it's a no-op when `createProjectBudget`
    // above already made one — so a LATER dollar entry writes through to the
    // already-central row instead of silently landing back at the chapter.
    const access = await getFinanceRole(ctx, chapterId as Id<"chapters">);
    const canCentral = hasCentralWriteReach(access);
    const effectiveScope = args.scope ?? (canCentral ? "central" : "chapter");
    if (effectiveScope === "central") {
      if (!canCentral) {
        throw new ConvexError({
          code: "FORBIDDEN",
          message: "Only central finance roles can attribute a project to Central.",
        });
      }
      await ctx.runMutation(api.finances.summonBudgetForRef, {
        refKind: "project",
        scopeRefId: projectId,
      });
      await ctx.runMutation(api.finances.transferProjectScope, {
        projectId,
        target: "central",
        note: "Set at creation",
      });
    }
    return projectId;
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
    // Anyone on the roster (or an admin) may edit — accountability comes from
    // the update log below, not from a subtree lock.
    const author = await requireProjectEditor(ctx, project.chapterId);

    // Structural safety still holds: referenced owner/parent/event must be in
    // this chapter, and re-parenting must not create a cycle.
    let newOwner: Doc<"people"> | null = null;
    if (patch.ownerPersonId != null) {
      newOwner = await requireOwned(ctx, "people", patch.ownerPersonId, "Owner");
    }
    let newParent: Doc<"projects"> | null = null;
    if (patch.parentProjectId != null) {
      newParent = await requireOwned(
        ctx,
        "projects",
        patch.parentProjectId,
        "Parent project",
      );
      await assertNoParentCycle(ctx, projectId, patch.parentProjectId);
    }
    if (patch.eventId != null) {
      await requireOwned(ctx, "events", patch.eventId, "Event");
    }

    // Diff the incoming patch against the current row → one audit summary per
    // real change. Computed BEFORE the write so we compare against old values.
    const normText = (v: string | null | undefined): string | undefined => {
      if (v == null) return undefined;
      const t = v.trim();
      return t ? t : undefined;
    };
    const logs: { field: string; summary: string }[] = [];
    if (patch.name !== undefined && patch.name.trim() && patch.name !== project.name) {
      logs.push({ field: "name", summary: `Renamed to "${patch.name.trim()}"` });
    }
    if (patch.status !== undefined && patch.status !== project.status) {
      logs.push({
        field: "status",
        summary: `Status → ${PROJECT_STATUS_LABELS[patch.status]}`,
      });
    }
    if (patch.deadline !== undefined) {
      const next = patch.deadline ?? undefined;
      if (next !== project.deadline) {
        logs.push({
          field: "deadline",
          summary: next != null ? `Deadline set to ${fmtLogDate(next)}` : "Cleared the deadline",
        });
      }
    }
    if (patch.startDate !== undefined) {
      const next = patch.startDate ?? undefined;
      if (next !== project.startDate) {
        logs.push({
          field: "startDate",
          summary: next != null ? `Start date set to ${fmtLogDate(next)}` : "Cleared the start date",
        });
      }
    }
    if (patch.budgetUsd !== undefined) {
      const next = patch.budgetUsd ?? undefined;
      if (next !== project.budgetUsd) {
        logs.push({
          field: "budget",
          summary: next != null ? `Budget set to $${next}` : "Cleared the budget",
        });
      }
    }
    if (patch.purpose !== undefined) {
      const next = normText(patch.purpose);
      if (next !== project.purpose) {
        logs.push({
          field: "purpose",
          summary: next != null ? "Updated the purpose" : "Cleared the purpose",
        });
      }
    }
    if (patch.blocker !== undefined) {
      const next = normText(patch.blocker);
      if (next !== project.blocker) {
        logs.push({
          field: "blocker",
          summary: next != null ? `Flagged a blocker: "${next}"` : "Cleared the blocker",
        });
      }
    }
    if (patch.ownerPersonId !== undefined) {
      const next = patch.ownerPersonId ?? undefined;
      if (next !== project.ownerPersonId) {
        logs.push({
          field: "owner",
          summary: newOwner ? `Owner → ${newOwner.name}` : "Cleared the owner",
        });
      }
    }
    if (patch.parentProjectId !== undefined) {
      const next = patch.parentProjectId ?? undefined;
      if (next !== project.parentProjectId) {
        logs.push({
          field: "parent",
          summary: newParent ? `Moved under "${newParent.name}"` : "Moved to the top level",
        });
      }
    }
    if (patch.eventId !== undefined) {
      const next = patch.eventId ?? undefined;
      if (next !== project.eventId) {
        logs.push({
          field: "event",
          summary: next != null ? "Linked to an event" : "Unlinked the event",
        });
      }
    }

    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      // `budgetUsd` is handled separately below (WP-U2 routes it through the
      // budget row when one exists) — never written here directly.
      if (key === "budgetUsd") continue;
      // null = explicit clear (store undefined); undefined = leave unchanged.
      if (value !== undefined) fields[key] = value === null ? undefined : value;
    }
    // The one-slot `statusNote`/`nextSteps` fields are superseded by the comment
    // thread — never written to the project anymore. Fold any supplied text into
    // one comment (same shape as `foldProjectStatusNotes`), authored by the
    // caller's roster person. Nothing to fold (a bare clear) is a no-op.
    delete fields.statusNote;
    delete fields.nextSteps;
    const noteBody = composeStatusBody(patch.statusNote, patch.nextSteps);
    if (noteBody && author) {
      const userId = await requireUserId(ctx);
      await ctx.db.insert("projectComments", {
        chapterId: project.chapterId,
        projectId,
        authorPersonId: author._id,
        body: noteBody,
        createdBy: userId as Id<"users">,
        createdAt: Date.now(),
      });
    }

    // WP-U2 ("the budgets row is the single source of truth"): once a budget
    // row already exists for this project, an amount edit here writes
    // THROUGH to the row via the shared `setBudgetAmount` helper (also used
    // by the finance-side `updateBudget` edit) — it patches the row's
    // `amountCents` AND mirrors the dollar amount back onto
    // `projects.budgetUsd` in the same call, so the two can never drift
    // apart. `fields.budgetUsd` is only set directly here when there's NO row
    // yet — the D8 trigger below then decides whether this edit is enough
    // money to summon one.
    // WP-3.2: `setBudgetAmount` itself now handles the increase-retrigger (an
    // amount bump past the approved cap on an APPROVED budget auto-resubmits
    // it) — nothing extra to do here, this call site gets it for free.
    let wroteThroughToBudget = false;
    let existingBudget: Awaited<ReturnType<typeof getBudgetForRef>> = null;
    if (patch.budgetUsd !== undefined) {
      existingBudget = await getBudgetForRef(ctx, "project", projectId);
      if (existingBudget) {
        wroteThroughToBudget = true;
      } else {
        // Branch consistency (review fix): the row branch below rejects a
        // negative amount via `setBudgetAmount`'s `assertIntegerCents` —
        // validate the same way here, BEFORE writing straight to the field,
        // so an invalid amount can't slip through just because no row exists
        // yet to catch it.
        const nextCents = patch.budgetUsd != null ? Math.round(patch.budgetUsd * 100) : 0;
        assertIntegerCents(nextCents, "Budget amount");
        fields.budgetUsd = patch.budgetUsd ?? undefined;
      }
    }

    fields.updatedAt = Date.now();
    await ctx.db.patch(projectId, fields);
    if (wroteThroughToBudget && existingBudget) {
      const nextCents = patch.budgetUsd != null ? Math.round(patch.budgetUsd * 100) : 0;
      await setBudgetAmount(ctx, existingBudget._id, nextCents);
    }

    // WP-3.4 edit-path trigger (owner rule: "budgets summoned by dollar
    // entry") — entering a POSITIVE budgetUsd on a project with no row
    // summons one now, same shape/tag as the create-time hook. Review fix:
    // this used to ALSO require the entity's OLD field to have been
    // unset/0/negative (a "transition" guard) — but that compared the
    // incoming amount against the entity's own (possibly already-positive)
    // field, not against "does a row exist." A row-less project whose field
    // was already positive could never re-trigger this once its field was
    // positive — "field set, no row" was a dead state no further edit could
    // heal (see `finances.healRowlessEntityBudgets` for the sweep that heals
    // pre-existing instances). Dropping the old-value condition means ANY
    // positive incoming amount with no existing row summons one,
    // unconditionally. Never reached when `wroteThroughToBudget` is true — a
    // row already existed, so the write above already handled it (no
    // `by_ref` re-check needed: the lookup above already answered "does a
    // budget exist"). Clearing/lowering budgetUsd never deletes an existing
    // budget — money already tracked against it stays; see
    // `removeEmptyAutoBudgets` for the separate ops cleanup of pre-rule
    // zero-amount budgets.
    if (!wroteThroughToBudget && patch.budgetUsd != null && patch.budgetUsd > 0) {
      const budgetUserId = (await requireUserId(ctx)) as Id<"users">;
      await createProjectBudget(
        ctx,
        {
          _id: projectId,
          chapterId: project.chapterId,
          name:
            patch.name !== undefined && patch.name.trim()
              ? patch.name.trim()
              : project.name,
          startDate:
            patch.startDate !== undefined ? (patch.startDate ?? undefined) : project.startDate,
          deadline:
            patch.deadline !== undefined ? (patch.deadline ?? undefined) : project.deadline,
          createdAt: project.createdAt,
          budgetUsd: patch.budgetUsd,
        },
        budgetUserId,
      );
    }

    // Record the audit trail last, so a rejected patch never leaves a log.
    for (const entry of logs) {
      await logProjectUpdate(ctx, project, author, entry.field, entry.summary);
    }
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
    // Deleting stays scoped to the owner's chain + admins — it wipes the
    // project AND its update log, so it isn't part of the open-editing policy.
    const manageable = await manageablePersonIds(ctx, project.chapterId);
    const effOwner = await effectiveOwnerId(ctx, project);
    assertInScope(
      manageable,
      effOwner,
      "Only the owner's manager chain (or an admin) can delete a project.",
    );
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
    // The thread and the update log belong to the project — they go with it.
    // Batched reads so a years-long history can't blow the mutation's limits.
    for (const table of ["projectComments", "projectUpdates"] as const) {
      for (;;) {
        const batch = await ctx.db
          .query(table)
          .withIndex("by_project", (q) => q.eq("projectId", projectId))
          .take(200);
        for (const row of batch) await ctx.db.delete(row._id);
        if (batch.length < 200) break;
      }
    }
    await ctx.db.delete(projectId);
    return projectId;
  },
});
