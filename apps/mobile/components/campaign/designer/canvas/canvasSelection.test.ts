import { describe, expect, test } from "@jest/globals";
import type { EmailDocument } from "@events-os/shared";
import {
  blockIndexOf,
  canMoveBlock,
  canvasKeyAction,
  keyEventIsEditable,
  selectionAfterDelete,
  stepSelection,
} from "./canvasSelection";

const ids = ["a", "b", "c"];
const doc: EmailDocument = {
  blocks: ids.map((id) => ({ id, kind: "divider" as const })),
};

describe("blockIndexOf", () => {
  test("finds a block, and is honest about the ones it can't", () => {
    expect(blockIndexOf(doc, "b")).toBe(1);
    expect(blockIndexOf(doc, "zzz")).toBe(-1);
    expect(blockIndexOf(doc, null)).toBe(-1);
  });
});

describe("selectionAfterDelete", () => {
  test("the block BELOW takes the selection — where your eye already is", () => {
    expect(selectionAfterDelete(ids, "a")).toBe("b");
    expect(selectionAfterDelete(ids, "b")).toBe("c");
  });

  test("at the end of the document, the block above takes it", () => {
    expect(selectionAfterDelete(ids, "c")).toBe("b");
  });

  test("an emptied document selects nothing", () => {
    expect(selectionAfterDelete(["only"], "only")).toBeNull();
  });

  test("a block that isn't there leaves nothing selected", () => {
    expect(selectionAfterDelete(ids, "zzz")).toBeNull();
  });
});

describe("stepSelection", () => {
  test("walks the document one block at a time", () => {
    expect(stepSelection(ids, "a", 1)).toBe("b");
    expect(stepSelection(ids, "b", -1)).toBe("a");
  });

  test("CLAMPS at both ends — a newsletter is a document, not a carousel", () => {
    expect(stepSelection(ids, "a", -1)).toBe("a");
    expect(stepSelection(ids, "c", 1)).toBe("c");
  });

  test("with nothing selected, lands on the natural end", () => {
    expect(stepSelection(ids, null, 1)).toBe("a");
    expect(stepSelection(ids, null, -1)).toBe("c");
  });

  test("an empty document has nothing to select", () => {
    expect(stepSelection([], null, 1)).toBeNull();
  });
});

describe("canMoveBlock", () => {
  test("is false at the end the block is already at", () => {
    expect(canMoveBlock(ids, "a", -1)).toBe(false);
    expect(canMoveBlock(ids, "a", 1)).toBe(true);
    expect(canMoveBlock(ids, "c", 1)).toBe(false);
  });

  test("is false with nothing selected", () => {
    expect(canMoveBlock(ids, null, 1)).toBe(false);
    expect(canMoveBlock(ids, "zzz", 1)).toBe(false);
  });
});

describe("canvasKeyAction", () => {
  test("bare arrows move the SELECTION, alt+arrows move the BLOCK", () => {
    expect(canvasKeyAction({ key: "ArrowDown" })).toBe("select-next");
    expect(canvasKeyAction({ key: "ArrowUp" })).toBe("select-prev");
    expect(canvasKeyAction({ key: "ArrowDown", altKey: true })).toBe("move-down");
    expect(canvasKeyAction({ key: "ArrowUp", altKey: true })).toBe("move-up");
  });

  test("both delete keys delete; escape deselects", () => {
    expect(canvasKeyAction({ key: "Backspace" })).toBe("delete");
    expect(canvasKeyAction({ key: "Delete" })).toBe("delete");
    expect(canvasKeyAction({ key: "Escape" })).toBe("deselect");
  });

  test("duplicate needs the modifier — a bare 'd' is someone typing", () => {
    expect(canvasKeyAction({ key: "d" })).toBeNull();
    expect(canvasKeyAction({ key: "d", metaKey: true })).toBe("duplicate");
    expect(canvasKeyAction({ key: "D", ctrlKey: true })).toBe("duplicate");
  });

  test("claims nothing it doesn't own — undo/redo stays where it is", () => {
    expect(canvasKeyAction({ key: "z", metaKey: true })).toBeNull();
    expect(canvasKeyAction({ key: "Enter" })).toBeNull();
    expect(canvasKeyAction({ key: "a" })).toBeNull();
  });
});

describe("keyEventIsEditable", () => {
  test("a backspace inside a field is a backspace, never a block delete", () => {
    expect(keyEventIsEditable("INPUT")).toBe(true);
    expect(keyEventIsEditable("TEXTAREA")).toBe(true);
    expect(keyEventIsEditable("DIV")).toBe(false);
    expect(keyEventIsEditable(undefined)).toBe(false);
  });
});
