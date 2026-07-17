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

function buildSubtree(seats: SeatNode[], seat: SeatNode, scope: NodeScope): TreeNode {
  return {
    key: `${scope}:${seat.defId}`,
    seat,
    scope,
    children: childrenOf(seats, seat.slug).map((c) => buildSubtree(seats, c, scope)),
  };
}

/** Build one chart's tree (central-only, or a single chapter's) from its ROOT
 *  seat — every chart has exactly one (`parentSlug === SEAT_ROOT`). `null`
 *  only if the chart hasn't been seeded (defensive; shouldn't happen once the
 *  template migration has run). */
export function buildChartTree(seats: SeatNode[], scope: NodeScope): TreeNode | null {
  const root = seats.find((s) => s.parentSlug === SEAT_ROOT);
  if (!root) return null;
  return buildSubtree(seats, root, scope);
}

/**
 * The FULL tree: the central chart with each chapter's own root+subtree
 * grafted in — vertically stacked as extra children under the seat every
 * chapter's `chapter_director` rolls up into server-side
 * (`CHAPTER_ROLLUP_PARENT`, today `expansion_director`). Every chapter is
 * identical in shape (same shared chapter chart), only occupancy differs.
 */
export function buildFullTree(chart: FullChart): TreeNode | null {
  const centralTree = buildChartTree(chart.central, "central");
  if (!centralTree) return null;

  function graft(node: TreeNode): TreeNode {
    const children = node.children.map(graft);
    if (node.seat.slug === CHAPTER_ROLLUP_PARENT) {
      for (const chapter of chart.chapters) {
        const chapterRoot = buildChartTree(chapter.seats, chapter.chapterId);
        if (chapterRoot) {
          children.push({ ...chapterRoot, chapterLabel: chapter.chapterName });
        }
      }
    }
    return { ...node, children };
  }
  return graft(centralTree);
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
