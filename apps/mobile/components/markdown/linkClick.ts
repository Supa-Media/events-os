/**
 * Clickable Markdown links for the CodeMirror 6 Markdown surface.
 *
 * Markdown stays the literal source of truth — we never convert it to HTML. This
 * extension layers behaviour on top of the existing live-preview stack so that
 * `[text](url)` links, bare URLs and `<autolinks>` are interactive:
 *
 *  - Read mode (`MarkdownView`, `!editable`): a plain click on a link opens the
 *    target in a new tab.
 *  - Edit mode: a plain click just places the caret (so links stay editable),
 *    but Cmd/Ctrl+click opens the link, and hovering a link shows a small
 *    tooltip hint ("⌘ click to open", or "Ctrl click to open" off macOS) plus
 *    the resolved URL.
 *
 * The visible link text gets a `cm-md-clickable-link` class (underline +
 * `cursor: pointer`) so it reads as interactive. We resolve the target from the
 * Lezer syntax tree at the click position rather than from the DOM, so it works
 * even though `livePreview` conceals the `[ ]( )` marks on inactive lines — the
 * visible text still sits inside the `Link` node, so a click on it resolves.
 *
 * Plain JS (uses `document`/`window`/`navigator`) so it can live alongside the
 * rest of the platform-agnostic stack.
 */
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  hoverTooltip,
} from "@codemirror/view";

const linkMarkDeco = Decoration.mark({ class: "cm-md-clickable-link" });

/** True on macOS, where the open modifier is ⌘ (metaKey) rather than Ctrl. */
function isMac(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform || "")
  );
}

/** True when `node` is (or is nested inside) an `Image` syntax node. */
function hasImageAncestor(node: { name: string; parent: any } | null): boolean {
  for (let n = node; n; n = n.parent) {
    if (n.name === "Image") return true;
  }
  return false;
}

/**
 * Resolve the target URL of the link/url syntax node at `pos`, if any.
 *
 * - `Link` (`[text](url)`): pull the `(url)` out of the node's source slice.
 * - `URL` / `Autolink` (bare `https://…` or `<https://…>`): the raw text IS the
 *   target (strip surrounding `<>` for autolinks).
 *
 * Returns the URL and the [from, to] span of the link (used to skip image
 * URLs and to scope the hover tooltip).
 */
function resolveLinkAt(
  view: EditorView,
  pos: number,
): { url: string; from: number; to: number } | null {
  const tree = syntaxTree(view.state);

  for (let n: SyntaxNode | null = tree.resolveInner(pos, -1); n; n = n.parent) {
    // Never treat an image's URL as an openable link.
    if (hasImageAncestor(n.node)) return null;

    if (n.name === "Link") {
      const src = view.state.doc.sliceString(n.from, n.to);
      const url = parseLinkTarget(src);
      if (url) return { url, from: n.from, to: n.to };
      return null;
    }
    if (n.name === "Autolink" || n.name === "URL") {
      const raw = view.state.doc.sliceString(n.from, n.to).trim();
      const url = raw.replace(/^<|>$/g, "").trim();
      if (url) return { url, from: n.from, to: n.to };
      return null;
    }
  }
  return null;
}

/** Pull the `url` out of a `[text](url "title")` Link source slice. */
function parseLinkTarget(src: string): string | null {
  const m = /\]\(\s*<?([^)\s>]*)>?(?:\s+["'][^)]*["'])?\s*\)\s*$/.exec(src);
  const url = m?.[1]?.trim();
  return url ? url : null;
}

/** Open a resolved URL in a new tab. */
function openUrl(url: string): void {
  if (typeof window === "undefined") return;
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Decorate the visible portion of links with a class so they look interactive.
 * For `Link` nodes we mark only the link TEXT (`[text]`'s inner text), which is
 * what stays visible after `livePreview` conceals the marks. For bare URLs /
 * autolinks we mark the whole node.
 */
function buildLinkDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (hasImageAncestor(node.node)) return;
        if (node.name === "Link") {
          // Mark the inner text span between the first `[` and `]`.
          const src = view.state.doc.sliceString(node.from, node.to);
          const open = src.indexOf("[");
          const close = src.indexOf("]");
          if (open !== -1 && close > open + 1) {
            builder.add(
              node.from + open + 1,
              node.from + close,
              linkMarkDeco,
            );
          }
          return;
        }
        if (node.name === "Autolink" || node.name === "URL") {
          builder.add(node.from, node.to, linkMarkDeco);
        }
      },
    });
  }
  return builder.finish();
}

const linkDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildLinkDecorations(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet
      ) {
        this.decorations = buildLinkDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/**
 * mousedown/click handlers that open links.
 *
 * In read mode a plain click opens. In edit mode only Cmd/Ctrl+click opens (a
 * plain click falls through to normal caret placement). We `preventDefault()`
 * ONLY when we actually open, so caret placement and text selection are
 * untouched the rest of the time. We act on `mousedown` (to beat CM's own
 * selection handling) and swallow the following `click` so nothing double-fires.
 */
function makeClickHandlers(editable: boolean) {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0) return false;
      const wantsOpen = editable ? event.metaKey || event.ctrlKey : true;
      if (!wantsOpen) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      const link = resolveLinkAt(view, pos);
      if (!link) return false;
      event.preventDefault();
      openUrl(link.url);
      return true;
    },
    // Some browsers still synthesize a click after a handled mousedown; if we
    // opened on a plain read-mode click, make sure it doesn't also place a
    // selection or fire twice. Mirrors the mousedown predicate.
    click(event, view) {
      if (event.button !== 0) return false;
      const wantsOpen = editable ? event.metaKey || event.ctrlKey : true;
      if (!wantsOpen) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      const link = resolveLinkAt(view, pos);
      if (!link) return false;
      event.preventDefault();
      return true;
    },
  });
}

/** Edit-mode hover tooltip: "⌘ click to open" + the URL. */
const linkHoverTooltip = hoverTooltip((view, pos) => {
  const link = resolveLinkAt(view, pos);
  if (!link) return null;
  const mod = isMac() ? "⌘" : "Ctrl";
  return {
    pos: link.from,
    end: link.to,
    above: true,
    create() {
      const dom = document.createElement("div");
      dom.className = "cm-md-link-tooltip";
      const hint = document.createElement("div");
      hint.className = "cm-md-link-tooltip-hint";
      hint.textContent = `${mod} click to open`;
      const url = document.createElement("div");
      url.className = "cm-md-link-tooltip-url";
      url.textContent = link.url;
      dom.appendChild(hint);
      dom.appendChild(url);
      return { dom };
    },
  };
});

/**
 * Full clickable-links extension. `editable` mirrors `buildExtensions`:
 *  - read mode → plain click opens, no tooltip.
 *  - edit mode → Cmd/Ctrl+click opens, hover shows a hint tooltip.
 */
export function linkClick(editable: boolean) {
  const exts = [linkDecorations, makeClickHandlers(editable)];
  if (editable) exts.push(linkHoverTooltip);
  return exts;
}
