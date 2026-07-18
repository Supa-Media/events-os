import { describe, expect, test } from "@jest/globals";
import { fleetBudgetPct, fleetHealthKind } from "./fleetHealth";

describe("fleetHealthKind", () => {
  test("under water outranks everything else", () => {
    expect(
      fleetHealthKind({
        underWaterCents: 100,
        unattributedCount: 3,
        spendYtdCents: 500,
        budgetYtdCents: 100,
      }),
    ).toBe("under_water");
  });

  test("unattributed spend, no under-water figure -> needs attention", () => {
    expect(
      fleetHealthKind({
        underWaterCents: 0,
        unattributedCount: 1,
        spendYtdCents: 100,
        budgetYtdCents: 1000,
      }),
    ).toBe("needs_attention");
  });

  test("over budget with nothing unattributed -> needs attention", () => {
    expect(
      fleetHealthKind({
        underWaterCents: null,
        unattributedCount: 0,
        spendYtdCents: 1100,
        budgetYtdCents: 1000,
      }),
    ).toBe("needs_attention");
  });

  test("a zero budget with zero spend is never 'over budget'", () => {
    expect(
      fleetHealthKind({
        underWaterCents: null,
        unattributedCount: 0,
        spendYtdCents: 0,
        budgetYtdCents: 0,
      }),
    ).toBe("healthy");
  });

  test("clean row -> healthy", () => {
    expect(
      fleetHealthKind({
        underWaterCents: null,
        unattributedCount: 0,
        spendYtdCents: 500,
        budgetYtdCents: 1000,
      }),
    ).toBe("healthy");
  });

  test("central row (no affordability) can still be needs_attention/healthy, never under_water", () => {
    expect(
      fleetHealthKind({
        underWaterCents: null,
        unattributedCount: 5,
        spendYtdCents: 0,
        budgetYtdCents: 0,
      }),
    ).toBe("needs_attention");
  });
});

describe("fleetBudgetPct", () => {
  test("normal ratio, rounded", () => {
    expect(fleetBudgetPct(9100, 9700)).toBe(94);
  });

  test("zero budget, real spend -> 100 (unfunded overspend, loud)", () => {
    expect(fleetBudgetPct(500, 0)).toBe(100);
  });

  test("zero budget, zero spend -> 0", () => {
    expect(fleetBudgetPct(0, 0)).toBe(0);
  });

  test("uncapped past 100", () => {
    expect(fleetBudgetPct(2000, 1000)).toBe(200);
  });
});
