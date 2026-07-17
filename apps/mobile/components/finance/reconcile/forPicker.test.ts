// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors `lib/financeSeats.test.ts`).
import { describe, expect, test } from "@jest/globals";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  buildForPickerItems,
  buildRankedForPickerItems,
  type ForPickerOptions,
  type RankForPickerResult,
} from "./forPicker";

function budgetId(n: number): Id<"budgets"> {
  return `budget${n}` as Id<"budgets">;
}

// ── buildForPickerItems ─────────────────────────────────────────────────────
// WP-wave4 (item 5, owner addendum 2026-07-17): `forPickerOptions` now only
// ever returns a ref with a real, APPROVED budget (`isAttributableBudget`,
// server-side) — a budget-less or unapproved ref is OMITTED entirely, never
// present with a null `budgetId`. The old "summon-on-pick" encoding/demotion
// this file used to pin is retired along with it.

describe("buildForPickerItems", () => {
  test("groups events/projects/recurring, every row carrying a real budgetId", () => {
    const options: ForPickerOptions = {
      events: [
        { eventId: "e1" as Id<"events">, label: "Sunday Gathering · Jun 1, 2026", budgetId: budgetId(1) },
      ],
      projects: [
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
      "Projects",
      "Music Recording · Jun 1, 2026",
      "Recurring · Chapter",
      "Ops",
      "Recurring · Central",
      "City Launch Fund",
    ]);
    const eventRow = items.find((i) => i.label === "Sunday Gathering · Jun 1, 2026")!;
    expect(eventRow.value).toBe(budgetId(1));
  });

  test("an empty group renders no header at all", () => {
    const options: ForPickerOptions = {
      events: [{ eventId: "e1" as Id<"events">, label: "Sunday Gathering", budgetId: budgetId(1) }],
      projects: [],
      recurring: [],
    };
    const items = buildForPickerItems(options);
    expect(items.some((i) => i.label === "Projects")).toBe(false);
    expect(items.some((i) => i.label === "Recurring · Chapter")).toBe(false);
  });

  test("no options at all renders just the 'None' row", () => {
    const options: ForPickerOptions = { events: [], projects: [], recurring: [] };
    expect(buildForPickerItems(options)).toEqual([{ value: "", label: "None" }]);
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
    budgetId: budgetId(1),
    level: null,
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
        }),
        rankedRow({
          tier: 2,
          reason: "Similar: 'Home Depot' coded here",
          refKind: "project",
          refId: "p1",
          label: "Similar Project",
          budgetId: budgetId(2),
        }),
        rankedRow({ tier: 4, refId: "e2", label: "Everything Else Event", budgetId: budgetId(3) }),
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

  test("every tier-4 row carries a real budgetId — no 'No budget yet' subsection exists anymore", () => {
    const ranked: RankForPickerResult = {
      searching: false,
      truncated: false,
      rows: [
        rankedRow({ tier: 4, refId: "e1", label: "Budgeted Event", budgetId: budgetId(1) }),
      ],
    };
    const items = buildRankedForPickerItems(ranked);
    expect(items.map((i) => i.label)).toEqual(["None", "Events", "Budgeted Event"]);
    expect(items.some((i) => i.label.includes("No budget yet"))).toBe(false);
  });

  test("no tiers 1-3 present → no 'Suggested' section at all", () => {
    const ranked: RankForPickerResult = {
      searching: false,
      truncated: false,
      rows: [rankedRow({ tier: 4, refId: "e1", label: "Plain Event", budgetId: budgetId(1) })],
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
