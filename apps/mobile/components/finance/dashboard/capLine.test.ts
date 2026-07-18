import { describe, expect, test } from "@jest/globals";
import { monthlyOperatingCapCents } from "./capLine";

describe("monthlyOperatingCapCents", () => {
  test("null when there are no monthly-cadence buckets", () => {
    expect(
      monthlyOperatingCapCents([{ cadence: "quarterly", budgetCents: 30000 }], "month", 3),
    ).toBeNull();
    expect(monthlyOperatingCapCents([], "month", 3)).toBeNull();
  });

  test("month mode: sums monthly-cadence caps as-is (already one month)", () => {
    const recurring = [
      { cadence: "monthly", budgetCents: 100000 },
      { cadence: "monthly", budgetCents: 50000 },
      { cadence: "quarterly", budgetCents: 900000 }, // excluded — not monthly cadence
    ];
    expect(monthlyOperatingCapCents(recurring, "month", 7)).toBe(150000);
  });

  test("ytd mode: normalizes the elapsed-months sum back to one month", () => {
    // A single unrestricted $1,000/mo bucket, YTD through month 4 → dashboardChapter
    // reports 4 * $1,000 = $4,000 as `budgetCents`; dividing by 4 recovers $1,000.
    const recurring = [{ cadence: "monthly", budgetCents: 400000 }];
    expect(monthlyOperatingCapCents(recurring, "ytd", 4)).toBe(100000);
  });

  test("ytd mode: throughMonth is floored at 1 (never divides by 0)", () => {
    const recurring = [{ cadence: "monthly", budgetCents: 100000 }];
    expect(monthlyOperatingCapCents(recurring, "ytd", 0)).toBe(100000);
  });
});
