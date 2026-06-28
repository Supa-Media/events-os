import { describe, expect, test } from "vitest";
import {
  calendarMonthGrid,
  groupByDay,
  soonestUpcoming,
  firstUnassignedRole,
  firstModuleMissingOwner,
  startOfDay,
  DAY_MS,
} from "@events-os/shared";

/**
 * Unit tests for the pure logic behind the calendar month view and the What's-
 * next setup rows. These live in `@events-os/shared` precisely so they're
 * testable without rendering a screen. The risk they pin down:
 *   - month-grid boundaries (Sunday-first start, fixed 42 cells, leap Feb, year
 *     wrap, inMonth flags),
 *   - day-bucketing that must ignore time-of-day,
 *   - "soonest upcoming" with an inclusive now-boundary,
 *   - setup-row target selection (first unassigned role / owner-less module).
 */

describe("calendarMonthGrid", () => {
  test("always returns 42 cells (6 weeks)", () => {
    expect(calendarMonthGrid(2026, 5).length).toBe(42);
    expect(calendarMonthGrid(2026, 1).length).toBe(42); // Feb
  });

  test("starts on the Sunday on/before the 1st", () => {
    // June 2026: the 1st is a Monday, so the grid opens on Sun May 31.
    const june = calendarMonthGrid(2026, 5);
    const firstCell = new Date(june[0].ms);
    expect(firstCell.getDay()).toBe(0); // Sunday
    expect(firstCell.getMonth()).toBe(4); // May
    expect(firstCell.getDate()).toBe(31);
    expect(june[0].inMonth).toBe(false);
  });

  test("opens flush when the 1st is already a Sunday", () => {
    // Feb 2026 starts on a Sunday — first cell is Feb 1, in-month.
    const feb = calendarMonthGrid(2026, 1);
    const first = new Date(feb[0].ms);
    expect(first.getDay()).toBe(0);
    expect(first.getDate()).toBe(1);
    expect(first.getMonth()).toBe(1);
    expect(feb[0].inMonth).toBe(true);
  });

  test("flags in-month vs adjacent days, covering the whole month exactly once", () => {
    const june = calendarMonthGrid(2026, 5);
    const inMonth = june.filter((c) => c.inMonth);
    expect(inMonth.length).toBe(30); // June has 30 days
    expect(inMonth.map((c) => c.day)).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1),
    );
    expect(inMonth.every((c) => new Date(c.ms).getMonth() === 5)).toBe(true);
  });

  test("handles a leap February (29 in-month days)", () => {
    const feb2028 = calendarMonthGrid(2028, 1);
    const inMonth = feb2028.filter((c) => c.inMonth);
    expect(inMonth.length).toBe(29);
    expect(inMonth[inMonth.length - 1].day).toBe(29);
  });

  test("wraps the year across a December grid", () => {
    // Dec 2026 trailing cells should spill into January 2027.
    const dec = calendarMonthGrid(2026, 11);
    const last = new Date(dec[41].ms);
    expect(dec[41].inMonth).toBe(false);
    expect(last.getFullYear()).toBe(2027);
    expect(last.getMonth()).toBe(0);
  });

  test("cells are consecutive local days at midnight", () => {
    const grid = calendarMonthGrid(2026, 5);
    for (const c of grid) {
      expect(c.ms).toBe(startOfDay(c.ms));
      expect(new Date(c.ms).getDate()).toBe(c.day);
    }
    // Consecutive (DST-safe within a single month at midnight granularity).
    for (let i = 1; i < grid.length; i++) {
      expect(startOfDay(grid[i].ms) - startOfDay(grid[i - 1].ms)).toBe(DAY_MS);
    }
  });
});

describe("groupByDay", () => {
  const ev = (ms: number, name: string) => ({ eventDate: ms, name });

  test("buckets events on the same date regardless of time-of-day", () => {
    const morning = new Date(2026, 6, 18, 9, 0).getTime();
    const evening = new Date(2026, 6, 18, 20, 30).getTime();
    const other = new Date(2026, 6, 19, 1, 0).getTime();
    const map = groupByDay(
      [ev(morning, "a"), ev(evening, "b"), ev(other, "c")],
      (e) => e.eventDate,
    );
    expect(map.size).toBe(2);
    const day18 = map.get(startOfDay(morning))!;
    expect(day18.map((e) => e.name)).toEqual(["a", "b"]);
    expect(map.get(startOfDay(other))!.map((e) => e.name)).toEqual(["c"]);
  });

  test("keys are local-midnight timestamps", () => {
    const ts = new Date(2026, 6, 18, 13, 45).getTime();
    const map = groupByDay([ev(ts, "a")], (e) => e.eventDate);
    expect([...map.keys()]).toEqual([startOfDay(ts)]);
  });

  test("preserves insertion order within a day", () => {
    const base = new Date(2026, 6, 18, 8, 0).getTime();
    const map = groupByDay(
      [ev(base + 3, "third"), ev(base + 1, "first"), ev(base + 2, "second")],
      (e) => e.eventDate,
    );
    expect(map.get(startOfDay(base))!.map((e) => e.name)).toEqual([
      "third",
      "first",
      "second",
    ]);
  });

  test("returns an empty map for no items", () => {
    expect(groupByDay([], (e: { eventDate: number }) => e.eventDate).size).toBe(0);
  });
});

describe("soonestUpcoming", () => {
  const now = new Date(2026, 5, 28, 12, 0).getTime();
  const at = (y: number, m: number, d: number) => ({
    eventDate: new Date(y, m, d, 10, 0).getTime(),
  });

  test("returns the nearest event at or after now, ignoring past ones", () => {
    const past = at(2026, 4, 1);
    const soon = at(2026, 6, 18);
    const later = at(2026, 8, 2);
    const next = soonestUpcoming([later, past, soon], (e) => e.eventDate, now);
    expect(next).toBe(soon);
  });

  test("is inclusive of an item exactly at now", () => {
    const exact = { eventDate: now };
    const future = at(2026, 7, 1);
    expect(soonestUpcoming([future, exact], (e) => e.eventDate, now)).toBe(exact);
  });

  test("returns null when every item is in the past", () => {
    expect(
      soonestUpcoming([at(2026, 1, 1), at(2026, 4, 1)], (e) => e.eventDate, now),
    ).toBeNull();
  });

  test("returns null for an empty list", () => {
    expect(soonestUpcoming([], (e: { eventDate: number }) => e.eventDate, now)).toBeNull();
  });

  test("does not mutate the input order", () => {
    const items = [at(2026, 8, 2), at(2026, 6, 18)];
    const snapshot = [...items];
    soonestUpcoming(items, (e) => e.eventDate, now);
    expect(items).toEqual(snapshot);
  });
});

describe("firstUnassignedRole", () => {
  const role = (roleId: string, person: unknown) => ({ roleId, person });

  test("returns the first row whose person is null", () => {
    const rows = [
      role("a", { _id: "p1" }),
      role("b", null),
      role("c", null),
    ];
    expect(firstUnassignedRole(rows)).toBe(rows[1]);
  });

  test("treats undefined person as unassigned", () => {
    const rows = [role("a", { _id: "p1" }), role("b", undefined)];
    expect(firstUnassignedRole(rows)).toBe(rows[1]);
  });

  test("returns null when every role is assigned", () => {
    const rows = [role("a", { _id: "p1" }), role("b", { _id: "p2" })];
    expect(firstUnassignedRole(rows)).toBeNull();
  });

  test("returns null for no roles", () => {
    expect(firstUnassignedRole([])).toBeNull();
  });
});

describe("firstModuleMissingOwner", () => {
  type M = { key: string; ownerRole: boolean; owned: boolean };
  const mods: M[] = [
    { key: "no-role", ownerRole: false, owned: false }, // can't be assigned — skip
    { key: "staffed", ownerRole: true, owned: true },
    { key: "needs-owner", ownerRole: true, owned: false }, // <- the target
    { key: "also-needs", ownerRole: true, owned: false },
  ];
  const pick = (list: M[]) =>
    firstModuleMissingOwner(
      list,
      (m) => m.ownerRole,
      (m) => m.owned,
    );

  test("skips modules with no owner role and returns the first owner-less one", () => {
    expect(pick(mods)?.key).toBe("needs-owner");
  });

  test("returns null when all owner-bearing modules are staffed", () => {
    expect(
      pick([
        { key: "x", ownerRole: false, owned: false },
        { key: "y", ownerRole: true, owned: true },
      ]),
    ).toBeNull();
  });

  test("returns null for no modules", () => {
    expect(pick([])).toBeNull();
  });
});
