// No @types/jest / ambient globals configured for this package — import test
// globals explicitly (mirrors `meterTone.test.ts`).
import { describe, expect, test } from "@jest/globals";
import { compactCents } from "./compactCents";

describe("compactCents", () => {
  test("under $1,000 prints whole dollars, no cents", () => {
    expect(compactCents(0)).toBe("$0");
    expect(compactCents(50000)).toBe("$500");
    expect(compactCents(99999)).toBe("$1,000"); // $999.99 rounds up in formatCents
  });

  test("$1,000 and up prints one-decimal thousands", () => {
    expect(compactCents(100000)).toBe("$1.0k");
    expect(compactCents(910000)).toBe("$9.1k");
    expect(compactCents(970000)).toBe("$9.7k");
    expect(compactCents(1200000)).toBe("$12.0k");
  });

  test("negative amounts keep the sign in front of the $", () => {
    expect(compactCents(-910000)).toBe("-$9.1k");
    expect(compactCents(-50000)).toBe("-$500");
  });
});
