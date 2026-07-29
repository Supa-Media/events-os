import { describe, expect, test } from "@jest/globals";
import {
  contentTranslationY,
  dropOrder,
  resolveTargetIndex,
  safeScale,
} from "./sortableRowMath";

/** Fifteen rows of 100px — the email canvas's newsletter, near enough. */
const heights = Array.from({ length: 15 }, () => 100);
const ids = Array.from({ length: 15 }, (_, i) => `b${i}`);

describe("safeScale", () => {
  test("an absent or nonsense scale means unscaled, never a division by zero", () => {
    expect(safeScale(undefined)).toBe(1);
    expect(safeScale(0)).toBe(1);
    expect(safeScale(-0.5)).toBe(1);
    expect(safeScale(Number.NaN)).toBe(1);
    expect(safeScale(0.6)).toBe(0.6);
  });
});

describe("contentTranslationY", () => {
  test("a list drawn at 1:1 is the identity — every caller but the canvas", () => {
    expect(contentTranslationY(-850)).toBe(-850);
    expect(contentTranslationY(-850, 1)).toBe(-850);
  });

  test("a list drawn at 0.6 travels further in its own units than the finger did", () => {
    // 60 screen px of finger is 100px of a document drawn at 0.6.
    expect(contentTranslationY(-60, 0.6)).toBeCloseTo(-100);
  });
});

describe("resolveTargetIndex", () => {
  test("a row moves past every row whose centre it has passed", () => {
    // Row 0 dragged down 250px: its centre is 50 + 250 = 300, past the
    // centres of rows 1 (150) and 2 (250) but not row 3's (350).
    expect(resolveTargetIndex(0, 250, heights)).toBe(2);
  });

  test("a drag that ends where it began moves nothing", () => {
    // The asymmetric version of this rule made a zero-distance drop resolve
    // to `from + 1` — a reorder, a history step and a save for a drag the
    // designer thought better of.
    expect(resolveTargetIndex(7, 0, heights)).toBe(7);
    expect(resolveTargetIndex(7, 20, heights)).toBe(7);
    expect(resolveTargetIndex(7, -20, heights)).toBe(7);
  });

  test("variable heights are respected, not averaged", () => {
    // Centres: 20, 190, 360, 400.
    const tall = [40, 300, 40, 40];
    // The last row dragged up 120px has its centre at 400 - 120 = 280, which
    // has NOT passed the 300px-tall row's centre (360) — so it lands just
    // after it, at 2. A fixed row height would have said 1 and jumped it over
    // a row three hundred pixels tall.
    expect(resolveTargetIndex(3, -120, tall)).toBe(2);
  });

  test("never off the ends", () => {
    expect(resolveTargetIndex(14, -99999, heights)).toBe(0);
    expect(resolveTargetIndex(0, 99999, heights)).toBe(14);
  });
});

describe("dropOrder", () => {
  test("dropping a row back where it started changes nothing", () => {
    expect(dropOrder(ids, "b7", 0, heights)).toBeNull();
  });

  test("an id the list no longer holds is ignored rather than reordering blind", () => {
    expect(dropOrder(ids, "gone", -1500, heights)).toBeNull();
  });

  test("the last row dragged to the top comes back first", () => {
    const next = dropOrder(ids, "b14", -1450, heights);
    expect(next?.[0]).toBe("b14");
    expect(next?.slice(1)).toEqual(ids.slice(0, 14));
  });
});

/**
 * THE SCALE BUG, stated as arithmetic.
 *
 * The email canvas draws its 600px document at `canvasScale(width)` — about
 * 0.6 on a phone. Row heights come from `onLayout`, which reports the layout
 * box and is therefore in DOCUMENT px; the pan gesture reports SCREEN px.
 * Comparing them directly is a drop that lands nowhere near the finger.
 */
describe("a list drawn at less than 1:1", () => {
  const SCALE = 0.6;
  // To put the last of fifteen 100px blocks above the first, the finger
  // travels the height of fourteen blocks AS DRAWN: 14 × 100 × 0.6 = 840px,
  // plus enough to clear the first block's centre.
  const fingerTravel = -880;

  test("compensated, the drop lands where the finger let go: the top", () => {
    const next = dropOrder(
      ids,
      "b14",
      contentTranslationY(fingerTravel, SCALE),
      heights,
    );
    expect(next?.[0]).toBe("b14");
  });

  test("uncompensated, the SAME drag stops six rows short of the top", () => {
    // What the canvas would do if it handed the gesture's screen px straight
    // to a list measured in document px: the drag reads as 880 document px
    // rather than 1467, so the block is dropped in the middle of the
    // newsletter. This is the bug the `scale` prop exists to prevent.
    const naive = dropOrder(ids, "b14", fingerTravel, heights);
    expect(naive?.indexOf("b14")).toBe(6);
  });

  test("the visual translation is the same conversion, so the row follows the finger", () => {
    // `SortableRow`'s worklet divides by the same scale: a row translated by
    // T inside a parent scaled by s moves s×T on screen, so it only keeps up
    // with an 840px drag if it is told to move 1400.
    const t = contentTranslationY(-840, SCALE);
    expect(t).toBeCloseTo(-1400);
    expect(t * SCALE).toBeCloseTo(-840);
  });
});
