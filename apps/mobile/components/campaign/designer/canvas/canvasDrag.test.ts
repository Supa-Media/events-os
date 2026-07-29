/**
 * DRAG-TO-REORDER ON THE CANVAS, end to end — as arithmetic.
 *
 * The composer's drag path is three pieces with nothing between them:
 *
 *   the gesture's screen translation
 *     → `contentTranslationY` / `dropOrder`   (components/grid/sortableRowMath)
 *     → `reorderBlocks` + `pushHistory`       (lib/emailDesigner)
 *
 * so a test that walks all three answers the question the canvas can't answer
 * for itself in a node environment: does dragging the last block of a real
 * newsletter to the top actually put it there — on a PHONE, where the document
 * is drawn at about 0.6 and the finger travels 40% less than the document
 * does.
 */
import { describe, expect, test } from "@jest/globals";
import type { EmailBlock, EmailDocument } from "@events-os/shared";
import {
  contentTranslationY,
  dropOrder,
} from "../../../grid/sortableRowMath";
import {
  initHistory,
  pushHistory,
  reorderBlocks,
  undoHistory,
} from "../../../../lib/emailDesigner";
import { CANVAS_WIDTH, canvasScale } from "./canvasStyles";

/** The newsletter the product owner actually sends: about fifteen blocks. */
const doc: EmailDocument = {
  blocks: Array.from(
    { length: 15 },
    (_, i): EmailBlock => ({ id: `b${i}`, kind: "heading", text: `Section ${i}`, level: 2 }),
  ),
};
const ids = doc.blocks.map((b) => b.id);
/** What each block measures in DOCUMENT px — `onLayout` reports the layout
 *  box, which a transform never touches, so these stay 120 at any scale. */
const heights = doc.blocks.map(() => 120);

/** A phone: the canvas column is narrower than the email's own 600px. */
const PHONE_COLUMN = 360;
const scale = canvasScale(PHONE_COLUMN);

/** One drag, from the gesture's screen pixels to the new document. */
function drag(
  from: EmailDocument,
  blockId: string,
  screenTranslationY: number,
  atScale: number,
): EmailDocument {
  const order = dropOrder(
    from.blocks.map((b) => b.id),
    blockId,
    contentTranslationY(screenTranslationY, atScale),
    heights,
  );
  return order ? reorderBlocks(from, order) : from;
}

describe("the canvas is drawn smaller than the document", () => {
  test("a phone column really does scale the email down", () => {
    expect(scale).toBeLessThan(1);
    expect(scale).toBeCloseTo(PHONE_COLUMN / CANVAS_WIDTH);
  });
});

describe("dragging the last block to the top", () => {
  // On screen, fourteen 120px blocks drawn at `scale` — plus a little, to
  // clear the first block's centre.
  const fingerTravel = -(14 * 120 * scale + 60);

  test("at 1:1 it lands first", () => {
    const next = drag(doc, "b14", -(14 * 120 + 60), 1);
    expect(next.blocks[0].id).toBe("b14");
  });

  test("at a phone's scale it lands first too — the whole point", () => {
    const next = drag(doc, "b14", fingerTravel, scale);
    expect(next.blocks[0].id).toBe("b14");
    expect(next.blocks.map((b) => b.id)).toEqual(["b14", ...ids.slice(0, 14)]);
  });

  test("without the scale it lands in the middle of the newsletter", () => {
    // The same finger travel, read as though the document were 1:1.
    const naive = drag(doc, "b14", fingerTravel, 1);
    expect(naive.blocks[0].id).not.toBe("b14");
    expect(naive.blocks.findIndex((b) => b.id === "b14")).toBeGreaterThan(3);
  });

  test("no block is lost or duplicated, whatever the scale", () => {
    for (const s of [1, 0.9, scale, 0.4]) {
      const next = drag(doc, "b14", fingerTravel, s);
      expect(next.blocks).toHaveLength(doc.blocks.length);
      expect(new Set(next.blocks.map((b) => b.id)).size).toBe(doc.blocks.length);
    }
  });
});

describe("a drop is one history step and one save", () => {
  test("undo puts the block back exactly where it was", () => {
    const history = initHistory(doc);
    const dropped = drag(doc, "b14", -(14 * 120 * scale + 60), scale);
    const after = pushHistory(history, dropped);
    expect(after.present.blocks[0].id).toBe("b14");
    // One step — not one per animation frame, which is what a canvas that
    // reordered on every `onUpdate` would have pushed.
    expect(after.past).toHaveLength(1);
    expect(undoHistory(after).present).toBe(doc);
  });

  test("a drag that ends where it started produces no order at all", () => {
    // `SortableRows` never calls `onReorder`, so the composer never pushes a
    // history step and the autosave never fires.
    expect(dropOrder(ids, "b7", contentTranslationY(-4, scale), heights)).toBeNull();
  });
});
