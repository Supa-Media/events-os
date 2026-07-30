/**
 * DELETE-SELECTED-NODE — founder bug #1 ("delete key should work to delete
 * blocks and stuff" / "can't delete buttons").
 *
 * ── The bug, as seen in the harness (`__adv__/harness/`) ────────────────────
 * `@tiptap/core`'s `Keymap` extension already tries `deleteSelection()` FIRST
 * on both Backspace and Delete (read `@tiptap/core`'s own keymap: `Backspace:
 * … () => commands.deleteSelection(), …` / `Delete: () => commands
 * .deleteSelection(), …`) — so a selected block/atom node SHOULD already
 * delete on either key. It doesn't, for one specific, confirmed reason:
 * `@tiptap/core`'s `NodeView#stopEvent` (the base class every React node view
 * — maily's `ButtonView`, `ImageView`, … — inherits) swallows ANY non-click
 * event whose target is a `BUTTON`/`INPUT`/`SELECT`/`TEXTAREA`/content-
 * editable element living inside a node view's own DOM (outside its
 * `contentDOM`) — a deliberate upstream rule so typing into a node view's OWN
 * form controls (a button's label input, a link field) never gets
 * reinterpreted as a document edit. maily's button node view renders the
 * actual clickable pill as a literal `<button>` (`ButtonView`,
 * `@maily-to/core`) — the SAME element a designer clicks to SELECT the node.
 * Chromium focuses a clickable `<button>` on click, so by the time Backspace/
 * Delete is pressed, `event.target` IS that `<button>`, `stopEvent` returns
 * `true`, and ProseMirror's own dispatch (`eventBelongsToView`, `prosemirror-
 * view`) never even reaches the `Keymap` extension's `deleteSelection()` —
 * confirmed empirically in the harness: `.ProseMirror-selectednode` is
 * genuinely present (a real `NodeSelection` exists) at the moment Delete is
 * pressed, yet nothing happens, and explicitly re-focusing `.ProseMirror`
 * before pressing Delete (bypassing the swallowed-event path entirely) DOES
 * delete the node — isolating `stopEvent` as the exact mechanism, not a
 * missing keymap entry.
 *
 * ── The fix ─────────────────────────────────────────────────────────────
 * A capture-phase `keydown` listener on the editor's own OUTER container —
 * the SAME mechanism `pwImagePlaceholderIntercept.ts` uses for the image-
 * placeholder click — runs BEFORE the event ever reaches the focused node-
 * view button, so `stopEvent` never gets a chance to swallow it. If the
 * current selection is a ProseMirror `NodeSelection` (a button, an image, a
 * `pwBleedImage`/`pwPoll`, a section, a column, …) and the key is Backspace
 * or Delete, this module says "yes, treat this as node deletion" and the
 * caller (`MailyDocumentHost.web.tsx`) runs `deleteSelection()` directly and
 * stops the event — bypassing `stopEvent` entirely rather than trying to
 * out-think it.
 *
 * Genuine TEXT entry is deliberately left alone: `isNodeDeleteKeydown` below
 * returns `false` for a target that's an `<input>`/`<textarea>` or any
 * `isContentEditable` element (a bubble-menu's own label/URL field, or
 * ordinary prose typing — ProseMirror marks its own contenteditable root
 * `contentEditable="true"` and atom node views `contentEditable="false"`, so
 * this cleanly distinguishes "backspacing text" from "the click-to-select
 * trigger of an atom node") — those keep whatever native/ProseMirror behavior
 * they already have, untouched.
 */

/** The minimal shape this module needs from a DOM `EventTarget` — duck-typed
 *  so `isNodeDeleteKeydown` is unit-testable without a real DOM (same
 *  discipline as `pwImagePlaceholderIntercept.ts`'s `ClickTarget`). */
export type DeleteKeyTarget = {
  tagName?: string;
  isContentEditable?: boolean;
};

/** Real text-entry surfaces `stopEvent` also swallows events for — but where
 *  swallowing is CORRECT (a designer backspacing within the field's own
 *  text), not a bug to route around. */
const TEXT_ENTRY_TAGS = new Set(["INPUT", "TEXTAREA"]);

/**
 * True for exactly the keydown this module intercepts: Backspace or Delete,
 * whose target is NOT a genuine text-entry surface. Callers additionally
 * gate on "is the current selection a NodeSelection" (this module has no
 * access to editor state, by design — see `resolveImageNodePos`'s sibling
 * split in `pwImagePlaceholderIntercept.ts` for the same pure/DOM-only vs.
 * ProseMirror-aware separation) before actually deleting anything.
 */
export function isNodeDeleteKeydown(key: string, target: DeleteKeyTarget | null | undefined): boolean {
  if (key !== "Backspace" && key !== "Delete") return false;
  if (!target) return true;
  if (target.isContentEditable) return false;
  if (target.tagName && TEXT_ENTRY_TAGS.has(target.tagName)) return false;
  return true;
}
