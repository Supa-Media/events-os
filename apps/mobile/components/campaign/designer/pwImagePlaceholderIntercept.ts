/**
 * IMAGE PLACEHOLDER INTERCEPT — routes maily's "Click or Drop image here"
 * placeholder to OUR image library instead of the OS file dialog (founder
 * bug #2).
 *
 * ── The bug, as seen in the harness (`__adv__/harness/`) ────────────────────
 * maily's stock `image`/`logo` node views (`@maily-to/core`'s `ImageView`/
 * `LogoView`) render an empty placeholder as a `<div class="mly-image-drop-
 * zone">` containing an absolutely-positioned, fully-transparent
 * `<input type="file" class="mly:absolute mly:inset-0 mly:opacity-0">`
 * covering the whole drop zone. Clicking ANYWHERE on the placeholder hits
 * that invisible input directly and the browser opens its native file
 * picker — there is no click handler to intercept at the React level, only
 * the DOM's own default action on the input.
 *
 * ── Why this still works without forking maily's node views ─────────────────
 * A native `<input type="file">`'s file-picker dialog is its DEFAULT ACTION
 * for a `click` event — like a link navigating on click. Default actions run
 * AFTER every registered listener has run, so a `click` listener added with
 * `capture: true` on an ANCESTOR of the input still runs before the input's
 * own dialog opens, and calling `preventDefault()` there cancels it, exactly
 * like intercepting a same-page anchor's navigation. `MailyDocumentHost.web
 * .tsx` attaches exactly one such capture-phase listener on the editor's
 * outer container (see that file) — this module is the pure "was this click
 * one we should hijack, and which node does it belong to" logic underneath
 * it, kept separate so it's unit-testable without a live ProseMirror view.
 */

/** The minimal shape this module needs from a DOM `EventTarget` — duck-typed
 *  (not `instanceof HTMLInputElement`) so `findImagePlaceholderWrapper` is
 *  unit-testable against a plain object under this repo's Jest `node` test
 *  environment (no `jsdom`/real `HTMLInputElement` global there), while still
 *  matching every REAL DOM element it's ever actually called with. */
export type ClickTarget = {
  tagName?: string;
  type?: string;
  closest?: (selector: string) => unknown;
};

/** True for exactly the click maily's own placeholder input would otherwise
 *  turn into an OS file-picker dialog: a `click` whose target IS a
 *  `<input type="file">` living inside a `.mly-image-drop-zone` wrapper (the
 *  class both `image` and `logo` node views render — `logo` is maily's
 *  brand-mark node, offered the exact same "click or drop" placeholder).
 *  Returns that wrapper element (the node view's DOM root — what
 *  `resolveImageNodePos` needs), or `null` for every other click. */
export function findImagePlaceholderWrapper(target: EventTarget | null): HTMLElement | null {
  const el = target as ClickTarget | null;
  if (!el || el.tagName !== "INPUT" || el.type !== "file" || typeof el.closest !== "function") {
    return null;
  }
  return (el.closest(".mly-image-drop-zone") as HTMLElement | null) ?? null;
}

/** Node type names this intercept knows how to redirect — both of maily's
 *  own "click or drop image" node views. Anything else at a resolved
 *  position is treated as "couldn't identify the node" (fail closed: the
 *  click is still cancelled — see the module doc — but no library flow
 *  opens for a node type this wasn't built for). */
export const IMAGE_PLACEHOLDER_NODE_TYPES = new Set(["image", "logo"]);

/**
 * A minimal shape of the parts of a ProseMirror `EditorView`/`Node` this
 * module actually calls — narrowed so the pure logic here can be unit-tested
 * against a plain object, with no real ProseMirror view required. The real
 * caller passes `editor.view` and `editor.state.doc` (both satisfy this).
 */
export type PosAtDomView = { posAtDOM(node: globalThis.Node, offset: number): number };
export type NodeAtDoc = { nodeAt(pos: number): { type: { name: string } } | null | undefined };

/**
 * Resolve the ProseMirror position of the atom node a `.mly-image-drop-zone`
 * DOM wrapper renders, so the caller can `setNodeSelection` + `updateAttributes`
 * on exactly that node once the designer picks an image — never "whichever
 * node currently has selection", which would silently edit the wrong block
 * if the designer's last text-cursor position was elsewhere.
 *
 * `view.posAtDOM(wrapper, 0)` resolves to a position INSIDE where the node's
 * (absent) content would start, one past the node's own start — atoms have
 * no content, so that position and `position - 1` straddle the node itself;
 * this tries both and returns whichever one's `doc.nodeAt` is actually an
 * image-placeholder node type, rather than assuming a fixed offset that a
 * ProseMirror version bump could quietly change.
 */
export function resolveImageNodePos(view: PosAtDomView, doc: NodeAtDoc, wrapper: globalThis.Node): number | null {
  const base = view.posAtDOM(wrapper, 0);
  for (const candidate of [base, base - 1]) {
    if (candidate < 0) continue;
    const node = doc.nodeAt(candidate);
    if (node && IMAGE_PLACEHOLDER_NODE_TYPES.has(node.type.name)) return candidate;
  }
  return null;
}
