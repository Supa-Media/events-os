import { describe, expect, test } from "vitest";
import { applyByNotice, isValidApplyBy } from "./applyBy";

describe("apply-by date", () => {
  test("only real YYYY-MM-DD days are valid", () => {
    expect(isValidApplyBy("2026-11-01")).toBe(true);
    expect(isValidApplyBy("2026-02-30")).toBe(false);
    expect(isValidApplyBy("Nov 1")).toBe(false);
    expect(isValidApplyBy("2026-11-1")).toBe(false);
  });

  test("reads 'Apply by Nov 1' up to and including the day, in Eastern time", () => {
    const oct26 = new Date("2026-10-26T15:00:00Z");
    expect(applyByNotice("2026-11-01", oct26)).toBe("Apply by Nov 1");
    // 11pm Eastern on Nov 1 is already Nov 2 in UTC — still the day.
    expect(applyByNotice("2026-11-01", new Date("2026-11-02T03:30:00Z"))).toBe(
      "Apply by Nov 1",
    );
    // Gone once the day has passed in New York.
    expect(applyByNotice("2026-11-01", new Date("2026-11-02T05:30:00Z"))).toBeNull();
  });

  test("names the year only when it isn't this one, and ignores junk", () => {
    const oct26 = new Date("2026-10-26T15:00:00Z");
    expect(applyByNotice("2027-01-15", oct26)).toBe("Apply by Jan 15, 2027");
    expect(applyByNotice(undefined, oct26)).toBeNull();
    expect(applyByNotice("soon", oct26)).toBeNull();
  });
});
