// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors `lib/financeSeats.test.ts`).
import { describe, expect, test } from "@jest/globals";
import { findMergeTargetItem, type MergeTargetItem } from "./duplicateMatch";

describe("findMergeTargetItem", () => {
  test("finds the event_item row whose label shares a significant token with the line's", () => {
    const candidates: MergeTargetItem[] = [
      { itemId: "item1", label: "Sound tech", plannedCents: 15000 },
    ];
    expect(findMergeTargetItem("Sound tech deposit", candidates)).toEqual(candidates[0]);
  });

  test("returns null when no candidate item overlaps — never guesses", () => {
    const candidates: MergeTargetItem[] = [
      { itemId: "item1", label: "Coffee run", plannedCents: 4000 },
    ];
    expect(findMergeTargetItem("Sound tech deposit", candidates)).toBeNull();
  });

  test("returns null for an empty candidate list (e.g. the only overlap was a vendor row — never a valid merge target)", () => {
    expect(findMergeTargetItem("Sound tech deposit", [])).toBeNull();
  });

  test("short/stopword-only labels never match (mirrors moneyViews.ts's significantTokens floor)", () => {
    const candidates: MergeTargetItem[] = [
      { itemId: "item1", label: "The fee", plannedCents: 500 },
    ];
    expect(findMergeTargetItem("The cost fee", candidates)).toBeNull();
  });

  test("picks the FIRST overlapping candidate deterministically when multiple items match", () => {
    const candidates: MergeTargetItem[] = [
      { itemId: "item1", label: "Sound tech setup", plannedCents: 10000 },
      { itemId: "item2", label: "Sound tech teardown", plannedCents: 5000 },
    ];
    expect(findMergeTargetItem("Sound tech deposit", candidates)).toEqual(candidates[0]);
  });
});
