// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors `receiptsTab/helpers.test.ts`).
import { describe, expect, test } from "@jest/globals";
import {
  clampPage,
  clampZoom,
  documentsToEvict,
  MAX_ZOOM,
  MIN_ZOOM,
  pageCacheKey,
  renderScaleForZoom,
  stepZoom,
  ZOOM_STEPS,
} from "./pdfPages.shared";

/**
 * The viewer's PDF machinery, tested where it is pure. The owner's complaint
 * was as much about SPEED as correctness ("really fast for them to do what
 * they need to do"), and the cache policy below is what makes re-opening a
 * receipt free — so it is worth pinning rather than trusting.
 */

describe("documentsToEvict — bounded cache, oldest first", () => {
  test("evicts nothing while under the cap", () => {
    expect(
      documentsToEvict([
        { url: "a", at: 1 },
        { url: "b", at: 2 },
      ]),
    ).toEqual([]);
  });

  test("evicts the least-recently-touched document past the cap", () => {
    expect(
      documentsToEvict([
        { url: "b", at: 20 },
        { url: "oldest", at: 1 },
        { url: "c", at: 30 },
        { url: "d", at: 40 },
      ]),
    ).toEqual(["oldest"]);
  });

  test("evicts as many as needed, in age order", () => {
    expect(
      documentsToEvict(
        [
          { url: "a", at: 5 },
          { url: "b", at: 1 },
          { url: "c", at: 9 },
          { url: "d", at: 3 },
        ],
        2,
      ),
    ).toEqual(["b", "d"]);
  });
});

describe("renderScaleForZoom — two buckets, not a slider", () => {
  test("stays on the base bitmap through 2× so zooming doesn't re-render", () => {
    expect(renderScaleForZoom(1)).toBe(2);
    expect(renderScaleForZoom(1.5)).toBe(2);
    expect(renderScaleForZoom(2)).toBe(2);
  });

  test("re-renders once, sharper, past 2×", () => {
    expect(renderScaleForZoom(3)).toBe(4);
    expect(renderScaleForZoom(8)).toBe(4);
  });

  test("the cache key separates the two bitmaps of the same page", () => {
    expect(pageCacheKey(2, renderScaleForZoom(1))).not.toBe(
      pageCacheKey(2, renderScaleForZoom(4)),
    );
    expect(pageCacheKey(2, 2)).toBe(pageCacheKey(2, 2));
  });
});

describe("clampPage — the ‹ › buttons and arrow keys can't run off either end", () => {
  test("clamps into range", () => {
    expect(clampPage(0, 5)).toBe(1);
    expect(clampPage(9, 5)).toBe(5);
    expect(clampPage(3, 5)).toBe(3);
  });

  test("a document whose page count isn't known yet stays on page 1", () => {
    expect(clampPage(4, 1)).toBe(1);
    expect(clampPage(2, 0)).toBe(1);
    expect(clampPage(NaN, 5)).toBe(1);
  });
});

describe("stepZoom — the +/− ladder", () => {
  test("walks the rungs in both directions", () => {
    expect(stepZoom(1, 1)).toBe(1.5);
    expect(stepZoom(1.5, 1)).toBe(2);
    expect(stepZoom(2, -1)).toBe(1.5);
  });

  test("stops at the ends rather than running away", () => {
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
  });

  test("snaps a between-rungs value (what wheel-zoom produces) to the next rung", () => {
    expect(stepZoom(1.7, 1)).toBe(2);
    expect(stepZoom(1.7, -1)).toBe(1.5);
  });

  test("fit is the first rung, so 'reset' is exactly it", () => {
    expect(ZOOM_STEPS[0]).toBe(MIN_ZOOM);
  });
});

describe("clampZoom — wheel input is arbitrary", () => {
  test("holds the bounds and survives nonsense", () => {
    expect(clampZoom(0.2)).toBe(MIN_ZOOM);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(2.4)).toBe(2.4);
    expect(clampZoom(NaN)).toBe(MIN_ZOOM);
  });
});
