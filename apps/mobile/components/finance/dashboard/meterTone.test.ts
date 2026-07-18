// No @types/jest / ambient globals configured for this package — import test
// globals explicitly (mirrors `awaitingApproval.test.ts`).
import { describe, expect, test } from "@jest/globals";
import { meterTone, meterFillWidthPct } from "./meterTone";

describe("meterTone", () => {
  test("gold below 85%", () => {
    expect(meterTone(0)).toBe("gold");
    expect(meterTone(50)).toBe("gold");
    expect(meterTone(84)).toBe("gold");
  });

  test("amber from 85% through 100%", () => {
    expect(meterTone(85)).toBe("amber");
    expect(meterTone(92)).toBe("amber");
    expect(meterTone(100)).toBe("amber");
  });

  test("red only strictly over 100%", () => {
    expect(meterTone(101)).toBe("red");
    expect(meterTone(250)).toBe("red");
  });
});

describe("meterFillWidthPct", () => {
  test("clamps to [0, 100]", () => {
    expect(meterFillWidthPct(-10)).toBe(0);
    expect(meterFillWidthPct(0)).toBe(0);
    expect(meterFillWidthPct(60)).toBe(60);
    expect(meterFillWidthPct(100)).toBe(100);
    expect(meterFillWidthPct(150)).toBe(100);
  });
});
