import { describe, expect, test } from "vitest";
import {
  PARTIAL_ITEM_SCORE,
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
