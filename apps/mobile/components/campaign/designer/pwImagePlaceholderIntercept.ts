/**
 * IMAGE PLACEHOLDER INTERCEPT — routes maily's "Click or Drop image here"
 * placeholder to OUR image library instead of the OS file dialog (founder
 * bug #2), AND (founder bug #2's second half, "can't replace images that
 * already are there") routes a click on an ALREADY-FILLED image to the SAME
 * picker, to REPLACE it in place.
 *
 * ── The empty-placeholder bug, as seen in the harness (`__adv__/harness/`) ──
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
 *
 * ── The "already filled" half ───────────────────────────────────────────
 * Once `image`/`logo` have a `src`, maily stops rendering the file input
 * entirely (`isDroppable` in `ImageView`/`LogoView` goes false) — there is NO
 * click affordance to replace it at all upstream, stock maily has no
 * "replace image" concept. `pwBleedImage` (our own node-pack addition,
 * `pwNodePack.ts`) never had one either: it's a plain `renderHTML` node with
 * no interactive click handling whatsoever. `findFilledImageClickTarget`
 * below recognizes a click that LANDS ON a filled image's own `<img>`
 * element specifically — not its resize-handle corner divs (`role="button"
 * data-direction=…"]`, maily's `ImageView`/`LogoView`), so dragging a corner
 * to resize a selected image is unaffected — and resolves it through the
 * SAME straddle-position search `resolveImageNodePos` already does for
 * placeholders, now parameterized over which node-type set is being
 * searched for (`FILLED_IMAGE_NODE_TYPES` here vs. `IMAGE_PLACEHOLDER_NODE_
 * TYPES` for the empty case) so both callers share one implementation.
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

/** Node type names the "replace an already-filled image" half knows how to
 *  redirect — maily's two image node views once filled, PLUS our own
 *  `pwBleedImage` (never had a click-to-replace affordance at all, stock or
 *  otherwise — see the module doc). */
export const FILLED_IMAGE_NODE_TYPES = new Set(["image", "logo", "pwBleedImage"]);

/**
 * A minimal shape of the parts of a ProseMirror `EditorView`/`Node` this
 * module actually calls — narrowed so the pure logic here can be unit-tested
 * against a plain object, with no real ProseMirror view required. The real
 * caller passes `editor.view` and `editor.state.doc` (both satisfy this).
 */
export type PosAtDomView = { posAtDOM(node: globalThis.Node, offset: number): number };
export type NodeAtDoc = { nodeAt(pos: number): { type: { name: string } } | null | undefined };

/**
 * Resolve the ProseMirror position of the atom node a DOM wrapper renders,
 * so the caller can `setNodeSelection` + `updateAttributes` on exactly that
 * node once the designer picks an image — never "whichever node currently
 * has selection", which would silently edit the wrong block if the
 * designer's last text-cursor position was elsewhere. `nodeTypes` defaults to
 * the empty-placeholder set (`IMAGE_PLACEHOLDER_NODE_TYPES`) — the shape
 * every existing caller/test already expects — callers filling an ALREADY-
 * filled image pass `FILLED_IMAGE_NODE_TYPES` instead.
 *
 * `view.posAtDOM(wrapper, 0)` resolves to a position INSIDE where the node's
 * (absent) content would start, one past the node's own start — atoms have
 * no content, so that position and `position - 1` straddle the node itself;
 * this tries both and returns whichever one's `doc.nodeAt` is actually one of
 * `nodeTypes`, rather than assuming a fixed offset that a ProseMirror version
 * bump could quietly change.
 */
export function resolveImageNodePos(
  view: PosAtDomView,
  doc: NodeAtDoc,
  wrapper: globalThis.Node,
  nodeTypes: ReadonlySet<string> = IMAGE_PLACEHOLDER_NODE_TYPES,
): number | null {
  const base = view.posAtDOM(wrapper, 0);
  for (const candidate of [base, base - 1]) {
    if (candidate < 0) continue;
    const node = doc.nodeAt(candidate);
    if (node && nodeTypes.has(node.type.name)) return candidate;
  }
  return null;
}

/** The minimal shape this module needs from a DOM element for the
 *  filled-image half — duck-typed like `ClickTarget` above. */
export type FilledImageClickTarget = {
  tagName?: string;
  hasAttribute?: (name: string) => boolean;
  closest?: (selector: string) => unknown;
};

/**
 * True for a click that lands on an ALREADY-FILLED image's own rendered
 * `<img>` — maily's `image`/`logo` (inside their `.mly-image-drop-zone`
 * wrapper — the SAME class the empty-placeholder case uses, maily renders it
 * unconditionally regardless of fill state) or our `pwBleedImage` (a bare
 * `<img data-pw-bleed-image>`, no wrapper at all — see `pwNodePack.ts`).
 * Deliberately excludes anything that ISN'T the `<img>` itself: `ImageView`'s
 * resize-corner handles are separate `<div role="button" data-direction=…>`
 * elements layered on top of a SELECTED image, and a click there must keep
 * doing its own job (resizing), not hijack into the replace flow.
 *
 * Returns the DOM node `resolveImageNodePos` should resolve a position from
 * (the `.mly-image-drop-zone` wrapper for maily's own nodes — matching the
 * empty-placeholder case exactly, so one straddle-search works for both — or
 * the `<img>` itself for `pwBleedImage`, which has no wrapper), or `null` for
 * every other click.
 */
export function findFilledImageClickTarget(target: EventTarget | null): HTMLElement | null {
  const el = target as FilledImageClickTarget | null;
  if (!el || el.tagName !== "IMG" || typeof el.closest !== "function") return null;
  const mailyWrapper = el.closest(".mly-image-drop-zone") as HTMLElement | null;
  if (mailyWrapper) return mailyWrapper;
  if (typeof el.hasAttribute === "function" && el.hasAttribute("data-pw-bleed-image")) {
    return el as unknown as HTMLElement;
  }
  return null;
}
