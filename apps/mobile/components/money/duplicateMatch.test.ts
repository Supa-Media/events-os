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

/**
 * Cross-package pin (PR #239 review): this exact table is mirrored in
 * `apps/convex/tests/moneyViews.test.ts` (asserting the real
 * `possibleDuplicate` flag off the server's `eventCostGrid` query) — same
 * item/line label pairs, same expected duplicate outcome.
 * `duplicateMatch.ts`'s `significantTokens`/`tokensOverlap` is a hand-copied
 * mirror of `moneyViews.ts`'s own private copy (different runtimes — mobile
 * can't import a convex-function file's internals), so nothing enforces they
 * stay in sync except this: if either copy's stopword list, length floor, or
 * split regex drifts, ONE of these two suites fails for the SAME fixture
 * pair. Keep the two tables byte-for-byte identical.
 */
const TOKEN_ALGORITHM_FIXTURES: [string, string, boolean, string][] = [
  ["Sound tech", "Sound tech deposit", true, "shared significant tokens"],
  ["This vendor invoice", "This permit renewal", false, 'only a STOPWORD ("this") overlaps'],
  [
    "PA rental (event agreement)",
    "Event insurance fee",
    true,
    'punctuation-split tokens overlap on "event" (short tokens "pa"/"fee" don\'t count)',
  ],
  ["SOUND CHECK setup", "sound check fee", true, "case-insensitive overlap"],
];

describe("findMergeTargetItem: cross-package token-algorithm pin", () => {
  test.each(TOKEN_ALGORITHM_FIXTURES)(
    "%s vs %s -> match=%s (%s)",
    (itemLabel, lineLabel, expectMatch, _why) => {
      const candidates: MergeTargetItem[] = [
        { itemId: "item1", label: itemLabel, plannedCents: 10000 },
      ];
      const result = findMergeTargetItem(lineLabel, candidates);
      if (expectMatch) {
        expect(result).toEqual(candidates[0]);
      } else {
        expect(result).toBeNull();
      }
    },
  );
});
