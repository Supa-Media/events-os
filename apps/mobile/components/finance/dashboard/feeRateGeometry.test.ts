import { describe, expect, test } from "@jest/globals";
import { formatRateBps, rateScaleMaxBps } from "./feeRateGeometry";

describe("rateScaleMaxBps", () => {
  test("scales to the largest rate with ~15% headroom", () => {
    expect(rateScaleMaxBps([290, 340, 260])).toBe(391); // 340 * 1.15
  });

  test("a null month is skipped, not counted as zero", () => {
    // The scale is the 3.40% month's, exactly as if the gaps weren't there —
    // a gap has no height, so it must have no say in the height of anything.
    expect(rateScaleMaxBps([null, 340, null])).toBe(rateScaleMaxBps([340]));
  });

  test("an all-gap series still has an axis instead of dividing by zero", () => {
    expect(rateScaleMaxBps([null, null, null])).toBe(100);
    expect(rateScaleMaxBps([])).toBe(100);
  });

  test("a genuinely zero rate is floored at the 1% axis, not collapsed", () => {
    // Fees of 0 on real volume is a rate — it just happens to be 0%. It draws
    // a flat bar against a real axis, unlike a gap, which draws nothing.
    expect(rateScaleMaxBps([0])).toBe(100);
  });
});

describe("formatRateBps", () => {
  test("two decimals, always — the monitor's signal lives in hundredths", () => {
    expect(formatRateBps(294)).toBe("2.94%");
    expect(formatRateBps(300)).toBe("3.00%");
    expect(formatRateBps(0)).toBe("0.00%");
    expect(formatRateBps(1_050)).toBe("10.50%");
  });
});
