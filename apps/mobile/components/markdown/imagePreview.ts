/**
 * Read-mode image rendering for the Markdown view.
 *
 * The editor keeps Markdown as the literal source of truth and shows image
 * syntax (`![alt](url)`) as raw text. The read-only `MarkdownView`, however,
 * should render those images. This ViewPlugin walks the Lezer tree, finds
 * `Image` nodes, and REPLACES each one with an `<img>` widget pointing at the
 * embedded URL.
 *
 * It is intentionally NOT part of the shared editing stack (`setup.ts`) — only
 * `MarkdownView` opts in — so the editor continues to display the raw
 * `![](url)` text the user typed/pasted.
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

function buildImageDecorations(view: EditorView): DecorationSet {
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

/**
 * ViewPlugin that renders `![](url)` as inline images. Used only by the
 * read-only `MarkdownView`.
 */
export const imagePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildImageDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildImageDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
