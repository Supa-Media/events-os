// No @types/jest / ambient globals configured for this package — import the
// test globals explicitly from @jest/globals, matching
// `components/orgchart/treeUtils.test.ts`.
import { describe, expect, test } from "@jest/globals";
import {
  computeReconciliationRunView,
  RUN_NOTES_DISPLAY_LIMIT,
  RUN_NOTES_INLINE_THRESHOLD,
  type UnsettledGap,
} from "./reconciliationRunView";

function gap(scopeName: string, gapCents = 40_000): UnsettledGap {
  return {
    scope: scopeName,
    scopeName,
    bookBalanceCents: 50_000,
    bankBalanceCents: 10_000,
    gapCents,
  };
}

function manyNotes(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `Note ${i + 1} from an earlier step.`);
}

describe("computeReconciliationRunView — the advisory must survive notes truncation", () => {
  // THE regression this file exists to pin: `settleChapterBalances` pushes
  // its "not settled, real cash movement is off" gap LAST, as step 8 of 8 —
  // so any morning with a realistic number of notes from the earlier steps
  // (payout matching, settlement, fee/sales sync) buried or discarded it
  // before `notes.slice(0, RUN_NOTES_DISPLAY_LIMIT)` ever reached this
  // component. `advisoryGaps` must be immune to both the slice and the
  // collapse toggle that gate `notes`.
  test("10+ notes from other steps still leave every unsettled gap visible", () => {
    const view = computeReconciliationRunView(
      { notes: manyNotes(10), unsettledGaps: [gap("New York"), gap("Boston")] },
      /* notesExpanded */ false,
    );
    // The notes themselves DO truncate — that part of the old behaviour is
    // fine and unchanged.
    expect(view.runNotes).toHaveLength(RUN_NOTES_DISPLAY_LIMIT);
    expect(view.notesCollapsible).toBe(true);
    expect(view.showNotes).toBe(false); // collapsed by default, as before
    // But the advisory is a full, separate list — not a slice of `notes`,
    // and not gated on the same `notesExpanded` state that hides them.
    expect(view.advisoryGaps).toHaveLength(2);
    expect(view.advisoryGaps.map((g) => g.scopeName)).toEqual([
      "New York",
      "Boston",
    ]);
  });

  test("the advisory is reachable without expanding notes, even with notes collapsed", () => {
    const collapsed = computeReconciliationRunView(
      { notes: manyNotes(5), unsettledGaps: [gap("Chicago")] },
      false,
    );
    expect(collapsed.showNotes).toBe(false);
    expect(collapsed.advisoryGaps).toHaveLength(1);

    // Expanding notes must not be a precondition for the advisory to have
    // been showable all along — it was already there with notes collapsed.
    const expanded = computeReconciliationRunView(
      { notes: manyNotes(5), unsettledGaps: [gap("Chicago")] },
      true,
    );
    expect(expanded.advisoryGaps).toEqual(collapsed.advisoryGaps);
  });

  test("the advisory is never capped at RUN_NOTES_DISPLAY_LIMIT the way notes are", () => {
    // A busy morning with more unsettled chapters than the notes display
    // limit must not silently drop any of them the way `notes` would.
    const gaps = Array.from({ length: RUN_NOTES_DISPLAY_LIMIT + 5 }, (_, i) =>
      gap(`Chapter ${i + 1}`),
    );
    const view = computeReconciliationRunView(
      { notes: [], unsettledGaps: gaps },
      false,
    );
    expect(view.advisoryGaps).toHaveLength(RUN_NOTES_DISPLAY_LIMIT + 5);
  });

  test("no advisory when nothing is unsettled", () => {
    const view = computeReconciliationRunView(
      { notes: manyNotes(2), unsettledGaps: [] },
      false,
    );
    expect(view.advisoryGaps).toEqual([]);
  });
});

describe("computeReconciliationRunView — notes truncation/collapse, unchanged", () => {
  test("at or below the inline threshold, notes show inline with no toggle", () => {
    const view = computeReconciliationRunView(
      { notes: manyNotes(RUN_NOTES_INLINE_THRESHOLD), unsettledGaps: [] },
      false,
    );
    expect(view.notesCollapsible).toBe(false);
    expect(view.showNotes).toBe(true);
  });

  test("above the inline threshold, notes collapse until expanded", () => {
    const collapsed = computeReconciliationRunView(
      { notes: manyNotes(RUN_NOTES_INLINE_THRESHOLD + 1), unsettledGaps: [] },
      false,
    );
    expect(collapsed.notesCollapsible).toBe(true);
    expect(collapsed.showNotes).toBe(false);

    const expanded = computeReconciliationRunView(
      { notes: manyNotes(RUN_NOTES_INLINE_THRESHOLD + 1), unsettledGaps: [] },
      true,
    );
    expect(expanded.showNotes).toBe(true);
  });

  test("notes past the display limit are sliced, not just visually clipped", () => {
    const view = computeReconciliationRunView(
      { notes: manyNotes(40), unsettledGaps: [] },
      true,
    );
    expect(view.runNotes).toHaveLength(RUN_NOTES_DISPLAY_LIMIT);
  });
});
