import { describe, expect, test } from "vitest";
import {
  DAY_MS,
  PARTIAL_ITEM_SCORE,
  computeExpectedPhaseScores,
  computePhaseScores,
  itemScore,
  type SelectOption,
} from "@events-os/shared";

/**
 * The scoring contract behind the phase-readiness rings. The key rule (and the
 * reason PARTIAL_ITEM_SCORE was lowered from 0.5): starting an item must move a
 * phase ring noticeably LESS than finishing it.
 */

const STATUS_OPTIONS: SelectOption[] = [
  { value: "not_started", label: "Not started", isComplete: false },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done", isComplete: true },
];

describe("itemScore", () => {
  test("complete status scores 1", () => {
    expect(itemScore(STATUS_OPTIONS, "done")).toBe(1);
  });

  test("started-but-not-done status earns partial credit", () => {
    expect(itemScore(STATUS_OPTIONS, "in_progress")).toBe(PARTIAL_ITEM_SCORE);
  });

  test("not-started and missing status score 0", () => {
    expect(itemScore(STATUS_OPTIONS, "not_started")).toBe(0);
    expect(itemScore(STATUS_OPTIONS, null)).toBe(0);
  });

  test("partial credit is well below a half, so done outweighs in-progress", () => {
    expect(PARTIAL_ITEM_SCORE).toBeLessThan(0.5);
  });
});

describe("computePhaseScores partial vs complete", () => {
  const planningModule = (status: string) => [
    {
      module: "planning_doc",
      statusOptions: STATUS_OPTIONS,
      items: [{ status, offsetDays: -1 }],
    },
  ];

  test("an in-progress item lifts a phase less than finishing it", () => {
    const started = computePhaseScores(planningModule("in_progress")).planning ?? 0;
    const done = computePhaseScores(planningModule("done")).planning ?? 0;
    expect(started).toBe(PARTIAL_ITEM_SCORE);
    expect(done).toBe(1);
    expect(started).toBeLessThan(done);
  });
});


describe("computeExpectedPhaseScores — the pacing ghost", () => {
  const EVENT = 100 * DAY_MS; // arbitrary fixed event date
  const planningModules = [
    {
      module: "planning_doc",
      statusOptions: STATUS_OPTIONS,
      items: [
        { offsetDays: -14 }, // due at EVENT - 14d
        { offsetDays: -3 }, //  due at EVENT - 3d
      ],
    },
  ];

  test("items count toward the target only once their deadline passes", () => {
    // At T-20 nothing is due yet → expected 0.
    const early = computeExpectedPhaseScores(
      planningModules,
      [],
      EVENT,
      EVENT - 20 * DAY_MS,
    );
    expect(early.planning).toBe(0);
    // At T-10 the T-14 item is due, the T-3 one isn't → expected 50%.
    const mid = computeExpectedPhaseScores(
      planningModules,
      [],
      EVENT,
      EVENT - 10 * DAY_MS,
    );
    expect(mid.planning).toBeCloseTo(0.5);
    // On the day everything is due → expected 100%.
    const dayOf = computeExpectedPhaseScores(planningModules, [], EVENT, EVENT);
    expect(dayOf.planning).toBe(1);
  });

  test("expected and actual share the aggregation, so gaps are comparable", () => {
    // Actual at T-10 with the overdue item done = 50% — exactly the target.
    const actual = computePhaseScores([
      {
        module: "planning_doc",
        statusOptions: STATUS_OPTIONS,
        items: [
          { status: "done", offsetDays: -14 },
          { status: null, offsetDays: -3 },
        ],
      },
    ]);
    const expected = computeExpectedPhaseScores(
      planningModules,
      [],
      EVENT,
      EVENT - 10 * DAY_MS,
    );
    expect(actual.planning).toBeCloseTo(expected.planning!);
  });

  test("convention deadlines: supplies expected packed by T-1, debrief by T+7", () => {
    const modules = [
      {
        module: "supplies",
        statusOptions: [
          { value: "packed", label: "Packed", isComplete: true },
        ] as SelectOption[],
        items: [{}],
      },
    ];
    expect(
      computeExpectedPhaseScores(modules, [], EVENT, EVENT - 2 * DAY_MS).dayOf,
    ).toBe(0);
    expect(
      computeExpectedPhaseScores(modules, [], EVENT, EVENT - DAY_MS).dayOf,
    ).toBe(1);
  });

  test("ready gates hit their convention deadlines; pre-plan has no ghost", () => {
    const gates = [
      { module: "run_of_show", phase: "planning" as const }, // expected by T-3
    ];
    const before = computeExpectedPhaseScores([], gates, EVENT, EVENT - 5 * DAY_MS);
    expect(before.planning).toBe(0);
    const after = computeExpectedPhaseScores([], gates, EVENT, EVENT - 2 * DAY_MS);
    expect(after.planning).toBe(1);
    expect(after.prePlan).toBeNull();
  });

  test("statusless modules carry no expectation (mirrors their 0 actual)", () => {
    const modules = [
      { module: "run_of_show", statusOptions: undefined, items: [{ offsetMinutes: -60 }] },
    ];
    const at = computeExpectedPhaseScores(modules, [], EVENT, EVENT);
    // The module contributes a 0 module-score, same as the actual side.
    expect(at.dayOf).toBe(0);
  });
});
