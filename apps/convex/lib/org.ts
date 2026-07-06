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
 * True iff the caller administers THIS chapter: a superuser email, or a
 * `userChapters` membership in this chapter with an admin-grade role.
 * (Production onboarding assigns "member"; the chapter creator gets "lead".)
 */
export async function isChapterAdmin(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<boolean> {
  if (await isSuperuser(ctx)) return true;
  try {
    const userId = await requireUserId(ctx);
    const membership = await ctx.db
      .query("userChapters")
      .withIndex("by_userId_chapterId", (q) =>
        q.eq("userId", userId as Id<"users">).eq("chapterId", chapterId),
      )
      .first();
    return membership?.role != null && ADMIN_ROLES.has(membership.role);
  } catch {
    return false;
  }
}

/** The caller's own roster row in this chapter (people.userId link), or null.
 *  Placeholder rows never count — they're event-scoped stand-ins, and letting
 *  one act as "self" would disagree with every roster-derived surface. */
export async function viewerPerson(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<Doc<"people"> | null> {
  const userId = await requireUserId(ctx);
  const rows = await ctx.db
    .query("people")
    .withIndex("by_user", (q) => q.eq("userId", userId as Id<"users">))
    .collect();
  return (
    rows.find((p) => p.chapterId === chapterId && p.isPlaceholder !== true) ??
    null
  );
}

/** Find the caller's roster row in an already-loaded roster (no extra reads). */
export async function viewerFromRoster(
  ctx: QueryCtx,
  roster: Doc<"people">[],
): Promise<Doc<"people"> | null> {
  const userId = await requireUserId(ctx);
  return roster.find((p) => p.userId === userId) ?? null;
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
 * BFS the manager tree from `root` (inclusive), children name-sorted, each
 * node tagged with its depth. The one traversal every org surface derives
 * from. Visited-set guarded so a (theoretically impossible) cycle can't hang.
 */
export function subtreeNodes(
  childrenOf: Map<Id<"people">, Doc<"people">[]>,
  root: Doc<"people">,
): { person: Doc<"people">; depth: number }[] {
  const byName = (a: Doc<"people">, b: Doc<"people">) =>
    a.name.localeCompare(b.name);
  const nodes: { person: Doc<"people">; depth: number }[] = [];
  const visited = new Set<Id<"people">>([root._id]);
  const queue: { person: Doc<"people">; depth: number }[] = [
    { person: root, depth: 0 },
  ];
  while (queue.length > 0) {
    const node = queue.shift()!;
    nodes.push(node);
    for (const child of (childrenOf.get(node.person._id) ?? []).sort(byName)) {
      if (visited.has(child._id)) continue;
      visited.add(child._id);
      queue.push({ person: child, depth: node.depth + 1 });
    }
  }
  return nodes;
}

/** Every person id at-or-below `root` in the manager tree (root included). */
export function subtreeIds(
  childrenOf: Map<Id<"people">, Doc<"people">[]>,
  root: Doc<"people">,
): Set<Id<"people">> {
  return new Set(subtreeNodes(childrenOf, root).map((n) => n.person._id));
}

/**
 * The person ids whose work the caller may see/manage: the whole chapter for
 * admins (returned as null, meaning "no restriction"), the caller's subtree if
 * they're on the roster, or the empty set. Pass `roster` when the caller
 * already loaded it, to avoid a second chapter-wide read.
 */
export async function manageablePersonIds(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  roster?: Doc<"people">[],
): Promise<Set<Id<"people">> | null> {
  if (await isChapterAdmin(ctx, chapterId)) return null;
  const people = roster ?? (await chapterRoster(ctx, chapterId));
  const viewer = await viewerFromRoster(ctx, people);
  if (!viewer) return new Set();
  return subtreeIds(buildChildrenOf(people), viewer);
}
