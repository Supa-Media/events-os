// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors `lib/financeSeats.test.ts`).
import { describe, expect, test } from "@jest/globals";
import type { EmailDocument } from "@events-os/shared";
import {
  BLOCK_KINDS,
  canRedo,
  canUndo,
  defaultBlockFor,
  duplicateBlock,
  initHistory,
  insertBlock,
  pushHistory,
  redoHistory,
  removeBlock,
  reorderBlocks,
  undoHistory,
  updateBlock,
  type History,
} from "./emailDesigner";

/** A deterministic id factory for tests — `id1`, `id2`, … in call order. */
function seededIds(prefix = "id"): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

const emptyDoc: EmailDocument = { blocks: [] };

describe("defaultBlockFor", () => {
  test("produces a valid starting block for every kind", () => {
    for (const kind of BLOCK_KINDS) {
      const block = defaultBlockFor(kind, "x");
      expect(block.id).toBe("x");
      expect(block.kind).toBe(kind);
    }
  });
});

describe("insertBlock", () => {
  test("appends to an empty doc when afterId is null", () => {
    const { doc, id } = insertBlock(emptyDoc, "heading", null, seededIds());
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].id).toBe(id);
    expect(doc.blocks[0].kind).toBe("heading");
  });

  test("inserts immediately after the given block", () => {
    const withOne = insertBlock(emptyDoc, "heading", null, seededIds()).doc;
    const { doc, id } = insertBlock(withOne, "text", withOne.blocks[0].id, seededIds("t"));
    expect(doc.blocks.map((b) => b.id)).toEqual([withOne.blocks[0].id, id]);
    expect(doc.blocks[1].kind).toBe("text");
  });

  test("appends at the end when afterId doesn't match any block", () => {
    const withOne = insertBlock(emptyDoc, "heading", null, seededIds()).doc;
    const { doc } = insertBlock(withOne, "divider", "missing", seededIds("d"));
    expect(doc.blocks).toHaveLength(2);
    expect(doc.blocks[1].kind).toBe("divider");
  });

  test("does not mutate the input doc", () => {
    const before = emptyDoc;
    insertBlock(before, "spacer", null, seededIds());
    expect(before.blocks).toHaveLength(0);
  });
});

describe("removeBlock", () => {
  test("removes the matching block only", () => {
    const gen = seededIds();
    let doc = insertBlock(emptyDoc, "heading", null, gen).doc;
    const second = insertBlock(doc, "text", null, gen);
    doc = second.doc;
    const result = removeBlock(doc, doc.blocks[0].id);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].id).toBe(second.id);
  });

  test("is a no-op when the id isn't found", () => {
    const doc = insertBlock(emptyDoc, "heading", null, seededIds()).doc;
    const result = removeBlock(doc, "nope");
    expect(result.blocks).toEqual(doc.blocks);
  });
});

describe("duplicateBlock", () => {
  test("inserts a copy right after the source with a new id", () => {
    const gen = seededIds();
    const doc = insertBlock(emptyDoc, "button", null, gen).doc;
    const sourceId = doc.blocks[0].id;
    const { doc: doc2, id } = duplicateBlock(doc, sourceId, seededIds("dup"));
    expect(id).toBe("dup1");
    expect(doc2.blocks.map((b) => b.id)).toEqual([sourceId, "dup1"]);
    // Content copied verbatim (kind + fields), only the id differs.
    expect(doc2.blocks[1]).toEqual({ ...doc2.blocks[0], id: "dup1" });
  });

  test("returns id: null and an unchanged doc when the source isn't found", () => {
    const doc = insertBlock(emptyDoc, "button", null, seededIds()).doc;
    const result = duplicateBlock(doc, "missing", seededIds("dup"));
    expect(result.id).toBeNull();
    expect(result.doc).toBe(doc);
  });
});

describe("updateBlock", () => {
  test("merges the patch into the matching block only", () => {
    const gen = seededIds();
    let doc = insertBlock(emptyDoc, "heading", null, gen).doc;
    const secondIns = insertBlock(doc, "heading", null, gen);
    doc = secondIns.doc;
    const firstId = doc.blocks[0].id;
    const result = updateBlock(doc, firstId, { text: "Hello" });
    expect((result.blocks[0] as any).text).toBe("Hello");
    expect((result.blocks[1] as any).text).toBe("Heading"); // untouched
  });
});

describe("reorderBlocks", () => {
  test("reorders to match the given id order", () => {
    const gen = seededIds();
    let doc = insertBlock(emptyDoc, "heading", null, gen).doc;
    doc = insertBlock(doc, "text", null, gen).doc;
    doc = insertBlock(doc, "divider", null, gen).doc;
    const [a, b, c] = doc.blocks.map((x) => x.id);
    const result = reorderBlocks(doc, [c, a, b]);
    expect(result.blocks.map((x) => x.id)).toEqual([c, a, b]);
  });

  test("appends any block missing from orderedIds rather than dropping it", () => {
    const gen = seededIds();
    let doc = insertBlock(emptyDoc, "heading", null, gen).doc;
    doc = insertBlock(doc, "text", null, gen).doc;
    const [a, b] = doc.blocks.map((x) => x.id);
    const result = reorderBlocks(doc, [b]); // `a` omitted
    expect(result.blocks.map((x) => x.id)).toEqual([b, a]);
  });

  test("skips stale ids not present in the doc", () => {
    const gen = seededIds();
    const doc = insertBlock(emptyDoc, "heading", null, gen).doc;
    const [a] = doc.blocks.map((x) => x.id);
    const result = reorderBlocks(doc, [a, "ghost"]);
    expect(result.blocks.map((x) => x.id)).toEqual([a]);
  });
});

describe("history (undo/redo)", () => {
  test("pushHistory moves the old present into past and clears future", () => {
    let h: History<number> = initHistory(0);
    h = pushHistory(h, 1);
    h = pushHistory(h, 2);
    expect(h).toEqual({ past: [0, 1], present: 2, future: [] });
  });

  test("undo then redo round-trips to the same present", () => {
    let h: History<number> = initHistory(0);
    h = pushHistory(h, 1);
    h = pushHistory(h, 2);
    h = undoHistory(h);
    expect(h.present).toBe(1);
    h = undoHistory(h);
    expect(h.present).toBe(0);
    expect(canUndo(h)).toBe(false);
    h = redoHistory(h);
    expect(h.present).toBe(1);
    h = redoHistory(h);
    expect(h.present).toBe(2);
    expect(canRedo(h)).toBe(false);
  });

  test("a new edit after undo discards the redo branch", () => {
    let h: History<number> = initHistory(0);
    h = pushHistory(h, 1);
    h = pushHistory(h, 2);
    h = undoHistory(h); // present: 1, future: [2]
    h = pushHistory(h, 99); // new branch
    expect(h).toEqual({ past: [0, 1], present: 99, future: [] });
    expect(canRedo(h)).toBe(false);
  });

  test("undo/redo are no-ops at the boundaries", () => {
    const h = initHistory(0);
    expect(undoHistory(h)).toBe(h);
    expect(redoHistory(h)).toBe(h);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });
});
