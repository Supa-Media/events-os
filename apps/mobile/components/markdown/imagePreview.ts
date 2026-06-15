/**
 * Inline image rendering for the Markdown surface.
 *
 * Markdown stays the literal source of truth — image syntax (`![alt](url)`) is
 * never converted to a rich model. This ViewPlugin walks the Lezer tree, finds
 * `Image` nodes, and renders an `<img>` in their place so pasted/uploaded images
 * are actually VISIBLE instead of showing as raw `![](url)` text.
 *
 * Two modes:
 *
 *  - Read mode (`MarkdownView`): every image renders inline, always.
 *  - Edit mode (the live editor): images render inline too, EXCEPT the one the
 *    caret/selection is currently touching — that one reveals its raw
 *    `![](url)` source so the URL stays editable. This mirrors the live-preview
 *    "reveal syntax on the active line" behaviour for the rest of the markdown.
 *
 * Plain JS (uses `document`) so it can also be inlined into the native WebView's
 * HTML bundle for the read surface if needed.
 */
import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";

/** Renders an <img> in place of `![alt](url)` source. */
class ImageWidget extends WidgetType {
  constructor(
    private readonly url: string,
    private readonly alt: string,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return other.url === this.url && other.alt === this.alt;
  }
  toDOM() {
    const img = document.createElement("img");
    img.className = "cm-md-image";
    img.src = this.url;
    img.alt = this.alt;
    return img;
  }
  ignoreEvent() {
    return false;
  }
}

/** Extract the URL and alt text out of an `Image` Lezer node's source slice. */
function parseImage(src: string): { url: string; alt: string } | null {
  // Image markdown: ![alt](url "optional title")
  const m = /^!\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+["'][^)]*["'])?\s*\)$/.exec(
    src,
  );
  if (!m) return null;
  const url = m[2]?.trim();
  if (!url) return null;
  return { url, alt: m[1] ?? "" };
}

/** True when any cursor or selection range overlaps [from, to]. */
function selectionTouches(view: EditorView, from: number, to: number): boolean {
  for (const r of view.state.selection.ranges) {
    if (r.from <= to && r.to >= from) return true;
  }
  return false;
}

/**
 * @param revealActive when true (edit mode), the image whose source the caret is
 *   touching is left as raw text instead of being replaced with an `<img>`, so
 *   the URL stays editable. When false (read mode), every image is replaced.
 */
function buildImageDecorations(
  view: EditorView,
  revealActive: boolean,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "Image") return;
        const src = view.state.doc.sliceString(node.from, node.to);
        const parsed = parseImage(src);
        if (!parsed) return;
        if (revealActive && selectionTouches(view, node.from, node.to)) return;
        builder.add(
          node.from,
          node.to,
          Decoration.replace({
            widget: new ImageWidget(parsed.url, parsed.alt),
          }),
        );
      },
    });
  }
  return builder.finish();
}

function makeImagePreview(revealActive: boolean) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildImageDecorations(view, revealActive);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          // In edit mode, moving the caret on/off an image toggles raw ↔ inline.
          (revealActive && update.selectionSet)
        ) {
          this.decorations = buildImageDecorations(update.view, revealActive);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/**
 * Renders `![](url)` as inline images, always. Used by the read-only
 * `MarkdownView`.
 */
export const imagePreview = makeImagePreview(false);

/**
 * Renders `![](url)` as inline images in the editor, but reveals the raw source
 * of the image the caret is touching so its URL stays editable.
 */
export const imagePreviewEditable = makeImagePreview(true);
