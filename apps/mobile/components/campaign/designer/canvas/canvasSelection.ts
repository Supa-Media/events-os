/**
 * SELECTION ON THE CANVAS — which block is selected, what a key does to it,
 * and where the selection lands after a block goes away.
 *
 * Small decisions, but every one of them is the kind that is silently wrong
 * until someone notices ("I deleted a block and the selection jumped to the
 * top"), so they live here as pure functions with tests rather than inside a
 * `useState` updater. Same reason `lib/emailDesigner.ts` holds the document
 * algebra: React-free logic is logic you can actually pin down.
 *
 * Pure and React-free so jest can load it (see `canvasStyles.ts`'s header).
 */
import type { EmailDocument } from "@events-os/shared";

/** Position of `id` in the document, or -1. */
export function blockIndexOf(doc: EmailDocument, id: string | null): number {
  if (id === null) return -1;
  return doc.blocks.findIndex((b) => b.id === id);
}

/**
 * Where the selection goes when the selected block is deleted.
 *
 * The block BELOW takes its place (the one that has just moved up into the
 * deleted block's position, so the caret is where your eye already is); at the
 * end of the document, the block above; on an empty document, nothing. Keeping
 * a selection at all matters — dropping to `null` after every delete makes
 * "delete three blocks" three clicks longer than it needs to be.
 */
export function selectionAfterDelete(
  ids: readonly string[],
  deletedId: string,
): string | null {
  const index = ids.indexOf(deletedId);
  if (index < 0) return null;
  const remaining = ids.filter((id) => id !== deletedId);
  if (remaining.length === 0) return null;
  return remaining[Math.min(index, remaining.length - 1)];
}

/**
 * Step the selection one block up (`-1`) or down (`+1`).
 *
 * Deliberately CLAMPS rather than wraps: a newsletter is a document, not a
 * carousel, and arrowing off the end into the masthead is disorienting. With
 * nothing selected, the first (or last) block is the natural first landing.
 */
export function stepSelection(
  ids: readonly string[],
  selectedId: string | null,
  delta: -1 | 1,
): string | null {
  if (ids.length === 0) return null;
  const index = selectedId === null ? -1 : ids.indexOf(selectedId);
  if (index < 0) return delta === 1 ? ids[0] : ids[ids.length - 1];
  const next = index + delta;
  if (next < 0 || next >= ids.length) return selectedId;
  return ids[next];
}

/** Whether the up/down reorder control should be live for this block. */
export function canMoveBlock(
  ids: readonly string[],
  id: string | null,
  delta: -1 | 1,
): boolean {
  if (id === null) return false;
  const index = ids.indexOf(id);
  if (index < 0) return false;
  const target = index + delta;
  return target >= 0 && target < ids.length;
}

/**
 * What a keypress on the canvas means.
 *
 * Selection-based reordering is an ADDITION to the up/down buttons on the
 * block's toolbar, never a replacement: those exist because dragging a
 * fifteen-block newsletter on a phone was "a long-press-and-scroll fight"
 * (`DocumentComposer.tsx`), and a keyboard shortcut helps a phone not at all.
 *
 * Returns `null` for anything the canvas doesn't claim, so the caller can
 * leave the event alone — undo/redo in particular stays where it already is.
 */
export type CanvasKeyAction =
  | "select-prev"
  | "select-next"
  | "move-up"
  | "move-down"
  | "delete"
  | "duplicate"
  | "deselect";

export function canvasKeyAction(event: {
  key: string;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}): CanvasKeyAction | null {
  const mod = event.metaKey === true || event.ctrlKey === true;
  switch (event.key) {
    case "ArrowUp":
      // Alt+Arrow MOVES the block, bare Arrow moves the SELECTION — the same
      // split VS Code, Notion and every block editor uses.
      return event.altKey ? "move-up" : "select-prev";
    case "ArrowDown":
      return event.altKey ? "move-down" : "select-next";
    case "Backspace":
    case "Delete":
      return "delete";
    case "Escape":
      return "deselect";
    case "d":
    case "D":
      return mod ? "duplicate" : null;
    default:
      return null;
  }
}

/**
 * Whether a keypress landed somewhere the USER IS TYPING, and so belongs to
 * that editor rather than to the canvas.
 *
 * Backspace inside a text field is a backspace, not "delete this block" — the
 * single most destructive way to get this wrong.
 *
 * `INPUT`/`TEXTAREA` is NOT the whole answer, and testing only those is how
 * this shipped broken: the inspector's `MarkdownEditor` is CodeMirror 6 on
 * web, which is a **`contenteditable` DIV**. Typing a body and hitting
 * Backspace popped "Delete this block?" for the very block being edited;
 * arrow keys re-selected blocks instead of moving the caret. So the test is
 * the DOM's own notion of "is this element being edited":
 *
 *  - `isContentEditable` — the property browsers compute, true for CodeMirror
 *    and for anything inside a `contenteditable` subtree;
 *  - the `contenteditable` ATTRIBUTE — the same answer in environments (and
 *    tests) that don't compute the property, `"false"` excluded because that
 *    is how a subtree opts back OUT;
 *  - `role="textbox"` — an editor that draws its own caret (and the ARIA
 *    contract every such widget carries).
 *
 * Shaped around a DOM-ish duck type rather than a real `HTMLElement` so the
 * module stays React-free and jest can drive it directly.
 */
export type KeyEventTarget =
  | {
      tagName?: string | null;
      isContentEditable?: boolean | null;
      getAttribute?: (name: string) => string | null;
    }
  | null
  | undefined;

export function keyEventIsEditable(target: KeyEventTarget): boolean {
  if (!target) return false;

  const tagName = typeof target.tagName === "string" ? target.tagName.toUpperCase() : null;
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") return true;

  if (target.isContentEditable === true) return true;

  const attr = target.getAttribute?.bind(target);
  if (attr) {
    const editable = attr("contenteditable");
    // `contenteditable=""` and `contenteditable="true"` both mean editable;
    // only an explicit "false" doesn't.
    if (editable !== null && editable !== undefined && editable.toLowerCase() !== "false") {
      return true;
    }
    if (attr("role")?.toLowerCase() === "textbox") return true;
  }

  return false;
}

/**
 * Whether a keypress happened INSIDE the canvas.
 *
 * The composer's shortcut listener is on `document` — it has to be, because
 * undo/redo belongs to the whole editor — but the CANVAS's own keys must not
 * be. A window-wide `ArrowDown` handler that `preventDefault()`s is a screen
 * whose page scroll has stopped working; a window-wide `Backspace` is "delete
 * this block?" raised from a control on the other side of the layout. So the
 * selection keys are claimed only when the event came from within the canvas's
 * own subtree (a block's `Pressable` takes focus when you click it).
 *
 * Duck-typed on `Node.contains` so the module stays DOM-free and testable. No
 * container (native, or before the canvas has mounted) means the canvas claims
 * nothing.
 */
export function keyEventIsInsideCanvas(
  // `(node: never)` rather than `(node: unknown)`: a real `HTMLElement`'s
  // `contains(other: Node | null)` only satisfies a duck type whose parameter
  // is assignable TO `Node`, and `never` is assignable to anything.
  container: { contains?: (node: never) => boolean } | null | undefined,
  target: unknown,
): boolean {
  const contains = container?.contains;
  if (typeof contains !== "function") return false;
  if (target === null || target === undefined) return false;
  return contains.call(container, target as never) === true;
}

/**
 * WHAT THE COMPOSER SHOULD DO WITH A KEYPRESS — the whole decision, as one
 * pure function.
 *
 * `DocumentComposer` listens on `document` (undo/redo belongs to the entire
 * editor, not to whatever happens to have focus), which makes every guard on
 * that listener a guard over the WHOLE PAGE. That is a lot of judgement to
 * leave inside a `useEffect` where nothing can test it — and it shipped
 * wrong three ways at once: Backspace deleted the block being typed into,
 * ArrowUp/ArrowDown killed the page's keyboard scrolling, and Cmd+D with
 * nothing selected fell through to the browser's bookmark dialog.
 *
 * So the decision lives here and the effect only performs it:
 *
 *  - `ignore` — not ours. The caller must NOT `preventDefault()`.
 *  - anything else — ours, and the caller `preventDefault()`s unconditionally,
 *    so a shortcut the canvas claims never also does something to the browser.
 *
 * `insideCanvas` is the caller's answer (see {@link keyEventIsInsideCanvas}),
 * because only it holds the DOM node.
 */
export type ComposerKeyIntent =
  | { kind: "ignore" }
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "canvas"; action: CanvasKeyAction };

const IGNORE: ComposerKeyIntent = { kind: "ignore" };

export function composerKeyIntent(
  event: {
    key: string;
    altKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    target?: KeyEventTarget;
  },
  ctx: { editable: boolean; insideCanvas: boolean },
): ComposerKeyIntent {
  // Wherever the user is typing, the keyboard is theirs — including the
  // inspector's contenteditable markdown editor, and including undo/redo,
  // which the editor implements itself.
  if (keyEventIsEditable(event.target)) return IGNORE;

  const mod = event.metaKey === true || event.ctrlKey === true;
  if (mod && event.key.toLowerCase() === "z") {
    return event.shiftKey === true ? { kind: "redo" } : { kind: "undo" };
  }

  // A locked document has no canvas actions at all; and a canvas shortcut
  // fired from outside the canvas is somebody trying to scroll the page.
  if (!ctx.editable || !ctx.insideCanvas) return IGNORE;

  const action = canvasKeyAction(event);
  return action === null ? IGNORE : { kind: "canvas", action };
}

/**
 * Where the selection goes after an undo or a redo.
 *
 * Neither `undoHistory` nor `redoHistory` knows anything about selection, so
 * undoing the insert of a block leaves `selectedId` pointing at a block that
 * is no longer in the document — and `stepSelection` treats an id it can't
 * find as "nothing selected", so the next ArrowDown jumped to the TOP of the
 * document rather than to the block after the one you were on. Dropping a
 * selection that no longer exists is the honest state.
 */
export function selectionAfterHistoryChange(
  ids: readonly string[],
  selectedId: string | null,
): string | null {
  if (selectedId === null) return null;
  return ids.includes(selectedId) ? selectedId : null;
}
