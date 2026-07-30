import { clampPopperLeft } from "./pwPopperClamp";

describe("clampPopperLeft", () => {
  it("pulls a popover flush against the left viewport edge (x=0) in by the margin", () => {
    const result = clampPopperLeft("translate(0px, 925px)", 1200, 620, 8);
    expect(result).toBe("translate(8px, 925px)");
  });

  it("pulls a popover that overflows the RIGHT edge back in by the margin", () => {
    // 1200 viewport, 620-wide popover placed at x=700 -> right edge at 1320, past 1200.
    const result = clampPopperLeft("translate(700px, 40px)", 1200, 620, 8);
    expect(result).toBe("translate(572px, 40px)");
  });

  it("returns null (nothing to correct) when already fully on-screen with margin to spare", () => {
    const result = clampPopperLeft("translate(300px, 40px)", 1200, 620, 8);
    expect(result).toBeNull();
  });

  it("is idempotent: re-clamping an already-clamped value returns null", () => {
    const first = clampPopperLeft("translate(0px, 925px)", 1200, 620, 8);
    expect(first).toBe("translate(8px, 925px)");
    const second = clampPopperLeft(first as string, 1200, 620, 8);
    expect(second).toBeNull();
  });

  it("centers the popover when it's wider than the viewport itself (margins can't both be satisfied)", () => {
    const result = clampPopperLeft("translate(-200px, 10px)", 400, 620, 8);
    // (400 - 620) / 2 = -110
    expect(result).toBe("translate(-110px, 10px)");
  });

  it("centering never makes overflow WORSE than Radix's own x:0 — the regression this function exists to avoid", () => {
    // 600px viewport, 620px popover: Radix's own `shift` already lands at
    // x:0 (20px right-edge overflow). A naive `margin`-floor clamp would
    // push to x:8 (28px overflow — WORSE). Centering keeps total overflow
    // symmetric and no worse than Radix's own number on either edge.
    const result = clampPopperLeft("translate(0px, 436px)", 600, 620, 8);
    const clampedX = Number((result as string).match(/translate\((-?[\d.]+)px/)![1]);
    const rightOverflow = clampedX + 620 - 600;
    const leftOverflow = -clampedX;
    expect(Math.max(rightOverflow, leftOverflow)).toBeLessThanOrEqual(20);
  });

  it("preserves the Y offset untouched", () => {
    const result = clampPopperLeft("translate(-50px, 123.5px)", 1200, 620, 8);
    expect(result).toBe("translate(8px, 123.5px)");
  });

  it("handles fractional X offsets — already within [8, 572] here, so no correction", () => {
    const result = clampPopperLeft("translate(107.359375px, 925px)", 1200, 620, 8);
    expect(result).toBeNull();
  });

  it("returns null for a transform that isn't a translate() (unexpected shape)", () => {
    expect(clampPopperLeft("scale(1)", 1200, 620, 8)).toBeNull();
    expect(clampPopperLeft("none", 1200, 620, 8)).toBeNull();
    expect(clampPopperLeft("", 1200, 620, 8)).toBeNull();
  });

  it("uses the default margin of 8 when not passed", () => {
    const result = clampPopperLeft("translate(0px, 0px)", 1200, 620);
    expect(result).toBe("translate(8px, 0px)");
  });
});
