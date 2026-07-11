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
import { ConvexError } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";
import { requireUserId, getChapterIdOrNull } from "./context";
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
  return people.filter(
    (p) => p.isPlaceholder !== true && p.isSamplePerson !== true,
  );
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
 * Assert the caller is a manager (has at least one direct report) or a
 * chapter admin. The gate for org-shaping edits: responsibility definitions
 * and the runbook docs they point at.
 */
export async function requireManagerOrAdmin(
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
    message: "Only managers and admins can do this.",
  });
}

/**
 * The chain-above read policy for 1:1 records, resolved once: who the record
 * is about, the roster, the caller's row, and their reach. Returns null when
 * the caller may NOT read this person's record — out of chapter, out of
 * subtree, or (for non-admins) the person IS the caller: the log is the
 * managerial record about someone, never readable by its subject.
 */
export async function readableCheckInSubject(
  ctx: QueryCtx,
  personId: Id<"people">,
): Promise<{
  person: Doc<"people">;
  roster: Doc<"people">[];
  viewer: Doc<"people"> | null;
  manageable: Set<Id<"people">> | null;
} | null> {
  const chapterId = await getChapterIdOrNull(ctx);
  if (!chapterId) return null;
  const person = await ctx.db.get(personId);
  if (!person || person.chapterId !== chapterId) return null;
  const roster = await chapterRoster(ctx, person.chapterId);
  const viewer = await viewerFromRoster(ctx, roster);
  const manageable = await manageablePersonIds(ctx, person.chapterId, roster);
  if (manageable !== null) {
    if (!manageable.has(personId)) return null;
    if (viewer?._id === personId) return null;
  }
  return { person, roster, viewer, manageable };
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
