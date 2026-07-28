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
 * Whether a keypress that landed on `tagName` belongs to the canvas at all.
 *
 * Backspace inside a text field is a backspace, not "delete this block" — the
 * single most destructive way to get this wrong. Mirrors the guard the
 * composer's existing undo/redo shortcut already uses.
 */
export function keyEventIsEditable(tagName: string | undefined | null): boolean {
  return tagName === "INPUT" || tagName === "TEXTAREA";
}
