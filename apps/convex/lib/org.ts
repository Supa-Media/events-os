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
import {
  CHAPTER_ROLLUP_PARENT,
  buildSeatManagerIndex,
  effectiveManagerIds,
  type SeatManagerIndex,
} from "@events-os/shared";

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

/**
 * Read-transparency gate: may the caller SEE the chapter's shared work — the
 * org tree, everyone's projects, duties, and workload? True for chapter admins
 * and for anyone with a real roster row in the chapter. Managing (editing,
 * reassigning, logging 1:1s) stays scoped separately via `manageablePersonIds`;
 * this only opens read access so the whole team can see the workload we carry.
 */
export async function canViewChapterWork(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<boolean> {
  if (await isChapterAdmin(ctx, chapterId)) return true;
  try {
    return (await viewerPerson(ctx, chapterId)) !== null;
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

// ── Seat-derived managers ────────────────────────────────────────────────────
//
// Manager truth is MOVING from `people.managerId` (a hand-set flag) to the org
// chart itself (`seatDefs` + `seatAssignments`) — see `@events-os/shared`'s
// `seatManagers.ts` for the pure walk algorithm, kept in lockstep with the Org
// Chart tab's client-side `computeReportsTo` (`treeUtils.ts` on
// `feat/orgchart-tab`). This is a PHASED, READ-SIDE-ONLY cutover: a person who
// holds ANY seat gets their manager(s) from the seat tree exclusively (never
// falls back, even if that's an empty list — e.g. the executive director);
// a person who holds no seat still falls back to their stored `managerId`, so
// the large majority of the roster (no seat assigned yet) sees no change.
// `people.managerId` is NOT removed or stopped being written here — that's a
// later milestone once the org chart's assignment UI is the primary way
// managers get set.

/** Bounded scan caps for loading the org chart into memory once per read —
 *  the seat taxonomy is small (~30 defs total across both charts) and a
 *  chapter's occupancy is bounded by its roster size, so these are generous
 *  ceilings, not a real limit in practice. */
const SEAT_DEF_SCAN_LIMIT = 500;
const SEAT_ASSIGNMENT_SCAN_LIMIT = 2000;

/** The scope union `seatAssignments.scope` uses — a real chapter id, or the
 *  `"central"` sentinel (mirrors `finances.ts`'s `budgets.chapterId`). */
export type SeatManagerScope = Id<"chapters"> | "central";

/** Load the org chart (both charts' seat defs, plus this chapter's own
 *  occupancy AND every central-chart seat's occupancy) into the pure
 *  `seatManagers` algorithm's index shape. One read per caller per chapter —
 *  cheap relative to the roster/duties reads `overview`/`workload` already do.
 */
export async function loadSeatManagerIndex(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<SeatManagerIndex<Id<"seatDefs">, Id<"people">, SeatManagerScope>> {
  const defs = await ctx.db.query("seatDefs").take(SEAT_DEF_SCAN_LIMIT);
  const seatDefs = defs.map((d) => ({
    seatDefId: d._id,
    chart: d.chart,
    slug: d.slug,
    parentSlug: d.parentSlug,
  }));

  const [centralAssignments, chapterAssignments] = await Promise.all([
    ctx.db
      .query("seatAssignments")
      .withIndex("by_scope", (q) => q.eq("scope", "central"))
      .take(SEAT_ASSIGNMENT_SCAN_LIMIT),
    ctx.db
      .query("seatAssignments")
      .withIndex("by_scope", (q) => q.eq("scope", chapterId))
      .take(SEAT_ASSIGNMENT_SCAN_LIMIT),
  ]);
  const seatAssignments = [...centralAssignments, ...chapterAssignments].map(
    (a) => ({
      seatDefId: a.seatDefId,
      scope: a.scope,
      personId: a.personId,
    }),
  );

  return buildSeatManagerIndex(seatDefs, seatAssignments);
}

/** One person's effective manager ids — seat-derived if they hold any seat,
 *  the stored `managerId` fallback otherwise. See the module header. */
export function personEffectiveManagerIds(
  index: SeatManagerIndex<Id<"seatDefs">, Id<"people">, SeatManagerScope>,
  person: Doc<"people">,
): Id<"people">[] {
  return effectiveManagerIds(
    index,
    person._id,
    person.managerId ?? null,
    "central",
    CHAPTER_ROLLUP_PARENT,
  );
}

/**
 * A manager → direct-reports map layered like `buildChildrenOf`, except each
 * person's manager edge(s) come from `personEffectiveManagerIds` — seat truth
 * first, `managerId` fallback per-person. Unlike `buildChildrenOf`, this can
 * fan a report out under MULTIPLE managers (a multi-holder parent seat), so
 * it's a DAG in that case, not a strict tree — `subtreeNodes`/`subtreeIds`'
 * BFS still terminates correctly over it (already visited-set guarded).
 *
 * A seat-derived manager who isn't in THIS chapter's `roster` (e.g. a
 * central-seat holder who happens to belong to a different chapter) is
 * dropped from the map — there's no chapter-scoped subtree node to hang them
 * on yet. Their `personEffectiveManagerIds` answer is still correct; only the
 * roster-local rollup can't represent them. Read-side derivation only, so
 * their reports still resolve their manager via `personEffectiveManagerIds`
 * directly (see `org.ts`'s `workload`) even though they don't show up here.
 */
export function buildEffectiveChildrenOf(
  index: SeatManagerIndex<Id<"seatDefs">, Id<"people">, SeatManagerScope>,
  roster: Doc<"people">[],
): Map<Id<"people">, Doc<"people">[]> {
  const rosterIds = new Set(roster.map((p) => p._id));
  const childrenOf = new Map<Id<"people">, Doc<"people">[]>();
  for (const p of roster) {
    for (const managerId of personEffectiveManagerIds(index, p)) {
      if (!rosterIds.has(managerId)) continue;
      const list = childrenOf.get(managerId) ?? [];
      list.push(p);
      childrenOf.set(managerId, list);
    }
  }
  return childrenOf;
}

/** The caller's own manager docs, resolved directly by id (not restricted to
 *  the chapter roster — a central-seat manager may live in a different
 *  chapter). Placeholders never count as managers (mirrors `chapterRoster`'s
 *  filter). Order follows `personEffectiveManagerIds`. */
export async function resolveEffectiveManagers(
  ctx: QueryCtx,
  index: SeatManagerIndex<Id<"seatDefs">, Id<"people">, SeatManagerScope>,
  person: Doc<"people">,
): Promise<Doc<"people">[]> {
  const ids = personEffectiveManagerIds(index, person);
  const docs = await Promise.all(ids.map((id) => ctx.db.get(id)));
  return docs.filter(
    (d): d is Doc<"people"> => d !== null && d.isPlaceholder !== true,
  );
}

/** True iff `personId` holds at least one seat (central or this chapter) — a
 *  single cheap indexed read. Being a seat-derived manager of ANYONE requires
 *  holding the ancestor seat that answer comes from, so a person who holds no
 *  seat at all can be ruled out as a seat-only manager without ever loading
 *  the roster or the chart — see `hasEffectiveReports`. */
async function holdsAnySeat(
  ctx: QueryCtx,
  personId: Id<"people">,
): Promise<boolean> {
  const anySeat = await ctx.db
    .query("seatAssignments")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .first();
  return anySeat !== null;
}

/**
 * True iff `personId` manages at least one other person, seat-derived first,
 * `managerId` fallback per-person — the ONE "am I a manager?" check every
 * read surface (`nav.canManage`) and write gate (`requireManagerOrAdmin`)
 * shares, so a seat-only manager is never shown an affordance that then
 * 403s. Built on the SAME `buildEffectiveChildrenOf` `manageablePersonIds`
 * uses — one derivation, several call sites.
 *
 * Cheap path first (a stored `managerId` report — the common case for an
 * established manager). If that's empty, checks whether `personId` holds ANY
 * seat (one more cheap indexed read, see `holdsAnySeat`) before paying for
 * the full roster + org-chart load that a seat-aware answer requires — an
 * ordinary seatless caller with no stored reports (the overwhelming common
 * case, e.g. every plain volunteer) short-circuits to `false` without ever
 * touching the roster or seat tables. This keeps `nav`'s per-screen poll
 * cheap for everyone except an actual seat-holder.
 */
export async function hasEffectiveReports(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
  personId: Id<"people">,
): Promise<boolean> {
  const firstReport = await ctx.db
    .query("people")
    .withIndex("by_manager", (q) => q.eq("managerId", personId))
    .first();
  if (firstReport !== null) return true;

  if (!(await holdsAnySeat(ctx, personId))) return false;

  const [roster, index] = await Promise.all([
    chapterRoster(ctx, chapterId),
    loadSeatManagerIndex(ctx, chapterId),
  ]);
  return (buildEffectiveChildrenOf(index, roster).get(personId) ?? []).length > 0;
}

/**
 * Assert the caller is a manager (has at least one direct report, seat-derived
 * or stored) or a chapter admin. The gate for org-shaping edits: responsibility
 * definitions and the runbook docs they point at.
 */
export async function requireManagerOrAdmin(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<void> {
  if (await isChapterAdmin(ctx, chapterId)) return;
  const viewer = await viewerPerson(ctx, chapterId);
  if (viewer && (await hasEffectiveReports(ctx, chapterId, viewer._id))) return;
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
 *
 * Seat-derived first, `managerId` fallback per-person — the SAME
 * `buildEffectiveChildrenOf` the read surfaces (`org.overview`/`org.workload`)
 * use, so a seat-only manager's WRITE reach (`checkIns.log`, `projects.remove`,
 * event-role reassignment — everything that calls this) never disagrees with
 * what they were just shown they could manage.
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
  const index = await loadSeatManagerIndex(ctx, chapterId);
  return subtreeIds(buildEffectiveChildrenOf(index, people), viewer);
}

/**
 * Whether the CALLER has EDIT rights on `event` — its owner (`ownerPersonId`),
 * anyone who MANAGES that owner through the reporting chain
 * (`manageablePersonIds`, the SAME write-reach `checkIns.log`/
 * `projects.remove`/event-role reassignment already use), or a chapter admin
 * (`manageablePersonIds` returns `null`). Mirrors the `iAmEventOwner` /
 * `iManageEventOwner` pair `events.ts`'s todo-list query already computes
 * inline for "yours vs. overseeing" — extracted here so a WRITE gate outside
 * `events.ts` (e.g. a scoped finance carve-out) can reuse the exact same
 * "who leads this event" definition instead of re-deriving it.
 *
 * An event with NO `ownerPersonId` set has no lead beyond a chapter admin —
 * returns `false` for everyone else, never a throw, so a caller can compose
 * this into a broader OR-gate ("finance role OR event edit rights") without
 * an early exception short-circuiting the other branch.
 */
export async function callerHasEventEditRights(
  ctx: QueryCtx,
  event: Doc<"events">,
): Promise<boolean> {
  const chapterId = event.chapterId as Id<"chapters">;
  const manageable = await manageablePersonIds(ctx, chapterId);
  if (manageable === null) return true; // chapter admin
  const me = await viewerPerson(ctx, chapterId);
  if (!me || !event.ownerPersonId) return false;
  if (String(event.ownerPersonId) === String(me._id)) return true; // the owner themself
  return manageable.has(event.ownerPersonId as Id<"people">); // manages the owner
}
