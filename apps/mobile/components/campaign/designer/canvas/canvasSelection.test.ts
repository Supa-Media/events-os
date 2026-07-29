import { describe, expect, test } from "@jest/globals";
import type { EmailDocument } from "@events-os/shared";
import {
  blockIndexOf,
  canMoveBlock,
  canvasKeyAction,
  composerKeyIntent,
  keyEventIsEditable,
  keyEventIsInsideCanvas,
  selectionAfterDelete,
  selectionAfterHistoryChange,
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

/**
 * A DOM-ish stand-in for an event target, with only the three things the
 * guard is allowed to look at.
 */
function element(
  tagName: string,
  attrs: Record<string, string> = {},
  isContentEditable?: boolean,
) {
  return {
    tagName,
    isContentEditable,
    getAttribute: (name: string) =>
      Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null,
  };
}

/** CodeMirror 6, which is what `BlockFields` mounts for a `text` block's body
 *  on web: a contenteditable DIV that does not stopPropagation. */
const codeMirror = element("DIV", { contenteditable: "true", role: "textbox" }, true);

describe("keyEventIsEditable", () => {
  test("a backspace inside a field is a backspace, never a block delete", () => {
    expect(keyEventIsEditable(element("INPUT"))).toBe(true);
    expect(keyEventIsEditable(element("TEXTAREA"))).toBe(true);
    expect(keyEventIsEditable(element("SELECT"))).toBe(true);
    expect(keyEventIsEditable(element("DIV"))).toBe(false);
    expect(keyEventIsEditable(undefined)).toBe(false);
    expect(keyEventIsEditable(null)).toBe(false);
  });

  test("CodeMirror's contenteditable DIV counts — tagName alone does not", () => {
    // The whole of P0-2: the inspector's markdown editor has tagName "DIV",
    // so a tagName-only guard let Backspace through as "delete this block"
    // while the designer was typing that block's body.
    expect(keyEventIsEditable(codeMirror)).toBe(true);
  });

  test("each of the three signals is enough on its own", () => {
    expect(keyEventIsEditable({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(keyEventIsEditable(element("DIV", { contenteditable: "" }))).toBe(true);
    expect(keyEventIsEditable(element("DIV", { contenteditable: "plaintext-only" }))).toBe(true);
    expect(keyEventIsEditable(element("SPAN", { role: "textbox" }))).toBe(true);
  });

  test('contenteditable="false" is how a subtree opts back OUT', () => {
    expect(keyEventIsEditable(element("DIV", { contenteditable: "false" }))).toBe(false);
    expect(keyEventIsEditable(element("DIV", { role: "button" }))).toBe(false);
  });

  test("a target with no getAttribute at all is handled, not thrown on", () => {
    expect(keyEventIsEditable({ tagName: "input" })).toBe(true);
    expect(keyEventIsEditable({})).toBe(false);
  });
});

describe("keyEventIsInsideCanvas", () => {
  const canvas = { contains: (node: unknown) => node === "block" || node === "canvas" };

  test("only events from within the canvas subtree", () => {
    expect(keyEventIsInsideCanvas(canvas, "block")).toBe(true);
    expect(keyEventIsInsideCanvas(canvas, "somewhere-else")).toBe(false);
  });

  test("no canvas mounted means the canvas claims nothing", () => {
    expect(keyEventIsInsideCanvas(null, "block")).toBe(false);
    expect(keyEventIsInsideCanvas(undefined, "block")).toBe(false);
    expect(keyEventIsInsideCanvas({}, "block")).toBe(false);
    expect(keyEventIsInsideCanvas(canvas, null)).toBe(false);
  });
});

describe("selectionAfterHistoryChange", () => {
  test("a selection undone out of existence is dropped", () => {
    // Undoing an insert used to leave `selectedId` pointing at a block that
    // no longer exists, and `stepSelection` reads an unknown id as "nothing
    // selected" — so the next ArrowDown jumped to the top of the document.
    expect(selectionAfterHistoryChange(ids, "zzz")).toBeNull();
    expect(stepSelection(ids, selectionAfterHistoryChange(ids, "zzz"), 1)).toBe("a");
  });

  test("a selection that survived is left alone", () => {
    expect(selectionAfterHistoryChange(ids, "b")).toBe("b");
    expect(selectionAfterHistoryChange(ids, null)).toBeNull();
  });
});

/**
 * The composer's whole keyboard decision — the thing that was wrong on the
 * page, rather than a transcription of it.
 */
describe("composerKeyIntent", () => {
  const onCanvas = { editable: true, insideCanvas: true };
  const press = (
    key: string,
    extra: Record<string, unknown> = {},
    ctx = onCanvas,
  ) => composerKeyIntent({ key, ...extra }, ctx);

  test("the canvas's own keys, on the canvas", () => {
    expect(press("ArrowDown")).toEqual({ kind: "canvas", action: "select-next" });
    expect(press("Backspace")).toEqual({ kind: "canvas", action: "delete" });
    expect(press("Escape")).toEqual({ kind: "canvas", action: "deselect" });
    expect(press("d", { metaKey: true })).toEqual({ kind: "canvas", action: "duplicate" });
    expect(press("ArrowUp", { altKey: true })).toEqual({ kind: "canvas", action: "move-up" });
  });

  test("undo/redo is the editor's, from anywhere on the page", () => {
    const anywhere = { editable: true, insideCanvas: false };
    expect(press("z", { metaKey: true }, anywhere)).toEqual({ kind: "undo" });
    expect(press("z", { metaKey: true, shiftKey: true }, anywhere)).toEqual({ kind: "redo" });
    expect(press("Z", { ctrlKey: true }, anywhere)).toEqual({ kind: "undo" });
    // …and even on a LOCKED document, which has an undo button but no canvas.
    expect(press("z", { ctrlKey: true }, { editable: false, insideCanvas: false })).toEqual({
      kind: "undo",
    });
  });

  test("NOTHING is claimed while the user is typing — least of all in CodeMirror", () => {
    for (const key of ["Backspace", "Delete", "ArrowUp", "ArrowDown", "Escape"]) {
      expect(press(key, { target: codeMirror })).toEqual({ kind: "ignore" });
    }
    expect(press("d", { metaKey: true, target: codeMirror })).toEqual({ kind: "ignore" });
    // Undo included: CodeMirror has its own history, and stealing Cmd+Z would
    // undo a whole block edit instead of the last few characters.
    expect(press("z", { metaKey: true, target: codeMirror })).toEqual({ kind: "ignore" });
    expect(press("Backspace", { target: element("INPUT") })).toEqual({ kind: "ignore" });
  });

  test("arrow keys OUTSIDE the canvas are left to scroll the page", () => {
    const elsewhere = { editable: true, insideCanvas: false };
    // The caller only preventDefaults a non-`ignore` intent, so "ignore" here
    // is literally "the page still scrolls".
    expect(press("ArrowDown", {}, elsewhere)).toEqual({ kind: "ignore" });
    expect(press("ArrowUp", {}, elsewhere)).toEqual({ kind: "ignore" });
    expect(press("Backspace", {}, elsewhere)).toEqual({ kind: "ignore" });
  });

  test("a locked document has no canvas actions at all", () => {
    const locked = { editable: false, insideCanvas: true };
    expect(press("Backspace", {}, locked)).toEqual({ kind: "ignore" });
    expect(press("ArrowDown", {}, locked)).toEqual({ kind: "ignore" });
  });

  test("Cmd+D is claimed whatever the selection — the caller preventDefaults it", () => {
    // The intent doesn't depend on `selectedId`: the composer preventDefaults
    // every non-`ignore` intent and only THEN discovers it has nothing
    // selected, so the browser's bookmark dialog never opens.
    expect(press("d", { metaKey: true })).toEqual({ kind: "canvas", action: "duplicate" });
  });

  test("keys nobody claims stay unclaimed", () => {
    expect(press("Enter")).toEqual({ kind: "ignore" });
    expect(press("a")).toEqual({ kind: "ignore" });
    expect(press("d")).toEqual({ kind: "ignore" });
  });
});
