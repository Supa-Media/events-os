import { describe, expect, test } from "vitest";
import {
  DAY_MS,
  PARTIAL_ITEM_SCORE,
  computeExpectedPhaseScores,
  computePhaseOverdue,
  computePhaseScores,
  isSupplyPacked,
  itemScore,
  startOfDay,
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

describe("isSupplyPacked — the canonical packed read", () => {
  test("the Packing-checklist boolean is the signal, strictly boolean", () => {
    expect(isSupplyPacked({ status: "have_it", fields: { packedIn: true } })).toBe(true);
    expect(isSupplyPacked({ status: "have_it", fields: {} })).toBe(false);
    expect(isSupplyPacked({ status: "have_it", fields: { packedIn: "true" } })).toBe(false);
    expect(isSupplyPacked({ status: null, fields: null })).toBe(false);
  });

  test("legacy `packed` STATUS still reads as packed (unmigrated events)", () => {
    expect(isSupplyPacked({ status: "packed" })).toBe(true);
  });
});

describe("computePhaseScores — supplies split acquisition from packing", () => {
  const SUPPLY_OPTIONS: SelectOption[] = [
    { value: "need_to_order", label: "Need to order" },
    { value: "have_it", label: "Have it", isComplete: true },
  ];
  const supplies = (items: object[]) => [
    { module: "supplies", statusOptions: SUPPLY_OPTIONS, items },
  ];

  test("acquisition (status) follows the item's timing into Planning", () => {
    const scores = computePhaseScores(
      supplies([
        { status: "have_it", offsetDays: -10, packedIn: false },
        { status: "need_to_order", offsetDays: -10, packedIn: false },
      ]),
    );
    expect(scores.planning).toBeCloseTo((1 + PARTIAL_ITEM_SCORE) / 2);
  });

  test("packing (packedIn) always feeds Day-of, never the status", () => {
    // Both in hand, neither packed → acquisition perfect, Day-of empty.
    const unpacked = computePhaseScores(
      supplies([
        { status: "have_it", offsetDays: -10, packedIn: false },
        { status: "have_it", offsetDays: -10, packedIn: false },
      ]),
    );
    expect(unpacked.planning).toBe(1);
    expect(unpacked.dayOf).toBe(0);
    // Packing one item lifts ONLY the Day-of ring.
    const packedOne = computePhaseScores(
      supplies([
        { status: "have_it", offsetDays: -10, packedIn: true },
        { status: "have_it", offsetDays: -10, packedIn: false },
      ]),
    );
    expect(packedOne.planning).toBe(1);
    expect(packedOne.dayOf).toBeCloseTo(0.5);
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

  test("early-finished work shifts the baseline up, never lost", () => {
    const modules = [
      {
        module: "planning_doc",
        statusOptions: STATUS_OPTIONS,
        items: [
          // Finished EARLY (due T-3, done long before)…
          { status: "done", offsetDays: -3, dueDate: EVENT - 3 * DAY_MS },
          // …while one row sits overdue at T-10.
          { status: null, offsetDays: -30, dueDate: EVENT - 30 * DAY_MS },
        ],
      },
    ];
    const expected = computeExpectedPhaseScores(
      modules,
      [],
      EVENT,
      EVENT - 10 * DAY_MS,
    );
    // Baseline = overdue cleared (1) + early credit kept (1) → 100%, not the
    // 50% a due-by-now-only definition would claim.
    expect(expected.planning).toBe(1);
  });

  test("a gate met EARLY counts toward the baseline before its deadline", () => {
    const gates = [
      { module: "run_of_show", phase: "planning" as const, ready: true },
    ];
    const early = computeExpectedPhaseScores([], gates, EVENT, EVENT - 20 * DAY_MS);
    expect(early.planning).toBe(1); // locked at T-20 — baseline absorbs it
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

  test("supplies conventions: in hand by T-1 (Planning) and packed by T-1 (Day-of)", () => {
    const modules = [
      {
        module: "supplies",
        statusOptions: [
          { value: "have_it", label: "Have it", isComplete: true },
        ] as SelectOption[],
        items: [{}], // undated, unpacked
      },
    ];
    // At T-2 neither convention deadline has passed.
    const atT2 = computeExpectedPhaseScores(modules, [], EVENT, EVENT - 2 * DAY_MS);
    expect(atT2.planning).toBe(0);
    expect(atT2.dayOf).toBe(0);
    // At T-1 the item is expected in hand AND its packing unit expected done.
    const atT1 = computeExpectedPhaseScores(modules, [], EVENT, EVENT - DAY_MS);
    expect(atT1.planning).toBe(1);
    expect(atT1.dayOf).toBe(1);
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


describe("computePhaseOverdue — the pace signal", () => {
  const EVENT = startOfDay(Date.UTC(2026, 7, 8)) + 100 * DAY_MS; // arbitrary
  const NOW = EVENT - 28 * DAY_MS; // T-28

  test("overdue = incomplete rows whose deadline passed; matches per phase", () => {
    const pace = computePhaseOverdue(
      [
        {
          module: "planning_doc",
          statusOptions: STATUS_OPTIONS,
          items: [
            { status: null, dueDate: NOW - 5 * DAY_MS }, // overdue
            { status: "in_progress", dueDate: NOW - 2 * DAY_MS }, // started ≠ done → overdue
            { status: "done", dueDate: NOW - 2 * DAY_MS }, // done on time
            { status: null, dueDate: NOW + 5 * DAY_MS }, // not due yet
          ].map((it) => ({ ...it, offsetDays: -30 })),
        },
      ],
      [],
      EVENT,
      NOW,
    );
    expect(pace.planning).toEqual({ dueTotal: 3, overdue: 2 });
    expect(pace.prePlan).toBeNull();
  });

  test("partial credit can NEVER mask overdue rows (the on-pace bug)", () => {
    // A plan whose aggregate score exceeds its expected score while rows sit
    // overdue — the exact Field Day screenshot shape. The pace signal must
    // still say behind.
    const modules = [
      {
        module: "planning_doc",
        statusOptions: STATUS_OPTIONS,
        items: [
          // 2 overdue, untouched
          { status: null, offsetDays: -30, dueDate: NOW - DAY_MS },
          { status: null, offsetDays: -30, dueDate: NOW - DAY_MS },
          // 10 not-yet-due, all started (inflates the actual score)
          ...Array.from({ length: 10 }, () => ({
            status: "in_progress",
            offsetDays: -3,
            dueDate: EVENT - 3 * DAY_MS,
          })),
        ],
      },
    ];
    const pace = computePhaseOverdue(modules, [], EVENT, NOW);
    expect(pace.planning!.overdue).toBe(2);
  });

  test("supplies: unpacked items past the T-1 pack deadline are overdue Day-of units", () => {
    const modules = [
      {
        module: "supplies",
        statusOptions: [
          { value: "have_it", label: "Have it", isComplete: true },
        ] as SelectOption[],
        items: [
          { status: "have_it", offsetDays: -7, packedIn: true },
          { status: "have_it", offsetDays: -7, packedIn: false },
        ],
      },
    ];
    // At T-3 packing isn't due — no Day-of units at all.
    const before = computePhaseOverdue(modules, [], EVENT, EVENT - 3 * DAY_MS);
    expect(before.dayOf).toEqual({ dueTotal: 0, overdue: 0 });
    // Past the pack deadline: both items owe a packing unit; only the
    // unpacked one is overdue. Acquisition (due T-7, complete) paces clean
    // in Planning.
    const after = computePhaseOverdue(modules, [], EVENT, EVENT + DAY_MS);
    expect(after.dayOf).toEqual({ dueTotal: 2, overdue: 1 });
    expect(after.planning).toEqual({ dueTotal: 2, overdue: 0 });
  });

  test("a day-of purchase (offset 0) owes no packing before the event itself", () => {
    // "Bags of ice — buy morning-of": its pack deadline floors at its own
    // have-it-by timing (T-0), not the blanket T-1 convention, so the ring
    // can't demand packing for an item that doesn't exist yet.
    const modules = [
      {
        module: "supplies",
        statusOptions: [
          { value: "have_it", label: "Have it", isComplete: true },
        ] as SelectOption[],
        items: [{ status: null, offsetDays: 0, packedIn: false }],
      },
    ];
    const eventMorning = computePhaseOverdue(modules, [], EVENT, EVENT);
    expect(eventMorning.dayOf).toEqual({ dueTotal: 0, overdue: 0 });
    // Once its own deadline passes, both of the item's units pace: the
    // acquisition (offset 0 → day-of) and the packing unit.
    const dayAfter = computePhaseOverdue(modules, [], EVENT, EVENT + DAY_MS);
    expect(dayAfter.dayOf).toEqual({ dueTotal: 2, overdue: 2 });
  });

  test("an unmet ready gate past its convention deadline counts overdue", () => {
    const gates = [
      { module: "run_of_show", phase: "planning" as const, ready: false },
      { module: "supplies", phase: "planning" as const, ready: true },
    ];
    // At T-1: run_of_show was due locked at T-3 (unmet → overdue), supplies'
    // T-1 gate is due today, not yet overdue (strict start-of-today rule).
    const pace = computePhaseOverdue([], gates, EVENT, EVENT - DAY_MS);
    expect(pace.planning).toEqual({ dueTotal: 1, overdue: 1 });
    // At T+1 supplies' gate is past too — but it was met, so no overdue.
    const later = computePhaseOverdue([], gates, EVENT, EVENT + DAY_MS);
    expect(later.planning).toEqual({ dueTotal: 2, overdue: 1 });
  });
});
