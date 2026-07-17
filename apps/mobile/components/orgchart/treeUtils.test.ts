// No @types/jest / ambient globals configured for this package (the only
// prior test file is plain JS) — import test globals explicitly from
// @jest/globals (ships with jest itself) instead of adding a new dependency.
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { CHAPTER_ROLLUP_PARENT, SEAT_ROOT } from "@events-os/shared";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  buildChartTree,
  buildFullTree,
  computeReportsTo,
  findNodeByKey,
  findOrphanSeats,
  subtreeDepth,
  subtreeSlugs,
  type ChartHolder,
  type FullChart,
  type SeatNode,
  type TreeNode,
} from "./treeUtils";

// ── fixtures ─────────────────────────────────────────────────────────────────

function holder(personId: string, name: string): ChartHolder {
  return { personId: personId as Id<"people">, name, imageUrl: null };
}

function seat(overrides: Partial<SeatNode> & { slug: string; parentSlug: string }): SeatNode {
  return {
    defId: overrides.slug as unknown as Id<"seatDefs">,
    title: overrides.slug,
    maxHolders: 1,
    derived: false,
    sortOrder: 0,
    holders: [],
    vacant: true,
    ...overrides,
  };
}

/** A small well-formed chart: root -> [a, b, c], `a` has a child `a1`, which
 *  itself has a child `a1x` (depth 2 below `a`). */
function wellFormedSeats(): SeatNode[] {
  return [
    seat({ slug: "root-seat", parentSlug: SEAT_ROOT, title: "Director", sortOrder: 0 }),
    seat({ slug: "a", parentSlug: "root-seat", sortOrder: 0 }),
    seat({ slug: "b", parentSlug: "root-seat", sortOrder: 1 }),
    seat({ slug: "c", parentSlug: "root-seat", sortOrder: 2 }),
    seat({ slug: "a1", parentSlug: "a", sortOrder: 0 }),
    seat({ slug: "a1x", parentSlug: "a1", sortOrder: 0 }),
  ];
}

let warnSpy: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

// ── buildChartTree / buildSubtree ───────────────────────────────────────────

describe("buildChartTree", () => {
  test("assembles a flat seat list into a parent->child tree, sorted by sortOrder", () => {
    const { root, orphans } = buildChartTree(wellFormedSeats(), "central");
    expect(orphans).toEqual([]);
    expect(root?.seat.slug).toBe("root-seat");
    expect(root?.children.map((c) => c.seat.slug)).toEqual(["a", "b", "c"]);

    const a = root?.children[0];
    expect(a?.children.map((c) => c.seat.slug)).toEqual(["a1"]);
    expect(a?.children[0].children.map((c) => c.seat.slug)).toEqual(["a1x"]);
    expect(a?.children[0].children[0].children).toEqual([]);
  });

  test("scopes every node's key and NodeScope to the caller-provided scope", () => {
    const chapterId = "chapter-1" as Id<"chapters">;
    const { root } = buildChartTree(wellFormedSeats(), chapterId);
    expect(root?.scope).toBe(chapterId);
    expect(root?.key).toBe(`${chapterId}:${root?.seat.defId}`);
    expect(root?.children[0].scope).toBe(chapterId);
  });

  test("returns a null root when there's no seat with parentSlug === SEAT_ROOT", () => {
    const { root, orphans } = buildChartTree(
      [seat({ slug: "a", parentSlug: "nonexistent" })],
      "central",
    );
    expect(root).toBeNull();
    // `a`'s parentSlug doesn't resolve to anything (no root, no other seat) — orphaned.
    expect(orphans.map((o) => o.seat.slug)).toEqual(["a"]);
  });

  test("bounds recursion against a cyclic parentSlug chain instead of hanging", () => {
    // root-seat -> x -> y -> x' -> y -> x' -> ... `childrenOf` matches by
    // parentSlug STRING, so a second seat re-using slug "x" (parentSlug "y")
    // makes `y` and this second "x" mutually recurse forever without a guard.
    const seats: SeatNode[] = [
      seat({ slug: "root-seat", parentSlug: SEAT_ROOT }),
      seat({ slug: "x", parentSlug: "root-seat" }),
      seat({ slug: "y", parentSlug: "x" }),
      { ...seat({ slug: "x", parentSlug: "y" }), defId: "x2" as unknown as Id<"seatDefs"> },
    ];

    const start = Date.now();
    const { root } = buildChartTree(seats, "central");
    expect(Date.now() - start).toBeLessThan(2000); // didn't hang
    expect(root?.seat.slug).toBe("root-seat");
    expect(warnSpy).toHaveBeenCalled();
  });
});

// ── findOrphanSeats ──────────────────────────────────────────────────────────

describe("findOrphanSeats", () => {
  test("a well-formed chart has no orphans", () => {
    expect(findOrphanSeats(wellFormedSeats())).toEqual([]);
  });

  test("flags a seat whose parentSlug matches nothing in the chart", () => {
    const seats = [
      ...wellFormedSeats(),
      seat({ slug: "ghost", parentSlug: "does-not-exist", title: "Ghost Seat" }),
    ];
    const orphans = findOrphanSeats(seats);
    expect(orphans.map((s) => s.slug)).toEqual(["ghost"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test("flags a whole disconnected/cyclic sub-graph, not just its entry point", () => {
    const seats = [
      ...wellFormedSeats(),
      seat({ slug: "island-1", parentSlug: "island-2" }),
      seat({ slug: "island-2", parentSlug: "island-1" }),
    ];
    const orphans = findOrphanSeats(seats).map((s) => s.slug).sort();
    expect(orphans).toEqual(["island-1", "island-2"]);
  });

  test("doesn't hang on a cycle reachable from the root (visited-set guard)", () => {
    // Same construction as buildChartTree's cycle test: a duplicate "x" slug
    // makes `y` <-> the duplicate "x" mutually recurse in a naive walk.
    const seats: SeatNode[] = [
      seat({ slug: "root-seat", parentSlug: SEAT_ROOT }),
      seat({ slug: "x", parentSlug: "root-seat" }),
      seat({ slug: "y", parentSlug: "x" }),
      { ...seat({ slug: "x", parentSlug: "y" }), defId: "x2" as unknown as Id<"seatDefs"> },
    ];
    const start = Date.now();
    const orphans = findOrphanSeats(seats);
    expect(Date.now() - start).toBeLessThan(2000);
    // Every seat is reachable from root (the visited SET dedupes the
    // revisit rather than treating it as a second orphaned "x") — none orphaned.
    expect(orphans).toEqual([]);
  });
});

// ── buildFullTree (graft) ────────────────────────────────────────────────────

function fullChartFixture(): FullChart {
  const central: SeatNode[] = [
    seat({ slug: "root-seat", parentSlug: SEAT_ROOT, title: "President" }),
    seat({
      slug: CHAPTER_ROLLUP_PARENT,
      parentSlug: "root-seat",
      title: "Expansion Director",
    }),
    seat({ slug: "cfo", parentSlug: "root-seat", title: "CFO" }),
    // An orphan in the central chart too, to prove buildFullTree pools it.
    seat({ slug: "central-ghost", parentSlug: "missing" }),
  ];
  const chapterSeats: SeatNode[] = [
    seat({ slug: "chapter_director", parentSlug: SEAT_ROOT, title: "Chapter Director" }),
    seat({ slug: "treasurer", parentSlug: "chapter_director", title: "Treasurer" }),
    // A chapter-local orphan.
    seat({ slug: "chapter-ghost", parentSlug: "missing-in-chapter" }),
  ];
  return {
    kind: "full",
    central,
    chapters: [
      {
        chapterId: "chapter-1" as Id<"chapters">,
        chapterName: "Downtown",
        seats: chapterSeats,
      },
    ],
  };
}

describe("buildFullTree", () => {
  test("grafts each chapter's subtree under CHAPTER_ROLLUP_PARENT", () => {
    const { root } = buildFullTree(fullChartFixture());
    const rollupNode = root?.children.find((c) => c.seat.slug === CHAPTER_ROLLUP_PARENT);
    expect(rollupNode).toBeDefined();
    expect(rollupNode?.children).toHaveLength(1);
    expect(rollupNode?.children[0].seat.slug).toBe("chapter_director");
    expect(rollupNode?.children[0].chapterLabel).toBe("Downtown");
    expect(rollupNode?.children[0].scope).toBe("chapter-1");
  });

  test("pools orphans across the central chart and every chapter", () => {
    const { orphans } = buildFullTree(fullChartFixture());
    const slugs = orphans.map((o) => o.seat.slug).sort();
    expect(slugs).toEqual(["central-ghost", "chapter-ghost"]);
  });
});

// ── subtreeDepth ─────────────────────────────────────────────────────────────

describe("subtreeDepth", () => {
  test("0 for a leaf node", () => {
    const leaf: TreeNode = { key: "k", seat: seat({ slug: "x", parentSlug: "y" }), scope: "central", children: [] };
    expect(subtreeDepth(leaf)).toBe(0);
  });

  test("increments by 1 per nested level, taking the deepest branch", () => {
    const { root } = buildChartTree(wellFormedSeats(), "central");
    const a = root?.children.find((c) => c.seat.slug === "a");
    const b = root?.children.find((c) => c.seat.slug === "b");
    expect(subtreeDepth(a as TreeNode)).toBe(2); // a -> a1 -> a1x
    expect(subtreeDepth(b as TreeNode)).toBe(0); // leaf
  });
});

// ── subtreeSlugs ─────────────────────────────────────────────────────────────

describe("subtreeSlugs", () => {
  test("includes the root slug itself plus every descendant, excludes siblings/ancestors", () => {
    const slugs = subtreeSlugs(wellFormedSeats(), "a");
    expect([...slugs].sort()).toEqual(["a", "a1", "a1x"]);
  });

  test("a leaf's subtree is just itself", () => {
    expect(subtreeSlugs(wellFormedSeats(), "b")).toEqual(new Set(["b"]));
  });

  test("the chart root's subtree is every seat", () => {
    const slugs = subtreeSlugs(wellFormedSeats(), "root-seat");
    expect([...slugs].sort()).toEqual(["a", "a1", "a1x", "b", "c", "root-seat"]);
  });

  test("bounds recursion against a cyclic parentSlug chain instead of hanging", () => {
    const seats: SeatNode[] = [
      seat({ slug: "root-seat", parentSlug: SEAT_ROOT }),
      seat({ slug: "x", parentSlug: "root-seat" }),
      seat({ slug: "y", parentSlug: "x" }),
      { ...seat({ slug: "x", parentSlug: "y" }), defId: "x2" as unknown as Id<"seatDefs"> },
    ];
    const start = Date.now();
    subtreeSlugs(seats, "root-seat");
    expect(Date.now() - start).toBeLessThan(2000); // didn't hang
  });
});

// ── findNodeByKey ────────────────────────────────────────────────────────────

describe("findNodeByKey", () => {
  test("finds a node nested in the tree", () => {
    const { root } = buildChartTree(wellFormedSeats(), "central");
    const found = findNodeByKey(root, [], `central:a1x`);
    expect(found?.seat.slug).toBe("a1x");
  });

  test("finds a node in the orphans list", () => {
    const orphanNode: TreeNode = {
      key: "central:orphan:ghost",
      seat: seat({ slug: "ghost", parentSlug: "missing" }),
      scope: "central",
      children: [],
    };
    expect(findNodeByKey(null, [orphanNode], "central:orphan:ghost")).toBe(orphanNode);
  });

  test("returns null for a missing key or a null key", () => {
    const { root } = buildChartTree(wellFormedSeats(), "central");
    expect(findNodeByKey(root, [], "central:does-not-exist")).toBeNull();
    expect(findNodeByKey(root, [], null)).toBeNull();
  });
});

// ── computeReportsTo ─────────────────────────────────────────────────────────

describe("computeReportsTo", () => {
  test("skips a vacant ancestor and reports to the next holder-bearing one", () => {
    const central: SeatNode[] = [
      seat({ slug: "root-seat", parentSlug: SEAT_ROOT, holders: [holder("p1", "Pat")], vacant: false }),
      seat({ slug: "vp", parentSlug: "root-seat", holders: [], vacant: true }), // vacant
      seat({ slug: "lead", parentSlug: "vp", holders: [holder("p2", "Lee")], vacant: false }),
    ];
    const chart: FullChart = { kind: "full", central, chapters: [] };
    const leadSeat = central.find((s) => s.slug === "lead") as SeatNode;
    const result = computeReportsTo(leadSeat, "central", chart);
    expect(result?.seatTitle).toBe(central.find((s) => s.slug === "root-seat")?.title);
    expect(result?.holders.map((h) => h.personId)).toEqual(["p1"]);
  });

  test("skips an ancestor held by exactly the same person as the SELECTED seat (self-skip)", () => {
    const central: SeatNode[] = [
      seat({ slug: "root-seat", parentSlug: SEAT_ROOT, holders: [holder("p1", "Pat")], vacant: false }),
      // Same person (p2) as `lead` (the seat we're computing reports-to FOR)
      // also sits here — one person legitimately holding two boxes, so this
      // isn't a genuine "reports to a different person" and must be skipped.
      seat({ slug: "vp", parentSlug: "root-seat", holders: [holder("p2", "Lee")], vacant: false }),
      seat({ slug: "lead", parentSlug: "vp", holders: [holder("p2", "Lee")], vacant: false }),
    ];
    const chart: FullChart = { kind: "full", central, chapters: [] };
    const leadSeat = central.find((s) => s.slug === "lead") as SeatNode;
    const result = computeReportsTo(leadSeat, "central", chart);
    // Skips `vp` (same holder, p2) and lands on root-seat (p1 — a genuinely
    // different holder).
    expect(result?.seatTitle).toBe(central.find((s) => s.slug === "root-seat")?.title);
    expect(result?.holders.map((h) => h.personId)).toEqual(["p1"]);
  });

  test("jumps from a chapter's root to CHAPTER_ROLLUP_PARENT in central", () => {
    const central: SeatNode[] = [
      seat({ slug: "root-seat", parentSlug: SEAT_ROOT, holders: [], vacant: true }),
      seat({
        slug: CHAPTER_ROLLUP_PARENT,
        parentSlug: "root-seat",
        holders: [holder("p3", "Sam")],
        vacant: false,
      }),
    ];
    const chapterSeats: SeatNode[] = [
      seat({
        slug: "chapter_director",
        parentSlug: SEAT_ROOT,
        holders: [holder("p4", "Jo")],
        vacant: false,
      }),
    ];
    const chapterId = "chapter-1" as Id<"chapters">;
    const chart: FullChart = {
      kind: "full",
      central,
      chapters: [{ chapterId, chapterName: "Downtown", seats: chapterSeats }],
    };
    const directorSeat = chapterSeats[0];
    const result = computeReportsTo(directorSeat, chapterId, chart);
    expect(result?.scopeLabel).toBe("Central");
    expect(result?.seatTitle).toBe(CHAPTER_ROLLUP_PARENT);
    expect(result?.holders.map((h) => h.personId)).toEqual(["p3"]);
  });

  test("returns null at the true top of the org", () => {
    const central: SeatNode[] = [
      seat({ slug: "root-seat", parentSlug: SEAT_ROOT, holders: [holder("p1", "Pat")], vacant: false }),
    ];
    const chart: FullChart = { kind: "full", central, chapters: [] };
    expect(computeReportsTo(central[0], "central", chart)).toBeNull();
  });
});
