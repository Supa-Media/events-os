import { describe, expect, test } from "@jest/globals";
import { categoryRollup } from "./categoryRollup";

describe("categoryRollup", () => {
  test("month mode: sums recurring categories only, one-time cards excluded entirely", () => {
    const oneTime = [{ categories: [{ name: "Catering", spentCents: 900000 }] }]; // cumulative, would swamp the month figure
    const recurring = [
      { categories: [{ name: "Food", spentCents: 5000 }, { name: "Travel", spentCents: 2000 }] },
      { categories: [{ name: "Food", spentCents: 3000 }] },
    ];
    const result = categoryRollup(oneTime, recurring, 10000, "month");
    expect(result.top).toEqual([
      { name: "Food", spentCents: 8000 },
      { name: "Travel", spentCents: 2000 },
    ]);
    expect(result.otherCents).toBe(0); // 10000 - 10000
    expect(result.caption).toBe("Recurring spend by category — event budgets excluded");
  });

  test("ytd mode: includes both one-time (cumulative) and recurring categories", () => {
    const oneTime = [{ categories: [{ name: "Catering", spentCents: 90000 }] }];
    const recurring = [{ categories: [{ name: "Food", spentCents: 30000 }] }];
    const result = categoryRollup(oneTime, recurring, 120000, "ytd");
    expect(result.top).toEqual([
      { name: "Catering", spentCents: 90000 },
      { name: "Food", spentCents: 30000 },
    ]);
    expect(result.otherCents).toBe(0);
    expect(result.caption).toBe("Spend by category · YTD");
  });

  test("caps at topN and clamps otherCents at 0 for the residual-rounding case", () => {
    const recurring = [
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
    const result = categoryRollup([], recurring, 100, "month", 6);
    expect(result.top).toHaveLength(6);
    expect(result.top[0]).toEqual({ name: "A", spentCents: 100 });
    expect(result.otherCents).toBe(0);
  });

  test("cards with no categories field don't throw", () => {
    const result = categoryRollup([{}], [{ categories: null }], 500, "month");
    expect(result.top).toEqual([]);
    expect(result.otherCents).toBe(500);
    expect(result.maxCents).toBe(500);
  });

  test("maxCents is never 0 (avoids divide-by-zero bar widths)", () => {
    const result = categoryRollup([], [], 0, "ytd");
    expect(result.maxCents).toBe(1);
  });
});
