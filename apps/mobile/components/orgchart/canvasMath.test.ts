import { describe, expect, test } from "@jest/globals";
import {
  IDENTITY_TRANSFORM,
  MAX_SCALE,
  MIN_SCALE,
  clampScale,
  clampTranslation,
  computeFitTransform,
  panBy,
  zoomAroundPoint,
  type Transform,
} from "./canvasMath";

describe("clampScale", () => {
  test("passes values inside the range through unchanged", () => {
    expect(clampScale(1)).toBe(1);
    expect(clampScale(0.75)).toBe(0.75);
  });

  test("clamps below MIN_SCALE and above MAX_SCALE", () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(50)).toBe(MAX_SCALE);
  });

  test("falls back to 1 for non-finite input", () => {
    expect(clampScale(NaN)).toBe(1);
    expect(clampScale(Infinity)).toBe(1);
  });
});

describe("zoomAroundPoint", () => {
  test("keeps the canvas-space point under the pointer fixed on screen", () => {
    const t: Transform = { x: 0, y: 0, scale: 1 };
    const pointer = { x: 100, y: 50 };
    const worldBefore = { x: (pointer.x - t.x) / t.scale, y: (pointer.y - t.y) / t.scale };

    const next = zoomAroundPoint(t, pointer, 2); // zoom in 2x
    expect(next.scale).toBe(2);

    const worldAfter = { x: (pointer.x - next.x) / next.scale, y: (pointer.y - next.y) / next.scale };
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 6);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 6);
  });

  test("zooming out also anchors to the pointer", () => {
    const t: Transform = { x: -40, y: 20, scale: 1.5 };
    const pointer = { x: 300, y: 200 };
    const worldBefore = { x: (pointer.x - t.x) / t.scale, y: (pointer.y - t.y) / t.scale };

    const next = zoomAroundPoint(t, pointer, 0.5);
    const worldAfter = { x: (pointer.x - next.x) / next.scale, y: (pointer.y - next.y) / next.scale };
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 6);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 6);
  });

  test("is a no-op once already clamped at the max, so it never drifts pan", () => {
    const t: Transform = { x: 10, y: 10, scale: MAX_SCALE };
    const next = zoomAroundPoint(t, { x: 0, y: 0 }, 3);
    expect(next).toBe(t);
  });

  test("is a no-op once already clamped at the min", () => {
    const t: Transform = { x: 10, y: 10, scale: MIN_SCALE };
    const next = zoomAroundPoint(t, { x: 0, y: 0 }, 0.1);
    expect(next).toBe(t);
  });

  test("clamps mid-zoom instead of overshooting past MAX_SCALE", () => {
    const t: Transform = { x: 0, y: 0, scale: 1.8 };
    const next = zoomAroundPoint(t, { x: 0, y: 0 }, 2);
    expect(next.scale).toBe(MAX_SCALE);
  });
});

describe("panBy", () => {
  test("translates without touching scale", () => {
    const t: Transform = { x: 5, y: -5, scale: 1.25 };
    expect(panBy(t, 10, -20)).toEqual({ x: 15, y: -25, scale: 1.25 });
  });
});

describe("clampTranslation", () => {
  const container = { width: 800, height: 600 };

  test("leaves translation untouched when content is comfortably in view", () => {
    const t: Transform = { x: 100, y: 100, scale: 1 };
    const content = { width: 400, height: 300 };
    expect(clampTranslation(t, container, content)).toEqual(t);
  });

  test("pulls back a large content rect panned far off the left/top edge", () => {
    const t: Transform = { x: -5000, y: -5000, scale: 1 };
    const content = { width: 2000, height: 2000 };
    const clamped = clampTranslation(t, container, content, 120);
    // At least `margin` px of content must remain visible: x + contentW*scale >= margin
    expect(clamped.x + content.width).toBeGreaterThanOrEqual(120 - 0.001);
    expect(clamped.y + content.height).toBeGreaterThanOrEqual(120 - 0.001);
  });

  test("pulls back content panned far off the right/bottom edge", () => {
    const t: Transform = { x: 5000, y: 5000, scale: 1 };
    const content = { width: 2000, height: 2000 };
    const clamped = clampTranslation(t, container, content, 120);
    expect(clamped.x).toBeLessThanOrEqual(container.width - 120 + 0.001);
    expect(clamped.y).toBeLessThanOrEqual(container.height - 120 + 0.001);
  });

  test("handles content SMALLER than the container without inverting the clamp range", () => {
    const t: Transform = { x: 9999, y: -9999, scale: 1 };
    const content = { width: 100, height: 80 };
    const clamped = clampTranslation(t, container, content, 120);
    // Must produce finite, sane values — not NaN from an inverted min/max range.
    expect(Number.isFinite(clamped.x)).toBe(true);
    expect(Number.isFinite(clamped.y)).toBe(true);
  });

  test("respects the current scale when computing the scaled content size", () => {
    const t: Transform = { x: -5000, y: 0, scale: 2 };
    const content = { width: 1000, height: 1000 };
    const clamped = clampTranslation(t, container, content, 120);
    // scaled content width is 2000; same "keep margin visible" invariant applies.
    expect(clamped.x + content.width * t.scale).toBeGreaterThanOrEqual(120 - 0.001);
  });
});

describe("computeFitTransform", () => {
  test("centers and scales content down to fit within padding", () => {
    const container = { width: 1000, height: 800 };
    const content = { width: 2000, height: 400 }; // wide, short — width-bound
    const fit = computeFitTransform(container, content, 40);
    const availW = 1000 - 80;
    expect(fit.scale).toBeCloseTo(availW / 2000, 6);
    expect(fit.x).toBeCloseTo((1000 - 2000 * fit.scale) / 2, 6);
    expect(fit.y).toBeCloseTo((800 - 400 * fit.scale) / 2, 6);
  });

  test("never scales UP past 100% for small content", () => {
    const container = { width: 1000, height: 800 };
    const content = { width: 100, height: 80 };
    const fit = computeFitTransform(container, content, 40);
    expect(fit.scale).toBeLessThanOrEqual(1);
  });

  test("clamps scale to MIN_SCALE for enormous content instead of vanishing", () => {
    const container = { width: 1000, height: 800 };
    const content = { width: 100000, height: 100000 };
    const fit = computeFitTransform(container, content, 40);
    expect(fit.scale).toBe(MIN_SCALE);
  });

  test("falls back to identity for degenerate (zero-size) inputs", () => {
    expect(computeFitTransform({ width: 0, height: 800 }, { width: 100, height: 100 })).toEqual(
      IDENTITY_TRANSFORM,
    );
    expect(computeFitTransform({ width: 800, height: 800 }, { width: 0, height: 100 })).toEqual(
      IDENTITY_TRANSFORM,
    );
  });
});
