// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors `forPicker.test.ts`).
import { describe, expect, test } from "@jest/globals";
import {
  explainedStripMode,
  groupSegments,
  nextSortState,
  parseGroupBy,
  parseSortDir,
  parseSortKey,
  type GroupSummary,
} from "./gridView";

const g = (
  key: string,
  count: number,
  progress?: { explainable: number; explained: number },
): GroupSummary => ({
  key,
  label: key,
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

describe("explainedStripMode — the needs_explaining honesty rule", () => {
  const progress = { explainableCount: 418 };

  test("ordinary selections read as progress", () => {
    expect(explainedStripMode(progress, [])).toBe("progress");
    expect(explainedStripMode(progress, ["spend", "to_review"])).toBe("progress");
  });

  test("needs_explaining relabels instead of claiming zero progress", () => {
    // The match set IS the unexplained rows, so `explainedCount` is 0 by
    // construction — "0 of 418 explained" would read as "nothing has ever
    // been done" when the truth is the opposite.
    expect(explainedStripMode(progress, ["needs_explaining"])).toBe("remaining");
    expect(
      explainedStripMode(progress, ["spend", "needs_explaining"]),
    ).toBe("remaining");
  });

  test("nothing explainable in the selection says nothing at all", () => {
    expect(explainedStripMode({ explainableCount: 0 }, [])).toBe("hidden");
    expect(
      explainedStripMode({ explainableCount: 0 }, ["needs_explaining"]),
    ).toBe("hidden");
  });
});
