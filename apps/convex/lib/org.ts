/**
 * Org-hierarchy access helpers.
 *
 * The manager tree (people.managerId) carries authority: a manager may see and
 * manage the workload of their subtree — themselves and everyone below them —
 * and nothing beyond it. Chapter ADMINS (the superuser allowlist, plus
 * memberships with role "admin"/"lead") see the whole chapter and are the only
 * ones who may rewire the tree itself (the Manager column). All of it enforced
 * here on the server — UI hiding is purely cosmetic.
 */
import { Doc, Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";
import { requireUserId } from "./context";
import { isSuperuser } from "./superuser";

/** Membership roles that carry chapter-admin authority. */
const ADMIN_ROLES = new Set(["admin", "lead"]);

/**
 * True iff the caller administers the chapter: a superuser email, or a
 * `userChapters` membership with an admin-grade role. (Production onboarding
 * assigns "member"; the chapter creator gets "lead".)
 */
export async function isChapterAdmin(ctx: QueryCtx): Promise<boolean> {
  if (await isSuperuser(ctx)) return true;
  try {
    const userId = await requireUserId(ctx);
    const membership = await ctx.db
      .query("userChapters")
      .withIndex("by_userId", (q) => q.eq("userId", userId as Id<"users">))
      .first();
    return membership?.role != null && ADMIN_ROLES.has(membership.role);
  } catch {
    return false;
  }
}

/** The caller's own roster row in this chapter (people.userId link), or null. */
export async function viewerPerson(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<Doc<"people"> | null> {
  const userId = await requireUserId(ctx);
  const rows = await ctx.db
    .query("people")
    .withIndex("by_user", (q) => q.eq("userId", userId as Id<"users">))
    .collect();
  return rows.find((p) => p.chapterId === chapterId) ?? null;
}

/** The non-placeholder roster of a chapter. */
export async function chapterRoster(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<Doc<"people">[]> {
  const people = await ctx.db
    .query("people")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .collect();
  return people.filter((p) => p.isPlaceholder !== true);
}

/** Group a roster into a manager → direct-reports map. */
export function buildChildrenOf(
  roster: Doc<"people">[],
): Map<Id<"people">, Doc<"people">[]> {
  const childrenOf = new Map<Id<"people">, Doc<"people">[]>();
  for (const p of roster) {
    if (!p.managerId) continue;
    const list = childrenOf.get(p.managerId) ?? [];
    list.push(p);
    childrenOf.set(p.managerId, list);
  }
  return childrenOf;
}

/**
 * Every person id at-or-below `rootId` in the manager tree (root included).
 * Visited-set guarded so a (theoretically impossible) cycle can't hang.
 */
export function subtreeIds(
  childrenOf: Map<Id<"people">, Doc<"people">[]>,
  rootId: Id<"people">,
): Set<Id<"people">> {
  const ids = new Set<Id<"people">>([rootId]);
  const queue: Id<"people">[] = [rootId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const child of childrenOf.get(cur) ?? []) {
      if (ids.has(child._id)) continue;
      ids.add(child._id);
      queue.push(child._id);
    }
  }
  return ids;
}

/**
 * The person ids whose work the caller may see/manage: the whole chapter for
 * admins (returned as null, meaning "no restriction"), the caller's subtree if
 * they're on the roster, or the empty set.
 */
export async function manageablePersonIds(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<Set<Id<"people">> | null> {
  if (await isChapterAdmin(ctx)) return null;
  const viewer = await viewerPerson(ctx, chapterId);
  if (!viewer) return new Set();
  const roster = await chapterRoster(ctx, chapterId);
  return subtreeIds(buildChildrenOf(roster), viewer._id);
}
