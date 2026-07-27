/**
 * Service Catalog CRUD — the managed dropdown behind `people.serviceIds` (see
 * `schema/services.ts`'s module doc). Every mutation here calls
 * `requireManageServiceCatalog` (`lib/servicesAccess.ts`) — no inline
 * membership checks anywhere in this file, per CLAUDE.md's "Gate It Behind a
 * Power, Even When It's Open Today".
 *
 * SCOPE: every option is either org-wide (`chapterId` absent — shared by
 * every chapter) or chapter-local (`chapterId` set). `list` reads the union
 * for the caller's chapter; `create` takes an explicit `scope` (defaulting to
 * `"central"` — that's what the founder is actually curating today);
 * `rename`/`setActive`/`merge` derive the scope to check FROM THE OPTION
 * ITSELF (`optionScope`), never from the caller's own chapter — editing a
 * chapter-local option always requires being in THAT chapter, regardless of
 * where the caller happens to sit.
 */
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireChapterId } from "./lib/context";
import { listActiveChapters } from "./lib/chapters";
import { requireManageServiceCatalog, type ServiceCatalogScope } from "./lib/servicesAccess";
import type { AudienceCondition, AudienceGroup, AudienceTargeting } from "./lib/audienceTargeting";

/** Generous bound over the catalog at ONE scope (~47 org-wide canonical rows,
 *  or a chapter's own local additions) — every read/write in this file scans
 *  a whole scope's rows rather than paginating, since it will never
 *  realistically approach this cap. */
const CATALOG_SCAN_LIMIT = 1000;
/** Bound on the roster scan `list`'s usage counts and `merge`'s per-chapter
 *  person-repoint walk — matches
 *  `lib/audienceTargeting.ts#PEOPLE_PER_CHAPTER_LIMIT` (same table, same
 *  chapter-scale reasoning). */
const PEOPLE_SCAN_LIMIT = 2000;
/** Bound on `merge`'s deployment-wide audience scan — a `has_service`
 *  condition can reference any org-wide or chapter-local option, and central
 *  campaigns' audiences aren't chapter-scoped, so this can't be narrowed.
 *  Mirrors migration 0042's `PENDING_CAMPAIGNS_CAP` scale reasoning —
 *  campaigns/audiences are a low-volume table. */
const AUDIENCE_SCAN_LIMIT = 2000;
/** Bound on the chapter fan-out `merge` walks for a CENTRAL (org-wide) merge
 *  — one bounded `by_chapter` people scan per chapter, matching
 *  `lib/audienceTargeting.ts#targetingDonorScopes`'s central fan-out. */
const CHAPTERS_SCAN_LIMIT = 500;

const RESERVED_CHARS = /[:,]/;

function normalizeAndValidateName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new ConvexError({ code: "INVALID_NAME", message: "Name can't be empty." });
  }
  if (RESERVED_CHARS.test(trimmed)) {
    throw new ConvexError({
      code: "INVALID_NAME",
      message: 'Name can\'t contain ":" or ",".',
    });
  }
  return trimmed;
}

/** The scope a row actually lives at — `schema/services.ts`'s convention
 *  (absent `chapterId` = org-wide). */
function optionScope(row: Doc<"serviceOptions">): ServiceCatalogScope {
  return row.chapterId ?? "central";
}

/** Every `serviceOptions` row AT exactly `scope` (not a union — callers that
 *  need "everything visible to a chapter" combine `loadScopeOptions(ctx,
 *  "central")` with `loadScopeOptions(ctx, chapterId)` themselves, e.g.
 *  `list`). */
async function loadScopeOptions(
  ctx: QueryCtx,
  scope: ServiceCatalogScope,
): Promise<Doc<"serviceOptions">[]> {
  const chapterId = scope === "central" ? undefined : scope;
  return await ctx.db
    .query("serviceOptions")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(CATALOG_SCAN_LIMIT);
}

/** Reject a sibling (same `parentId`, same SCOPE) whose name matches
 *  case-insensitively/trimmed — regardless of active state, so a rename/create
 *  can never collide with a soft-deleted option either. Duplicate checking is
 *  scope-siloed: a chapter-local option may share a name with an org-wide one
 *  (they're different entities; not asked to prevent that). */
async function assertNoDuplicateSibling(
  ctx: MutationCtx,
  scope: ServiceCatalogScope,
  parentId: Id<"serviceOptions"> | undefined,
  name: string,
  excludeId?: Id<"serviceOptions">,
): Promise<void> {
  const rows = await loadScopeOptions(ctx, scope);
  const target = name.toLowerCase();
  const dup = rows.find(
    (r) =>
      r._id !== excludeId &&
      (r.parentId ?? undefined) === (parentId ?? undefined) &&
      r.name.trim().toLowerCase() === target,
  );
  if (dup) {
    throw new ConvexError({
      code: "DUPLICATE_NAME",
      message: `"${name}" already exists ${parentId ? "under this parent" : "at the top level"}.`,
    });
  }
}

async function usageCounts(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<Map<Id<"serviceOptions">, number>> {
  const people = await ctx.db
    .query("people")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(PEOPLE_SCAN_LIMIT);
  const counts = new Map<Id<"serviceOptions">, number>();
  for (const p of people) {
    for (const id of p.serviceIds ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

const serviceOptionOut = v.object({
  _id: v.id("serviceOptions"),
  name: v.string(),
  label: v.string(),
  isActive: v.boolean(),
  sortOrder: v.optional(v.number()),
  usageCount: v.number(),
  // Whether this row is org-wide or belongs to the caller's own chapter —
  // the picker/management screen needs this to label/gate rows differently
  // (e.g. "shared across every chapter" vs "local to your chapter").
  isCentral: v.boolean(),
});

/**
 * Options VISIBLE to the caller's chapter: every org-wide option UNION that
 * chapter's own local additions, parents with their children nested — the
 * picker's data source. `includeInactive: true` also returns soft-deleted
 * rows (the catalog MANAGEMENT screen's view, as opposed to the picker).
 * Deactivating a PARENT hides its children too, applied HERE at read time
 * (never by mutating the children — see `schema/services.ts`'s doc), so
 * `includeInactive` is the only way to see a child whose parent is inactive.
 * A parent/child pair always shares one scope (enforced at create time), so
 * nesting is unambiguous even though the combined list spans two scopes.
 */
export const list = query({
  args: { includeInactive: v.optional(v.boolean()) },
  returns: v.array(
    v.object({
      ...serviceOptionOut.fields,
      children: v.array(serviceOptionOut),
    }),
  ),
  handler: async (ctx, { includeInactive }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const [central, local] = await Promise.all([
      loadScopeOptions(ctx, "central"),
      loadScopeOptions(ctx, chapterId),
    ]);
    const rows = [...central, ...local];
    const counts = await usageCounts(ctx, chapterId);

    const childrenByParent = new Map<Id<"serviceOptions">, Doc<"serviceOptions">[]>();
    for (const row of rows) {
      if (!row.parentId) continue;
      const list = childrenByParent.get(row.parentId);
      if (list) list.push(row);
      else childrenByParent.set(row.parentId, [row]);
    }

    const parents = rows
      .filter((r) => !r.parentId)
      .filter((r) => includeInactive || r.isActive !== false)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

    return parents.map((parent) => {
      const children = (childrenByParent.get(parent._id) ?? [])
        .filter((c) => includeInactive || c.isActive !== false)
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
        .map((c) => ({
          _id: c._id,
          name: c.name,
          label: `${parent.name}:${c.name}`,
          isActive: c.isActive !== false,
          sortOrder: c.sortOrder,
          usageCount: counts.get(c._id) ?? 0,
          isCentral: c.chapterId === undefined,
        }));
      return {
        _id: parent._id,
        name: parent.name,
        label: parent.name,
        isActive: parent.isActive !== false,
        sortOrder: parent.sortOrder,
        usageCount: counts.get(parent._id) ?? 0,
        isCentral: parent.chapterId === undefined,
        children,
      };
    });
  },
});

/** Add a new top-level option or a child under an existing top-level option
 *  (one level of nesting only — a `parentId` that itself has a parent is
 *  rejected). `scope` picks org-wide (default) or the caller's own chapter —
 *  a parent and its new child must share the SAME scope. */
export const create = mutation({
  args: {
    name: v.string(),
    parentId: v.optional(v.id("serviceOptions")),
    // Defaults to "central" (org-wide) — that's what the founder is actually
    // curating today. Pass the caller's own chapter id for a chapter-local
    // addition; any other chapter is rejected.
    scope: v.optional(v.union(v.id("chapters"), v.literal("central"))),
  },
  returns: v.id("serviceOptions"),
  handler: async (ctx, { name, parentId, scope }) => {
    const callerChapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const targetScope: ServiceCatalogScope = scope ?? "central";
    if (targetScope !== "central" && targetScope !== callerChapterId) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "You can only add a local option to your own chapter.",
      });
    }
    await requireManageServiceCatalog(ctx, targetScope);
    const trimmed = normalizeAndValidateName(name);

    if (parentId) {
      const parent = await ctx.db.get(parentId);
      if (!parent || optionScope(parent) !== targetScope) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "Parent option not found at this scope.",
        });
      }
      if (parent.parentId) {
        throw new ConvexError({
          code: "TOO_DEEP",
          message:
            "A service option can only be nested one level — pick a top-level option as the parent.",
        });
      }
    }

    await assertNoDuplicateSibling(ctx, targetScope, parentId, trimmed);
    const siblingCount = (await loadScopeOptions(ctx, targetScope)).filter(
      (r) => (r.parentId ?? undefined) === (parentId ?? undefined),
    ).length;

    return await ctx.db.insert("serviceOptions", {
      chapterId: targetScope === "central" ? undefined : targetScope,
      parentId,
      name: trimmed,
      sortOrder: siblingCount,
      isActive: true,
      createdAt: Date.now(),
    });
  },
});

/** Rename an option in place. Propagates automatically to every
 *  `people.serviceIds` reference (and every saved `has_service` condition)
 *  since they hold the id, never the name. Access is gated on the OPTION'S
 *  own scope — renaming an org-wide option is checked against `"central"`,
 *  not the caller's own chapter. */
export const rename = mutation({
  args: { serviceOptionId: v.id("serviceOptions"), name: v.string() },
  returns: v.null(),
  handler: async (ctx, { serviceOptionId, name }) => {
    const row = await ctx.db.get(serviceOptionId);
    if (!row) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Service option not found." });
    }
    const scope = optionScope(row);
    await requireManageServiceCatalog(ctx, scope);
    const trimmed = normalizeAndValidateName(name);
    await assertNoDuplicateSibling(ctx, scope, row.parentId, trimmed, serviceOptionId);
    await ctx.db.patch(serviceOptionId, { name: trimmed });
    return null;
  },
});

/** Soft delete/restore. Deactivating a PARENT hides its children from the
 *  picker too, but only at READ time in `list` — children are never
 *  themselves patched. Access is gated on the option's own scope (see
 *  `rename`'s doc). */
export const setActive = mutation({
  args: { serviceOptionId: v.id("serviceOptions"), isActive: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { serviceOptionId, isActive }) => {
    const row = await ctx.db.get(serviceOptionId);
    if (!row) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Service option not found." });
    }
    await requireManageServiceCatalog(ctx, optionScope(row));
    await ctx.db.patch(serviceOptionId, { isActive });
    return null;
  },
});

/** Repoint every `has_service` condition in one targeting group that
 *  references `fromId` onto `toId`. Pure, returns a new group only when it
 *  actually changed something (so the caller can skip a no-op patch). */
function repointGroupConditions(
  group: AudienceGroup,
  fromId: Id<"serviceOptions">,
  toId: Id<"serviceOptions">,
): { group: AudienceGroup; changed: boolean } {
  let changed = false;
  const conditions: AudienceCondition[] = group.conditions.map((c) => {
    if (c.field === "has_service" && c.serviceId === fromId) {
      changed = true;
      return { ...c, serviceId: toId };
    }
    return c;
  });
  return changed ? { group: { ...group, conditions }, changed } : { group, changed };
}

/** Repoint every `has_service` condition across a whole `targeting` block
 *  (both include and exclude groups). Used by `merge` — see its doc. */
function repointHasServiceConditions(
  targeting: AudienceTargeting,
  fromId: Id<"serviceOptions">,
  toId: Id<"serviceOptions">,
): { targeting: AudienceTargeting; changed: boolean } {
  let changed = false;
  const groups = targeting.groups.map((g) => {
    const r = repointGroupConditions(g, fromId, toId);
    if (r.changed) changed = true;
    return r.group;
  });
  const excludeGroups = targeting.excludeGroups?.map((g) => {
    const r = repointGroupConditions(g, fromId, toId);
    if (r.changed) changed = true;
    return r.group;
  });
  if (!changed) return { targeting, changed: false };
  return {
    targeting: { ...targeting, groups, ...(excludeGroups ? { excludeGroups } : {}) },
    changed: true,
  };
}

/** The chapters whose roster `merge` must repoint: every active chapter for
 *  a CENTRAL (org-wide) merge, or just the one chapter for a local merge —
 *  mirrors `lib/audienceTargeting.ts#targetingDonorScopes`'s central fan-out
 *  shape. Bounded by `CHAPTERS_SCAN_LIMIT` via `listActiveChapters`. */
async function scopeChapterIds(
  ctx: QueryCtx,
  scope: ServiceCatalogScope,
): Promise<Id<"chapters">[]> {
  if (scope !== "central") return [scope];
  const chapters = await listActiveChapters(ctx);
  return chapters.map((c) => c._id);
}

/**
 * Fold `fromId` into `toId`: repoint every referencing `people.serviceIds`
 * (deduping — a person already carrying both collapses to one entry) and
 * every saved `has_service` audience condition, then soft-delete `fromId`.
 * NEVER hard-deletes — see `schema/services.ts`'s module doc. Models the
 * FK-repointing shape on `dataHygiene.ts#mergePeople` (repoint everything,
 * THEN retire the loser). Both options must be at the SAME scope (both
 * org-wide, or both the same chapter) — merging across scopes would leave
 * one chapter's roster referencing an option no longer visible to it.
 */
export const merge = mutation({
  args: { fromId: v.id("serviceOptions"), toId: v.id("serviceOptions") },
  returns: v.object({ peopleRepointed: v.number(), audiencesRepointed: v.number() }),
  handler: async (ctx, { fromId, toId }) => {
    if (fromId === toId) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Pick two different options to merge.",
      });
    }
    const from = await ctx.db.get(fromId);
    const to = await ctx.db.get(toId);
    if (!from || !to) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Service option not found." });
    }
    const fromScope = optionScope(from);
    const toScope = optionScope(to);
    if (fromScope !== toScope) {
      throw new ConvexError({
        code: "SCOPE_MISMATCH",
        message: "Both options must be at the same scope (both org-wide, or both the same chapter) to merge.",
      });
    }
    await requireManageServiceCatalog(ctx, fromScope);

    // 1) Repoint every person carrying `fromId` (every active chapter's
    // roster for a central merge; just the one chapter for a local merge),
    // deduping.
    let peopleRepointed = 0;
    for (const chapterId of await scopeChapterIds(ctx, fromScope)) {
      const people = await ctx.db
        .query("people")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
        .take(PEOPLE_SCAN_LIMIT);
      for (const person of people) {
        const ids = person.serviceIds;
        if (!ids || !ids.includes(fromId)) continue;
        const deduped = new Set(ids.filter((id) => id !== fromId));
        deduped.add(toId);
        await ctx.db.patch(person._id, { serviceIds: [...deduped] });
        peopleRepointed++;
      }
    }

    // 2) Repoint saved `has_service` audience conditions referencing
    // `fromId` — deployment-wide (see AUDIENCE_SCAN_LIMIT's doc above).
    let audiencesRepointed = 0;
    const audiences = await ctx.db.query("audiences").take(AUDIENCE_SCAN_LIMIT);
    for (const audience of audiences) {
      if (!audience.targeting) continue;
      const result = repointHasServiceConditions(audience.targeting, fromId, toId);
      if (result.changed) {
        await ctx.db.patch(audience._id, { targeting: result.targeting });
        audiencesRepointed++;
      }
    }

    // 3) Soft-delete the merged-away option.
    await ctx.db.patch(fromId, { isActive: false });

    return { peopleRepointed, audiencesRepointed };
  },
});
