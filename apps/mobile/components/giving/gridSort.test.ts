import { describe, expect, test } from "@jest/globals";
import { compareSortValues, nextSortState, sortRows } from "./gridSort";

describe("compareSortValues", () => {
  test("nulls/undefined always sort last, regardless of which side", () => {
    expect(compareSortValues(null, 5)).toBeGreaterThan(0);
    expect(compareSortValues(5, null)).toBeLessThan(0);
    expect(compareSortValues(undefined, "a")).toBeGreaterThan(0);
    expect(compareSortValues(null, null)).toBe(0);
    expect(compareSortValues(undefined, undefined)).toBe(0);
  });

  test("strings use localeCompare", () => {
    expect(compareSortValues("apple", "banana")).toBeLessThan(0);
    expect(compareSortValues("banana", "apple")).toBeGreaterThan(0);
    expect(compareSortValues("apple", "apple")).toBe(0);
  });

  test("numbers compare numerically", () => {
    expect(compareSortValues(1, 2)).toBeLessThan(0);
    expect(compareSortValues(200, 10)).toBeGreaterThan(0);
    expect(compareSortValues(5, 5)).toBe(0);
  });
});

describe("sortRows", () => {
  type Row = { name: string; lifetimeCents: number | null };
  const rows: Row[] = [
    { name: "Charlie", lifetimeCents: 100 },
    { name: "Alice", lifetimeCents: null },
    { name: "Bob", lifetimeCents: 300 },
  ];

  test("ascending by string field", () => {
    const sorted = sortRows(rows, (r) => r.name, "asc");
    expect(sorted.map((r) => r.name)).toEqual(["Alice", "Bob", "Charlie"]);
  });

  test("ascending by numeric field keeps nulls last (not first)", () => {
    const sorted = sortRows(rows, (r) => r.lifetimeCents, "asc");
    expect(sorted.map((r) => r.name)).toEqual(["Charlie", "Bob", "Alice"]);
  });

  test("descending by numeric field ALSO keeps nulls last, not resurfaced to top", () => {
    const sorted = sortRows(rows, (r) => r.lifetimeCents, "desc");
    expect(sorted.map((r) => r.name)).toEqual(["Bob", "Charlie", "Alice"]);
  });

  test("does not mutate the input array", () => {
    const copy = [...rows];
    sortRows(rows, (r) => r.name, "asc");
    expect(rows).toEqual(copy);
  });

  test("empty input returns empty output", () => {
    expect(sortRows([], (r: Row) => r.name, "asc")).toEqual([]);
  });
});

describe("nextSortState", () => {
  test("a fresh column starts ascending", () => {
    expect(nextSortState("name", null)).toEqual({ key: "name", direction: "asc" });
    expect(nextSortState("name", { key: "lifetime", direction: "desc" })).toEqual({
      key: "name",
      direction: "asc",
    });
  });

  test("pressing the active column again flips direction", () => {
    expect(
      nextSortState("name", { key: "name", direction: "asc" }),
    ).toEqual({ key: "name", direction: "desc" });
    expect(
      nextSortState("name", { key: "name", direction: "desc" }),
    ).toEqual({ key: "name", direction: "asc" });
  });
});
