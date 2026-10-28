// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals instead of adding a new dependency.
import { describe, expect, test } from "@jest/globals";
import {
  EMPTY_DUTY_FILTERS,
  attentionReason,
  filterDuties,
  groupDuties,
  hasActiveFilters,
  sortDuties,
  type DutyFacts,
} from "./dutyFilters.logic";

const ED = { id: "ed", title: "Executive Director", chart: "central" as const, holders: 1 };
const OPS = { id: "ops", title: "Operations Director", chart: "central" as const, holders: 0 };
const TREAS = { id: "treas", title: "Treasurer", chart: "chapter" as const, holders: 1 };

function duty(over: Partial<DutyFacts> & { id: string; title: string }): DutyFacts {
  const d: DutyFacts = {
    cadence: "weekly",
    seats: [],
    directCount: 0,
    legacyRoles: [],
    hasHowTo: false,
    holders: 0,
    searchText: "",
    ...over,
  };
  d.searchText ||= [d.title, ...d.seats.map((s) => s.title)].join(" ").toLowerCase();
  return d;
}

const steering = duty({ id: "1", title: "Leadership Steering", seats: [ED, OPS], holders: 1 });
const receipts = duty({ id: "2", title: "Ensure all expenses have receipts", cadence: "ad_hoc", seats: [TREAS], holders: 1, hasHowTo: true });
const studio = duty({ id: "3", title: "Plan Studio Sessions", directCount: 1, holders: 1 });
const orphan = duty({ id: "4", title: "Orphan duty", cadence: "monthly" });
const all = [steering, receipts, studio, orphan];
const none = new Set<string>();

describe("attentionReason", () => {
  test("flags unassigned, vacant, and unmapped duties", () => {
    expect(attentionReason(orphan)).toBe("Not assigned to anyone");
    expect(attentionReason(steering)).toBe("Operations Director is vacant");
    expect(attentionReason(duty({ id: "5", title: "x", legacyRoles: ["Lead"], holders: 2 }))).toBe(
      "Not mapped to a seat yet",
    );
    expect(attentionReason(receipts)).toBeNull();
    expect(attentionReason(studio)).toBeNull();
  });
});

describe("filterDuties", () => {
  test("views", () => {
    const ids = (view: typeof EMPTY_DUTY_FILTERS.view, mine = none) =>
      filterDuties(all, { ...EMPTY_DUTY_FILTERS, view }, mine).map((d) => d.id);
    expect(ids("all")).toEqual(["1", "2", "3", "4"]);
    expect(ids("attention")).toEqual(["1", "4"]);
    expect(ids("mine", new Set(["treas"]))).toEqual(["2"]);
    expect(ids("howto")).toEqual(["1", "3", "4"]);
  });

  test("search matches seat titles, case-insensitively", () => {
    const r = filterDuties(all, { ...EMPTY_DUTY_FILTERS, query: "  TREASURER " }, none);
    expect(r.map((d) => d.id)).toEqual(["2"]);
  });

  test("cadences OR together, other filters AND", () => {
    const f = { ...EMPTY_DUTY_FILTERS, cadences: ["weekly", "monthly"] as const };
    expect(filterDuties(all, { ...f, cadences: [...f.cadences] }, none).map((d) => d.id)).toEqual(["1", "3", "4"]);
    expect(
      filterDuties(all, { ...EMPTY_DUTY_FILTERS, cadences: ["weekly"], directOnly: true }, none).map((d) => d.id),
    ).toEqual(["3"]);
  });

  test("seat, chart, vacant, how-to", () => {
    const ids = (over: Partial<typeof EMPTY_DUTY_FILTERS>) =>
      filterDuties(all, { ...EMPTY_DUTY_FILTERS, ...over }, none).map((d) => d.id);
    expect(ids({ seatId: "ed" })).toEqual(["1"]);
    expect(ids({ chart: "chapter" })).toEqual(["2"]);
    expect(ids({ vacantOnly: true })).toEqual(["1"]);
    expect(ids({ noHowTo: true })).toEqual(["1", "3", "4"]);
  });
});

describe("sortDuties", () => {
  test("by title, cadence, and reach", () => {
    expect(sortDuties(all, "title").map((d) => d.id)).toEqual(["2", "1", "4", "3"]);
    expect(sortDuties(all, "cadence").map((d) => d.id)).toEqual(["1", "3", "4", "2"]);
    expect(sortDuties(all, "fewest")[0].id).toBe("4");
    expect(sortDuties(all, "most")[3].id).toBe("4");
  });
});

describe("groupDuties", () => {
  const label = (c: string) => c.toUpperCase();
  test("by seat lists a duty under each of its seats, plus No seat", () => {
    const g = groupDuties(all, "seat", label);
    expect(g.map((x) => [x.label, x.vacant, x.items.map((d) => d.id)])).toEqual([
      ["Executive Director", false, ["1"]],
      ["Operations Director", true, ["1"]],
      ["Treasurer", false, ["2"]],
      ["No seat", false, ["3", "4"]],
    ]);
  });
  test("by cadence drops empty buckets, in cadence order", () => {
    expect(groupDuties(all, "cadence", label).map((g) => g.label)).toEqual(["WEEKLY", "MONTHLY", "AD_HOC"]);
  });
  test("none is one unlabeled bucket", () => {
    expect(groupDuties(all, "none", label)).toEqual([{ key: "all", label: null, vacant: false, items: all }]);
  });
});

test("hasActiveFilters ignores the view tab", () => {
  expect(hasActiveFilters({ ...EMPTY_DUTY_FILTERS, view: "mine" })).toBe(false);
  expect(hasActiveFilters({ ...EMPTY_DUTY_FILTERS, query: " " })).toBe(false);
  expect(hasActiveFilters({ ...EMPTY_DUTY_FILTERS, noHowTo: true })).toBe(true);
});
