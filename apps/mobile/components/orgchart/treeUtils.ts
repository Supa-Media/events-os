/**
 * Org Chart tab — pure client-side tree/rollup helpers over `seats.chart`'s
 * FLAT seat-node lists. Kept dependency-free from React so the tree-building
 * and "reports to" logic is easy to reason about (and test) on its own.
 *
 * The screen fetches `seats.chart({})` (the FULL payload — central seats plus
 * every chapter's subtree) exactly once, then builds whichever scope view the
 * caller has selected (central / one chapter / full) locally from that same
 * result — switching scope pills never re-queries. This is also why the
 * chapter scope PILLS come from the chart query's own chapter enumeration
 * (`chart.chapters`), not a separate `chapters.list` call.
 */
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { CHAPTER_ROLLUP_PARENT, SEAT_ROOT } from "@events-os/shared";

export type ChartResult = FunctionReturnType<typeof api.seats.chart>;
export type FullChart = Extract<ChartResult, { kind: "full" }>;
export type SeatNode = FullChart["central"][number];
export type ChapterSubtree = FullChart["chapters"][number];
export type ChartHolder = SeatNode["holders"][number];

export type SeatDetail = Extract<
  FunctionReturnType<typeof api.seats.seatDetail>,
  { defId: unknown }
>;

/** The `scope` arg a node's own `seatDetail`/holders resolve against —
 *  `"central"` or a specific chapter id. Never a chapter-agnostic sentinel:
 *  even a node grafted into the FULL tree under a chapter keeps ITS chapter's
 *  real id here, so its detail query and "reports to" walk both stay correct. */
export type NodeScope = "central" | Id<"chapters">;

export type TreeNode = {
  /** Unique across an entire rendered tree (a chapter's chart is the SAME
   *  seatDefs shared across chapters, so `defId` alone collides — scope makes
   *  it unique, and doubles as the seatDetail query's own scope arg). */
  key: string;
  seat: SeatNode;
  scope: NodeScope;
  /** Set only on a chapter's root box when grafted into the FULL tree (WP:
   *  every chapter subtree is identical in shape, so this is the one visual
   *  cue distinguishing which chapter a grafted branch belongs to). */
  chapterLabel?: string;
  children: TreeNode[];
};

function childrenOf(seats: SeatNode[], parentSlug: string): SeatNode[] {
  return seats
    .filter((s) => s.parentSlug === parentSlug)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Bounds `buildSubtree`/`graft`'s recursion — mirrors `computeReportsTo`'s
 *  bounded ancestor walk (`guard < 30`). The shared taxonomy is acyclic
 *  today, but a future DB-editable chart (structure edits) could introduce a
 *  cyclic `parentSlug` chain; without a cap that hangs/stack-overflows the
 *  render pass instead of degrading. */
const MAX_TREE_DEPTH = 30;

function buildSubtree(seats: SeatNode[], seat: SeatNode, scope: NodeScope, depth = 0): TreeNode {
  if (depth >= MAX_TREE_DEPTH) {
    console.warn(
      `[org-chart] Seat tree exceeded max depth (${MAX_TREE_DEPTH}) below "${seat.slug}" — likely a cyclic parentSlug chain. Truncating.`,
    );
    return { key: `${scope}:${seat.defId}`, seat, scope, children: [] };
  }
  return {
    key: `${scope}:${seat.defId}`,
    seat,
    scope,
    children: childrenOf(seats, seat.slug).map((c) => buildSubtree(seats, c, scope, depth + 1)),
  };
}

/**
 * Seats present in the payload but never reached by `buildSubtree`'s
 * parent→child walk from the chart's root — a dangling `parentSlug` (points
 * at a slug that doesn't exist in this chart) OR a whole disconnected/cyclic
 * sub-graph. Real scenario: a partially-applied structure edit can
 * transiently leave a seat pointing at a slug that no longer exists.
 * Cycle-safe (tracks visited slugs instead of counting depth) since a
 * disconnected cycle should still surface every seat in it as orphaned, not
 * just the first.
 */
export function findOrphanSeats(seats: SeatNode[]): SeatNode[] {
  const root = seats.find((s) => s.parentSlug === SEAT_ROOT);
  const visited = new Set<string>();
  if (root) {
    const stack = [root.slug];
    while (stack.length > 0) {
      const slug = stack.pop() as string;
      if (visited.has(slug)) continue; // cycle guard
      visited.add(slug);
      for (const child of childrenOf(seats, slug)) stack.push(child.slug);
    }
  }
  const orphans = seats.filter((s) => !visited.has(s.slug));
  if (orphans.length > 0) {
    console.warn(
      `[org-chart] ${orphans.length} orphaned seat(s) not reachable from the chart root: ${orphans
        .map((s) => `${s.slug} (parentSlug="${s.parentSlug}")`)
        .join(", ")}`,
    );
  }
  return orphans;
}

/**
 * Every slug in the subtree rooted at `rootSlug` — INCLUDING `rootSlug`
 * itself. Used to filter a seat's own descendants out of reparent candidate
 * lists (`org-chart.tsx`'s `chartSeatOptions`): moving a seat under one of
 * its own descendants is always a cycle, which the backend already rejects,
 * but there's no reason to present those as clickable "Move" options.
 * Depth-bounded the same way `buildSubtree` is, for the same reason (a
 * future DB-editable chart could introduce a cyclic `parentSlug` chain).
 */
export function subtreeSlugs(seats: SeatNode[], rootSlug: string, depth = 0): Set<string> {
  const result = new Set<string>([rootSlug]);
  if (depth >= MAX_TREE_DEPTH) return result;
  for (const child of childrenOf(seats, rootSlug)) {
    for (const slug of subtreeSlugs(seats, child.slug, depth + 1)) result.add(slug);
  }
  return result;
}

/** A built chart: the tree rooted at the chart's root seat, plus any
 *  `findOrphanSeats` couldn't place — rendered by the caller as a flat
 *  "Unplaced" strip instead of being silently dropped (see `OrgTree`). */
export type ChartBuild = {
  root: TreeNode | null;
  orphans: TreeNode[];
};

/** Build one chart's tree (central-only, or a single chapter's) from its ROOT
 *  seat — every chart has exactly one (`parentSlug === SEAT_ROOT`). `root` is
 *  `null` only if the chart hasn't been seeded (defensive; shouldn't happen
 *  once the template migration has run). */
export function buildChartTree(seats: SeatNode[], scope: NodeScope): ChartBuild {
  const orphans: TreeNode[] = findOrphanSeats(seats).map((seat) => ({
    key: `${scope}:orphan:${seat.defId}`,
    seat,
    scope,
    children: [],
  }));
  const root = seats.find((s) => s.parentSlug === SEAT_ROOT);
  if (!root) return { root: null, orphans };
  return { root: buildSubtree(seats, root, scope), orphans };
}

/**
 * The FULL tree: the central chart with each chapter's own root+subtree
 * grafted in — vertically stacked as extra children under the seat every
 * chapter's `chapter_director` rolls up into server-side
 * (`CHAPTER_ROLLUP_PARENT`, today `expansion_director`). Every chapter is
 * identical in shape (same shared chapter chart), only occupancy differs.
 * Orphans are pooled across the central chart AND every chapter.
 */
export function buildFullTree(chart: FullChart): ChartBuild {
  const centralBuild = buildChartTree(chart.central, "central");
  if (!centralBuild.root) return centralBuild;

  const orphans: TreeNode[] = [...centralBuild.orphans];

  function graft(node: TreeNode, depth = 0): TreeNode {
    if (depth >= MAX_TREE_DEPTH) {
      console.warn(
        `[org-chart] Chapter graft exceeded max depth (${MAX_TREE_DEPTH}) at "${node.seat.slug}" — truncating.`,
      );
      return node;
    }
    const children = node.children.map((c) => graft(c, depth + 1));
    if (node.seat.slug === CHAPTER_ROLLUP_PARENT) {
      for (const chapter of chart.chapters) {
        const chapterBuild = buildChartTree(chapter.seats, chapter.chapterId);
        orphans.push(...chapterBuild.orphans);
        if (chapterBuild.root) {
          children.push({ ...chapterBuild.root, chapterLabel: chapter.chapterName });
        }
      }
    }
    return { ...node, children };
  }
  const root = graft(centralBuild.root);
  return { root, orphans };
}

/** Depth of the subtree hanging below `node` — 0 if it's a leaf, else
 *  1 + the deepest child. Used by `OrgTree`'s first-level connector to
 *  compute a column's true rendered width (`SEAT_BOX_WIDTH` plus one
 *  indent-gutter per nested level below it) instead of assuming every
 *  first-level column is the same fixed width. */
export function subtreeDepth(node: TreeNode): number {
  if (node.children.length === 0) return 0;
  return 1 + Math.max(...node.children.map(subtreeDepth));
}

/**
 * Live lookup of a `TreeNode` by its `key`, searching the built tree plus any
 * "Unplaced" orphans. Lets the caller hold only a `key` string in component
 * state and re-resolve the actual node from the CURRENT `chart` query result
 * on every render, rather than holding a `TreeNode` snapshot captured at
 * click time that goes stale if a holder changes while the panel is open.
 */
export function findNodeByKey(
  root: TreeNode | null,
  orphans: TreeNode[],
  key: string | null,
): TreeNode | null {
  if (!key) return null;
  function walk(node: TreeNode): TreeNode | null {
    if (node.key === key) return node;
    for (const child of node.children) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  }
  if (root) {
    const found = walk(root);
    if (found) return found;
  }
  return orphans.find((o) => o.key === key) ?? null;
}

// ── "Reports to" ─────────────────────────────────────────────────────────────

export type ReportsTo = {
  scopeLabel: string;
  seatTitle: string;
  holders: ChartHolder[];
} | null;

/**
 * The nearest ancestor seat with holders NOT fully identical to this seat's
 * own holders — walking up `parentSlug`, skipping vacant seats and seats held
 * by exactly the same person(s) (normal in this org: one person often sits in
 * several boxes). A chapter chart's ROOT (`chapter_director`) has no parent
 * within its own chart — once exhausted, the walk jumps to the CENTRAL
 * rollup-parent seat (`expansion_director`), mirroring the server's
 * chapter→central rollup. Returns `null` at the true top of the org (central
 * root) or if every ancestor is vacant/same-person all the way up.
 *
 * Deliberately UNFILTERED by `@events-os/shared`'s manager-graph seniority
 * filter (see `seatManagers.ts`'s "SENIORITY FILTER — BLANKET BY DESIGN"
 * section) — this is a per-SEAT "who's the next box up" walk, always a real
 * tree by construction (a seat has exactly one ancestor chain), so it can't
 * cycle in the first place and doesn't need any filtering. The Work tab and
 * every write gate (`checkIns.log`, `responsibilities.*`) read the
 * SENIORITY-FILTERED per-PERSON hierarchy instead, which — by owner decision
 * (2026-07-17, see `seatManagers.ts`) — drops a seat-derived manager edge
 * whenever the manager isn't more senior than the person OVERALL, not just
 * when the edge is part of a literal cycle. That covers two shapes:
 *
 *  - A genuine 2+-node cycle between multi-seat holders (e.g. an ED who also
 *    holds a chapter's `chapter_director` seat, paired with someone whose
 *    chapter seat rolls back up to the ED) — resolved by seniority so exactly
 *    one direction survives.
 *  - A "senior multi-hat" person: someone who holds one senior, unrelated
 *    seat (e.g. a central Development Director) AND a junior chapter seat
 *    whose real structural manager is someone LESS senior overall (e.g. that
 *    chapter's Event Lead). That manager edge is real and non-cyclic, but is
 *    still dropped — the owner ruled that a "technically lower" manager
 *    should not gain 1:1/check-in authority over someone senior elsewhere.
 *
 * So this panel and the Work tab/write gates can legitimately show DIFFERENT
 * "reports to" answers for either shape: this panel always shows the nearest
 * differently-held ancestor seat for the box being viewed; the Work tab shows
 * only the seniority-filtered subset of that person's seat-derived edges.
 */
export function computeReportsTo(
  node: SeatNode,
  scope: NodeScope,
  chart: FullChart,
): ReportsTo {
  const ownHolderIds = new Set(node.holders.map((h) => h.personId));

  const listFor = (s: NodeScope): SeatNode[] =>
    s === "central" ? chart.central : (chart.chapters.find((c) => c.chapterId === s)?.seats ?? []);
  const nameFor = (s: NodeScope): string =>
    s === "central" ? "Central" : (chart.chapters.find((c) => c.chapterId === s)?.chapterName ?? "Chapter");

  let scopeCursor: NodeScope = scope;
  let slugCursor = node.parentSlug;

  // Bounded walk — the shared taxonomy is acyclic (see seats.test.ts), but this
  // guards against a future DB-editable chart accidentally introducing a loop.
  for (let guard = 0; guard < 30; guard++) {
    if (slugCursor === SEAT_ROOT) {
      if (scopeCursor === "central") return null; // top of the org
      scopeCursor = "central";
      slugCursor = CHAPTER_ROLLUP_PARENT;
      continue;
    }
    const parent = listFor(scopeCursor).find((s) => s.slug === slugCursor);
    if (!parent) return null;
    const newHolders = parent.holders.filter((h) => !ownHolderIds.has(h.personId));
    if (newHolders.length > 0) {
      // Show ALL of the parent's holders (not just the "new" ones) — a
      // multi-holder parent's full roster is what "reports to" means here.
      return { scopeLabel: nameFor(scopeCursor), seatTitle: parent.title, holders: parent.holders };
    }
    slugCursor = parent.parentSlug;
  }
  return null;
}

// ── Capabilities → plain language ───────────────────────────────────────────
/** Owner-approved plain-language gloss for each seat capability id, shown as
 *  a "Powers" chip on the seat detail panel. */
export const CAPABILITY_LABELS: Record<string, string> = {
  "finance.approve": "Approve budgets",
  "finance.record": "Record & reconcile money",
  "finance.central": "See every chapter's money",
  "finance.accounts": "Open the Accounts tab",
  "finance.manager": "Manage chapter finances",
  "nav.finances": "Finances tab",
  "org.editChart": "Edit the org chart",
  // Giving desk (F-6) — the assignable giving power's three capabilities.
  "giving.view": "See donors & giving",
  "giving.manage": "Manage donors & gifts",
  "nav.giving": "Giving desk tab",
  // Campaigns desk (two-party approval, 2026-07-24) — the assignable
  // campaign power's two capabilities.
  "campaigns.compose": "Compose email campaigns",
  "campaigns.approve": "Approve email campaigns",
};

export function capabilityLabel(id: string): string {
  return CAPABILITY_LABELS[id] ?? id;
}

/**
 * A derived seat's holder name carries a `"Name (Chapter)"` suffix (see
 * `seats.ts`'s `resolvePerson`) so the rollup reads clearly as text — but
 * `Avatar`'s initials algorithm would otherwise take the chapter name's
 * first letter instead of the person's last name. Strip a trailing
 * `" (...)"` annotation before handing a holder's name to `Avatar`.
 */
export function avatarNameFor(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, "");
}
