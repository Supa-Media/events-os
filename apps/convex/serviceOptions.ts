/**
 * Service Catalog CRUD — the managed dropdown behind `people.serviceIds` (see
 * `schema/services.ts`'s module doc). Every mutation here calls
 * `requireManageServiceCatalog` (`lib/servicesAccess.ts`) — no inline
 * membership checks anywhere in this file, per CLAUDE.md's "Gate It Behind a
 * Power, Even When It's Open Today".
 */
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireChapterId } from "./lib/context";
import { requireManageServiceCatalog } from "./lib/servicesAccess";
import type { AudienceCondition, AudienceGroup, AudienceTargeting } from "./lib/audienceTargeting";

/** Generous bound over a chapter's own catalog (~47 canonical rows + any
 *  chapter-specific additions) — every read/write in this file scans the
 *  WHOLE chapter catalog rather than paginating, since it will never
 *  realistically approach this cap. */
const CATALOG_SCAN_LIMIT = 1000;
/** Bound on the roster scan `list`'s usage counts and `merge`'s person
 *  repoint walk — matches `lib/audienceTargeting.ts#PEOPLE_PER_CHAPTER_LIMIT`
 *  (same table, same chapter-scale reasoning). */
const PEOPLE_SCAN_LIMIT = 2000;
/** Bound on `merge`'s deployment-wide audience scan — a central-scoped
 *  audience's `has_service` condition can reference ANY chapter's catalog
 *  row (the schema has no scoping of its own beyond the id), so this can't
 *  be narrowed to one chapter. Mirrors migration 0042's `PENDING_CAMPAIGNS_CAP`
 *  scale reasoning — campaigns/audiences are a low-volume table. */
const AUDIENCE_SCAN_LIMIT = 2000;

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

async function loadChapterOptions(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<Doc<"serviceOptions">[]> {
  return await ctx.db
    .query("serviceOptions")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(CATALOG_SCAN_LIMIT);
}

/** Reject a sibling (same `parentId`, same chapter) whose name matches
 *  case-insensitively/trimmed — regardless of active state, so a rename/create
 *  can never collide with a soft-deleted option either. */
async function assertNoDuplicateSibling(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  parentId: Id<"serviceOptions"> | undefined,
  name: string,
  excludeId?: Id<"serviceOptions">,
): Promise<void> {
  const rows = await loadChapterOptions(ctx, chapterId);
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
});

/**
 * Active options for the caller's chapter, parents with their children
 * nested — the picker's data source. `includeInactive: true` also returns
 * soft-deleted rows (the catalog MANAGEMENT screen's view, as opposed to the
 * picker). Deactivating a PARENT hides its children too, applied HERE at read
 * time (never by mutating the children — see `schema/services.ts`'s doc), so
 * `includeInactive` is the only way to see a child whose parent is inactive.
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
    const rows = await loadChapterOptions(ctx, chapterId);
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
        }));
      return {
        _id: parent._id,
        name: parent.name,
        label: parent.name,
        isActive: parent.isActive !== false,
        sortOrder: parent.sortOrder,
        usageCount: counts.get(parent._id) ?? 0,
        children,
      };
    });
  },
});

/** Add a new top-level option or a child under an existing top-level option
 *  (one level of nesting only — a `parentId` that itself has a parent is
 *  rejected). */
export const create = mutation({
  args: { name: v.string(), parentId: v.optional(v.id("serviceOptions")) },
  returns: v.id("serviceOptions"),
  handler: async (ctx, { name, parentId }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireManageServiceCatalog(ctx, chapterId);
    const trimmed = normalizeAndValidateName(name);

    if (parentId) {
      const parent = await ctx.db.get(parentId);
      if (!parent || parent.chapterId !== chapterId) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "Parent option not found in your chapter.",
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

    await assertNoDuplicateSibling(ctx, chapterId, parentId, trimmed);
    const siblingCount = (await loadChapterOptions(ctx, chapterId)).filter(
      (r) => (r.parentId ?? undefined) === (parentId ?? undefined),
    ).length;

    return await ctx.db.insert("serviceOptions", {
      chapterId,
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
 *  since they hold the id, never the name. */
export const rename = mutation({
  args: { serviceOptionId: v.id("serviceOptions"), name: v.string() },
  returns: v.null(),
  handler: async (ctx, { serviceOptionId, name }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireManageServiceCatalog(ctx, chapterId);
    const row = await ctx.db.get(serviceOptionId);
    if (!row || row.chapterId !== chapterId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Service option not found in your chapter.",
      });
    }
    const trimmed = normalizeAndValidateName(name);
    await assertNoDuplicateSibling(ctx, chapterId, row.parentId, trimmed, serviceOptionId);
    await ctx.db.patch(serviceOptionId, { name: trimmed });
    return null;
  },
});

/** Soft delete/restore. Deactivating a PARENT hides its children from the
 *  picker too, but only at READ time in `list` — children are never
 *  themselves patched. */
export const setActive = mutation({
  args: { serviceOptionId: v.id("serviceOptions"), isActive: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { serviceOptionId, isActive }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireManageServiceCatalog(ctx, chapterId);
    const row = await ctx.db.get(serviceOptionId);
    if (!row || row.chapterId !== chapterId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Service option not found in your chapter.",
      });
    }
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

/**
 * Fold `fromId` into `toId`: repoint every referencing `people.serviceIds`
 * (deduping — a person already carrying both collapses to one entry) and
 * every saved `has_service` audience condition, then soft-delete `fromId`.
 * NEVER hard-deletes — see `schema/services.ts`'s module doc. Models the
 * FK-repointing shape on `dataHygiene.ts#mergePeople` (repoint everything,
 * THEN retire the loser).
 */
export const merge = mutation({
  args: { fromId: v.id("serviceOptions"), toId: v.id("serviceOptions") },
  returns: v.object({ peopleRepointed: v.number(), audiencesRepointed: v.number() }),
  handler: async (ctx, { fromId, toId }) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireManageServiceCatalog(ctx, chapterId);
    if (fromId === toId) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Pick two different options to merge.",
      });
    }
    const from = await ctx.db.get(fromId);
    const to = await ctx.db.get(toId);
    if (!from || from.chapterId !== chapterId || !to || to.chapterId !== chapterId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Both options must belong to your chapter.",
      });
    }

    // 1) Repoint every person in this chapter carrying `fromId`, deduping.
    let peopleRepointed = 0;
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
