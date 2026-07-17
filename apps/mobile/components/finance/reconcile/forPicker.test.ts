// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors `lib/financeSeats.test.ts`).
import { describe, expect, jest, test } from "@jest/globals";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  buildForPickerItems,
  buildRankedForPickerItems,
  isSummonValue,
  parseSummonValue,
  resolveForPickerValue,
  type ForPickerOptions,
  type RankForPickerResult,
} from "./forPicker";

function budgetId(n: number): Id<"budgets"> {
  return `budget${n}` as Id<"budgets">;
}

// ── buildForPickerItems: budget-less demotion ───────────────────────────────

describe("buildForPickerItems", () => {
  test("budget-less events/projects are demoted to a trailing 'No budget yet' subsection per group", () => {
    const options: ForPickerOptions = {
      events: [
        { eventId: "e1" as Id<"events">, label: "Sunday Gathering · Jun 1, 2026", budgetId: budgetId(1) },
        { eventId: "e2" as Id<"events">, label: "Pitch Deck for EP · Jul 6, 2026", budgetId: null },
      ],
      projects: [
        { projectId: "p1" as Id<"projects">, label: "Zebra Project · Jun 1, 2026", budgetId: null },
        { projectId: "p2" as Id<"projects">, label: "Music Recording · Jun 1, 2026", budgetId: budgetId(2) },
      ],
      recurring: [
        { budgetId: budgetId(3), label: "Ops", level: "chapter" },
        { budgetId: budgetId(4), label: "City Launch Fund", level: "central" },
      ],
    };

    const items = buildForPickerItems(options);
    const labels = items.map((i) => i.label);

    expect(labels).toEqual([
      "None",
      "Events",
      "Sunday Gathering · Jun 1, 2026",
      "Events · No budget yet",
      "Pitch Deck for EP · Jul 6, 2026",
      "Projects",
      "Music Recording · Jun 1, 2026",
      "Projects · No budget yet",
      "Zebra Project · Jun 1, 2026",
      "Recurring · Chapter",
      "Ops",
      "Recurring · Central",
      "City Launch Fund",
    ]);
    // The budget-less event's value is still a summon-candidate, not lost.
    const summonRow = items.find((i) => i.label === "Pitch Deck for EP · Jul 6, 2026")!;
    expect(isSummonValue(summonRow.value)).toBe(true);
    expect(parseSummonValue(summonRow.value)).toEqual({ refKind: "event", scopeRefId: "e2" });
  });

  test("a group with NO budget-less refs has no 'No budget yet' subsection at all", () => {
    const options: ForPickerOptions = {
      events: [{ eventId: "e1" as Id<"events">, label: "Sunday Gathering", budgetId: budgetId(1) }],
      projects: [],
      recurring: [],
    };
    const items = buildForPickerItems(options);
    expect(items.some((i) => i.label.includes("No budget yet"))).toBe(false);
  });

  test("a group that is ENTIRELY budget-less still gets its subsection header (no empty primary header)", () => {
    const options: ForPickerOptions = {
      events: [{ eventId: "e1" as Id<"events">, label: "Task-shaped Event", budgetId: null }],
      projects: [],
      recurring: [],
    };
    const items = buildForPickerItems(options);
    expect(items.map((i) => i.label)).toEqual(["None", "Events · No budget yet", "Task-shaped Event"]);
  });
});

// ── buildRankedForPickerItems: Suggested + grouped tier-4 tail ────────────

function rankedRow(overrides: Partial<RankForPickerResult["rows"][number]>): RankForPickerResult["rows"][number] {
  return {
    tier: 4,
    reason: null,
    refKind: "event",
    refId: "e1",
    label: "Some Event · Jun 1, 2026",
    dateLabel: "Jun 1, 2026",
    budgetId: null,
    level: null,
    hasBudget: false,
    ...overrides,
  };
}

describe("buildRankedForPickerItems: default (non-searching) view", () => {
  test("tiers 1-3 render under a single 'Suggested' section, each carrying its reason as a sublabel", () => {
    const ranked: RankForPickerResult = {
      searching: false,
      truncated: false,
      rows: [
        rankedRow({
          tier: 1,
          reason: "2 transactions nearby in June",
          refId: "e1",
          label: "Nearby Event",
          budgetId: budgetId(1),
          hasBudget: true,
        }),
        rankedRow({
          tier: 2,
          reason: "Similar: 'Home Depot' coded here",
          refKind: "project",
          refId: "p1",
          label: "Similar Project",
          budgetId: budgetId(2),
          hasBudget: true,
        }),
        rankedRow({ tier: 4, refId: "e2", label: "Everything Else Event", hasBudget: true, budgetId: budgetId(3) }),
      ],
    };

    const items = buildRankedForPickerItems(ranked);
    expect(items[0]).toEqual({ value: "", label: "None" });
    expect(items[1]).toEqual({ value: "__grp_suggested", label: "Suggested", header: true });
    expect(items[2]).toMatchObject({ label: "Nearby Event", reason: "2 transactions nearby in June" });
    expect(items[3]).toMatchObject({ label: "Similar Project", reason: "Similar: 'Home Depot' coded here" });
    // The tier-4 tail still gets its own group header.
    expect(items.some((i) => i.header && i.label === "Events")).toBe(true);
    expect(items.find((i) => i.label === "Everything Else Event")).toBeDefined();
  });

  test("tier-4 budget-less refs land in a trailing 'No budget yet' subsection, mirroring buildForPickerItems", () => {
    const ranked: RankForPickerResult = {
      searching: false,
      truncated: false,
      rows: [
        rankedRow({ tier: 4, refId: "e1", label: "Budgeted Event", hasBudget: true, budgetId: budgetId(1) }),
        rankedRow({ tier: 4, refId: "e2", label: "Budget-less Event", hasBudget: false, budgetId: null }),
      ],
    };
    const items = buildRankedForPickerItems(ranked);
    const labels = items.map((i) => i.label);
    expect(labels).toEqual([
      "None",
      "Events",
      "Budgeted Event",
      "Events · No budget yet",
      "Budget-less Event",
    ]);
  });

  test("no tiers 1-3 present → no 'Suggested' section at all", () => {
    const ranked: RankForPickerResult = {
      searching: false,
      truncated: false,
      rows: [rankedRow({ tier: 4, refId: "e1", label: "Plain Event", hasBudget: true, budgetId: budgetId(1) })],
    };
    const items = buildRankedForPickerItems(ranked);
    expect(items.some((i) => i.label === "Suggested")).toBe(false);
  });
});

describe("buildRankedForPickerItems: search mode", () => {
  test("renders a FLAT list — no 'None' row, no section headers", () => {
    const ranked: RankForPickerResult = {
      searching: true,
      truncated: false,
      rows: [
        rankedRow({ tier: 4, refId: "e1", label: "Band Practice" }),
        rankedRow({ tier: 3, reason: "Event date 4 days away", refId: "e2", label: "Band Retreat" }),
      ],
    };
    const items = buildRankedForPickerItems(ranked);
    expect(items.every((i) => !i.header)).toBe(true);
    expect(items.map((i) => i.label)).toEqual(["Band Practice", "Band Retreat"]);
  });

  test("an empty search result is an empty list (caller renders the 'No matches' state)", () => {
    const ranked: RankForPickerResult = { searching: true, truncated: false, rows: [] };
    expect(buildRankedForPickerItems(ranked)).toEqual([]);
  });
});

// ── Value resolution (unchanged behavior, guarded against regressions) ────

describe("resolveForPickerValue", () => {
  test("a real budgetId value resolves to itself without calling summon", async () => {
    const summon = jest.fn(async (): Promise<Id<"budgets">> => budgetId(9));
    const result = await resolveForPickerValue(budgetId(1), summon);
    expect(result).toBe(budgetId(1));
    expect(summon).not.toHaveBeenCalled();
  });

  test("a summon-candidate value calls summon with the parsed ref", async () => {
    const summon = jest.fn(async () => budgetId(9));
    const result = await resolveForPickerValue("summon:project:p1", summon);
    expect(summon).toHaveBeenCalledWith({ refKind: "project", scopeRefId: "p1" });
    expect(result).toBe(budgetId(9));
  });
});
