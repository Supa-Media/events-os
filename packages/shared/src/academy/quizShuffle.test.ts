import { describe, expect, test } from "vitest";
import { shuffledOptionOrder } from "./quizShuffle";

describe("shuffledOptionOrder", () => {
  test("returns a valid permutation of [0..optionCount)", () => {
    for (const count of [1, 2, 3, 4, 5, 8]) {
      const result = shuffledOptionOrder(count, 12345);
      expect(result.length).toBe(count);
      expect(new Set(result)).toEqual(
        new Set(Array.from({ length: count }, (_, i) => i)),
      );
    }
  });

  test("is deterministic — same seed reproduces the same order", () => {
    // The "stable within one attempt" guarantee: re-deriving with the same
    // seed must not reshuffle.
    const a = shuffledOptionOrder(4, 987654);
    const b = shuffledOptionOrder(4, 987654);
    expect(a).toEqual(b);
  });

  test("different seeds usually produce different orders", () => {
    const a = shuffledOptionOrder(4, 1);
    const b = shuffledOptionOrder(4, 2);
    // Both are still valid permutations...
    expect(new Set(a)).toEqual(new Set([0, 1, 2, 3]));
    expect(new Set(b)).toEqual(new Set([0, 1, 2, 3]));
    // ...and for these seeds the order differs (reshuffle-on-retake works).
    expect(a).not.toEqual(b);
  });

  test("handles degenerate counts safely", () => {
    expect(shuffledOptionOrder(0, 42)).toEqual([]);
    expect(shuffledOptionOrder(1, 42)).toEqual([0]);
  });
});
