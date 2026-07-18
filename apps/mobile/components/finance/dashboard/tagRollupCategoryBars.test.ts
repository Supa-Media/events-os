import { describe, expect, test } from "@jest/globals";
import { tagRollupCategoryBars } from "./tagRollupCategoryBars";

describe("tagRollupCategoryBars", () => {
  test("takes the top N, sums the rest into otherCents", () => {
    const rollups = [
      { tagName: "Fundraisers", spentCents: 500 },
      { tagName: "Retreats", spentCents: 300 },
      { tagName: "Small groups", spentCents: 100 },
    ];
    const result = tagRollupCategoryBars(rollups, 1000, "ytd", 2);
    expect(result.top).toEqual([
      { name: "Fundraisers", spentCents: 500 },
      { name: "Retreats", spentCents: 300 },
    ]);
    // periodSpendCents (1000) - ALL tagged (900, not just top-2's 800) = 100.
    expect(result.otherCents).toBe(100);
    expect(result.maxCents).toBe(500);
    expect(result.caption).toBe("Spend by tag · YTD");
  });

  test("month mode caption", () => {
    expect(tagRollupCategoryBars([], 0, "month").caption).toBe("Spend by tag");
  });

  test("otherCents never goes negative", () => {
    const result = tagRollupCategoryBars([{ tagName: "X", spentCents: 5000 }], 100, "ytd");
    expect(result.otherCents).toBe(0);
  });

  test("maxCents is never 0 even with no data", () => {
    expect(tagRollupCategoryBars([], 0, "ytd").maxCents).toBe(1);
  });
});
