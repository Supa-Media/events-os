// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors `forPicker.test.ts`).
import { describe, expect, test } from "@jest/globals";
import {
  HIDEABLE_COLUMNS,
  groupSegments,
  nextSortState,
  offerableColumns,
  parseGroupBy,
  parseHiddenColumns,
  parseSortDir,
  parseSortKey,
  serializeHiddenColumns,
  showsCategoryColumn,
  toggleHiddenColumn,
  type GroupSummary,
} from "./gridView";

const g = (
  key: string,
  count: number,
  progress?: { explainable: number; explained: number },
): GroupSummary => ({
  key,
  label: key,
  // Month bands carry none; only a person band does.
  imageUrl: null,
  count,
  totalCents: -100 * count,
  // Defaults to "every row explainable, none explained" so a segment test
  // that doesn't care about progress still builds a group whose band would
  // RENDER one — a default of 0 explainable would silently exercise the
  // hidden-progress branch instead.
  explainableCount: progress?.explainable ?? count,
  explainableCents: 100 * (progress?.explainable ?? count),
  explainedCount: progress?.explained ?? 0,
  explainedCents: 100 * (progress?.explained ?? 0),
  // ALL LIVE by default, no backlog — so the fixture exercises the ordinary
  // single-population band rather than silently turning on the live/backlog
  // split in every segment test that doesn't care about it. `live + backlog
  // === total` holds, which is the invariant the server guarantees.
  liveExplainableCount: progress?.explainable ?? count,
  liveExplainableCents: 100 * (progress?.explainable ?? count),
  liveExplainedCount: progress?.explained ?? 0,
  liveExplainedCents: 100 * (progress?.explained ?? 0),
  backlogExplainableCount: 0,
  backlogExplainableCents: 0,
  backlogExplainedCount: 0,
  backlogExplainedCents: 0,
});

describe("URL param parsing", () => {
  test("sort key: only `amount` moves off the default", () => {
    expect(parseSortKey("amount")).toBe("amount");
    expect(parseSortKey("date")).toBe("date");
    expect(parseSortKey(undefined)).toBe("date");
    expect(parseSortKey("")).toBe("date");
    expect(parseSortKey("AMOUNT")).toBe("date");
    expect(parseSortKey("merchant")).toBe("date");
  });

  test("direction: only `asc` moves off the default", () => {
    expect(parseSortDir("asc")).toBe("asc");
    expect(parseSortDir("desc")).toBe("desc");
    expect(parseSortDir(undefined)).toBe("desc");
    expect(parseSortDir("sideways")).toBe("desc");
  });

  test("group: unknown values mean no grouping, never a throw", () => {
    expect(parseGroupBy("month")).toBe("month");
    expect(parseGroupBy("person")).toBe("person");
    expect(parseGroupBy(undefined)).toBeNull();
    expect(parseGroupBy("")).toBeNull();
    expect(parseGroupBy("week")).toBeNull();
  });
});

describe("column visibility — `?cols=` is the HIDDEN set", () => {
  test("nothing hidden is the default, and no param says so", () => {
    expect(parseHiddenColumns(undefined)).toEqual([]);
    expect(parseHiddenColumns(null)).toEqual([]);
    expect(parseHiddenColumns("")).toEqual([]);
    expect(serializeHiddenColumns([])).toBe("");
  });

  test("a real selection round-trips", () => {
    expect(parseHiddenColumns("cardholder,category")).toEqual([
      "cardholder",
      "category",
    ]);
    expect(serializeHiddenColumns(["cardholder", "category"])).toBe(
      "cardholder,category",
    );
  });

  test("unknown column names are dropped, never thrown on", () => {
    // A column that never existed, one renamed away, and a typo.
    expect(parseHiddenColumns("fund")).toEqual([]);
    expect(parseHiddenColumns("budget,link")).toEqual([]);
    expect(parseHiddenColumns("cardholder,fund")).toEqual(["cardholder"]);
    // Exact match only, mirroring `parseSortKey("AMOUNT")` → the default.
    expect(parseHiddenColumns("CARDHOLDER")).toEqual([]);
  });

  test("the columns that CANNOT be hidden are not hideable through the URL", () => {
    // Selection, the row's identity, and the way into a row's record. Asked
    // for by name in a hand-written link, they still come back visible.
    expect(parseHiddenColumns("check,merchant,actions")).toEqual([]);
    expect(parseHiddenColumns("merchant,status")).toEqual(["status"]);
  });

  test("garbage never throws and never hides anything", () => {
    for (const junk of [
      ",",
      ",,,",
      "   ",
      "%%%",
      "cardholder;category",
      "[object Object]",
      '{"cols":["date"]}',
      "-1",
      "cardholder".repeat(500),
    ]) {
      expect(() => parseHiddenColumns(junk)).not.toThrow();
      expect(parseHiddenColumns(junk)).toEqual([]);
    }
  });

  test("blanks and duplicates collapse; order is canonical, not click order", () => {
    expect(parseHiddenColumns(" cardholder , , category ")).toEqual([
      "cardholder",
      "category",
    ]);
    expect(parseHiddenColumns("cardholder,cardholder")).toEqual(["cardholder"]);
    // Grid order (Cardholder sits left of Category), whichever way it's written
    // — so two people who hid the same two columns share the same link.
    expect(parseHiddenColumns("category,cardholder")).toEqual([
      "cardholder",
      "category",
    ]);
    expect(serializeHiddenColumns(["status", "date"])).toBe("date,status");
  });

  test("toggling adds, removes, and stays canonically ordered", () => {
    expect(toggleHiddenColumn([], "category")).toEqual(["category"]);
    expect(toggleHiddenColumn(["category"], "category")).toEqual([]);
    // Added out of order; comes back in grid order.
    expect(toggleHiddenColumn(["status"], "date")).toEqual(["date", "status"]);
    // The input is never mutated — the screen holds it in state.
    const hidden = ["status"] as const;
    toggleHiddenColumn(hidden, "date");
    expect(hidden).toEqual(["status"]);
  });

  test("every hideable column has a label, and none is listed twice", () => {
    const keys = HIDEABLE_COLUMNS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const col of HIDEABLE_COLUMNS) expect(col.label.length).toBeGreaterThan(0);
  });
});

describe("offerableColumns — capability, before anyone's preference", () => {
  const ordinary = { showBook: false, showCategory: true, panelOpen: false };

  test("a single-book chapter desk offers everything but Book", () => {
    expect(offerableColumns(ordinary)).toEqual([
      "date",
      "amount",
      "cardholder",
      "explanation",
      "category",
      "forCol",
      "receipt",
      "status",
    ]);
  });

  test("the merged all-books queue offers Book too", () => {
    expect(offerableColumns({ ...ordinary, showBook: true })).toContain("book");
  });

  test("a scope with no Category column offers no tick box for it", () => {
    expect(offerableColumns({ ...ordinary, showCategory: false })).not.toContain(
      "category",
    );
  });

  test("the side panel's own three step out of the menu while it is open", () => {
    const offered = offerableColumns({ ...ordinary, panelOpen: true });
    expect(offered).not.toContain("cardholder");
    expect(offered).not.toContain("explanation");
    expect(offered).not.toContain("receipt");
    // What the panel doesn't render is still the reader's to hide.
    expect(offered).toEqual(["date", "amount", "category", "forCol", "status"]);
  });
});

describe("showsCategoryColumn", () => {
  const chapterRow = { book: { id: "ch1" }, chargedTo: { id: "ch1" } };
  const centralRow = { book: { id: "central" }, chargedTo: null };
  const crossBookRow = { book: { id: "central" }, chargedTo: { id: "ch1" } };

  test("a chapter scope always has one", () => {
    expect(showsCategoryColumn(false, [])).toBe(true);
    expect(showsCategoryColumn(false, [chapterRow])).toBe(true);
  });

  test("central scope: only when a cross-book row is actually in view", () => {
    expect(showsCategoryColumn(true, [centralRow])).toBe(false);
    expect(showsCategoryColumn(true, [])).toBe(false);
    expect(showsCategoryColumn(true, [centralRow, crossBookRow])).toBe(true);
  });
});

describe("nextSortState", () => {
  test("pressing the active column flips its direction", () => {
    expect(nextSortState({ sort: "date", dir: "desc" }, "date")).toEqual({
      sort: "date",
      dir: "asc",
    });
    expect(nextSortState({ sort: "date", dir: "asc" }, "date")).toEqual({
      sort: "date",
      dir: "desc",
    });
  });

  test("pressing the other column switches to it, descending", () => {
    expect(nextSortState({ sort: "date", dir: "asc" }, "amount")).toEqual({
      sort: "amount",
      dir: "desc",
    });
    expect(nextSortState({ sort: "amount", dir: "asc" }, "date")).toEqual({
      sort: "date",
      dir: "desc",
    });
  });
});

describe("groupSegments", () => {
  test("a page that holds every group gets every header", () => {
    expect(groupSegments(6, [g("a", 3), g("b", 2), g("c", 1)])).toEqual([
      { group: g("a", 3), startIndex: 0, shownCount: 3 },
      { group: g("b", 2), startIndex: 3, shownCount: 2 },
      { group: g("c", 1), startIndex: 5, shownCount: 1 },
    ]);
  });

  test("the group the page runs out inside of reports what it actually shows", () => {
    const segments = groupSegments(4, [g("a", 3), g("b", 40)]);
    expect(segments).toHaveLength(2);
    // The header still prints the WHOLE-SCOPE count (40) — `shownCount` is
    // only how much of it is on this page.
    expect(segments[1]).toEqual({
      group: g("b", 40),
      startIndex: 3,
      shownCount: 1,
    });
  });

  test("groups entirely past the page are dropped — no empty headers", () => {
    expect(groupSegments(3, [g("a", 3), g("b", 5), g("c", 2)])).toEqual([
      { group: g("a", 3), startIndex: 0, shownCount: 3 },
    ]);
  });

  test("segments cover the page exactly, with no gap and no overlap", () => {
    const segments = groupSegments(100, [g("a", 40), g("b", 40), g("c", 40)]);
    const covered = segments.reduce((n, s) => n + s.shownCount, 0);
    expect(covered).toBe(100);
    expect(segments.map((s) => s.startIndex)).toEqual([0, 40, 80]);
  });

  test("no rows, or no groups, means no headers", () => {
    expect(groupSegments(0, [g("a", 3)])).toEqual([]);
    expect(groupSegments(5, [])).toEqual([]);
  });
});

