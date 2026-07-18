import { describe, expect, test } from "@jest/globals";
import { chartScaleMaxCents, heightPct } from "./monthBarsGeometry";

describe("chartScaleMaxCents", () => {
  test("scales to the largest bar with ~15% headroom", () => {
    expect(chartScaleMaxCents([100, 500, 200], null)).toBe(575); // 500 * 1.15
  });

  test("a cap taller than every bar drives the scale", () => {
    expect(chartScaleMaxCents([100, 200], 1000)).toBe(1150);
  });

  test("an all-zero year with no cap never divides by zero", () => {
    expect(chartScaleMaxCents([0, 0, 0], null)).toBe(1);
  });
});

describe("heightPct", () => {
  test("proportional to scale, clamped to [0, 100]", () => {
    expect(heightPct(50, 100)).toBe(50);
    expect(heightPct(0, 100)).toBe(0);
    expect(heightPct(150, 100)).toBe(100);
    expect(heightPct(-10, 100)).toBe(0);
  });

  test("a zero scale never divides by zero", () => {
    expect(heightPct(50, 0)).toBe(0);
  });
});
