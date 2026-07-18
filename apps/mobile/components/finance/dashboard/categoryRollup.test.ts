import { describe, expect, test } from "@jest/globals";
import { categoryRollup } from "./categoryRollup";

describe("categoryRollup", () => {
  test("sums same-named categories across cards, sorted descending", () => {
    const cards = [
      { categories: [{ name: "Food", spentCents: 5000 }, { name: "Travel", spentCents: 2000 }] },
      { categories: [{ name: "Food", spentCents: 3000 }] },
    ];
    const result = categoryRollup(cards, 10000);
    expect(result.top).toEqual([
      { name: "Food", spentCents: 8000 },
      { name: "Travel", spentCents: 2000 },
    ]);
    expect(result.otherCents).toBe(0); // 10000 - 10000
  });

  test("caps at topN and clamps otherCents at 0 even when categorized exceeds period spend", () => {
    const cards = [
      {
        categories: [
          { name: "A", spentCents: 100 },
          { name: "B", spentCents: 90 },
          { name: "C", spentCents: 80 },
          { name: "D", spentCents: 70 },
          { name: "E", spentCents: 60 },
          { name: "F", spentCents: 50 },
          { name: "G", spentCents: 40 },
        ],
      },
    ];
    // periodSpendCents deliberately smaller than the categorized sum (490) —
    // the documented one-time-cumulative-vs-period mismatch.
    const result = categoryRollup(cards, 100, 6);
    expect(result.top).toHaveLength(6);
    expect(result.top[0]).toEqual({ name: "A", spentCents: 100 });
    expect(result.otherCents).toBe(0);
  });

  test("cards with no categories field don't throw", () => {
    const result = categoryRollup([{}, { categories: null }], 500);
    expect(result.top).toEqual([]);
    expect(result.otherCents).toBe(500);
    expect(result.maxCents).toBe(500);
  });

  test("maxCents is never 0 (avoids divide-by-zero bar widths)", () => {
    const result = categoryRollup([], 0);
    expect(result.maxCents).toBe(1);
  });
});
