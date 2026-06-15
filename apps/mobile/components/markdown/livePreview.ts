/**
 * Obsidian-style "live preview" for CodeMirror 6.
 *
 * Markdown stays the literal source of truth in the document — we never convert
 * it to a rich model. Instead we layer VIEW-ONLY decorations on top:
 *
 *   1. Styling decorations  — headings, bold, italic, inline-code, blockquote,
 *      list markers and links get classes so the CM theme can style them.
 *   2. Concealment decorations — the syntax marks themselves (`#`, `**`, `*`,
 *      `` ` ``, `>`, list bullets) are HIDDEN on every line the cursor/selection
 *      is NOT touching, and REVEALED the moment the caret enters that line.
 *
 * Concealment uses `Decoration.replace({})` over just the mark characters, so the
 * surrounding text keeps its place and line heights never shift (we replace with
 * nothing, we don't toggle `display`). List bullets are replaced with a `•`
 * widget instead of being removed, so the bullet is always visible while the
 * `-`/`*`/`+` source character is hidden.
 *
 * The whole thing is driven by a single ViewPlugin that rebuilds its
 * DecorationSet whenever the document or the selection changes. We walk the
 * Lezer syntax tree (`syntaxTree`) rather than regex so nesting (e.g. bold
 * inside a heading) is handled correctly.
 *
 * This module is platform-agnostic plain JS so it can be imported by the web
 * component AND inlined into the native WebView's HTML bundle.
 */
import { syntaxTree } from "@codemirror/language";
import { Range, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";

/** Renders a static bullet glyph in place of a hidden list marker character. */
class BulletWidget extends WidgetType {
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-md-bullet";
    span.textContent = "•";
    return span;
  }
  eq() {
    return true;
  }
  ignoreEvent() {
    return false;
  }
}

const bulletDeco = Decoration.replace({ widget: new BulletWidget() });
const hideDeco = Decoration.replace({});

/** Line decorations carrying a class for block-level styling. */
const lineDeco = (cls: string) => Decoration.line({ class: cls });
/** Mark decorations carrying a class for inline styling. */
const markDeco = (cls: string) => Decoration.mark({ class: cls });

const HEADING_LINE: Record<number, string> = {
  1: "cm-md-h1",
  2: "cm-md-h2",
  3: "cm-md-h3",
  4: "cm-md-h4",
  5: "cm-md-h5",
  6: "cm-md-h6",
};

/**
 * Lezer node names produced by @codemirror/lang-markdown that represent
 * "syntax marks" — the punctuation we conceal on inactive lines.
 */
const MARK_NODES = new Set([
  "HeaderMark", // # ## ###
  "EmphasisMark", // * or _
  "CodeMark", // `
  "QuoteMark", // >
  "LinkMark", // [ ] ( )
  "URL", // hidden link target (kept inside ListItem reveal logic)
]);

/** True when `node` is (or is nested inside) an `Image` syntax node. */
function hasImageAncestor(node: { name: string; parent: any } | null): boolean {
  for (let n = node; n; n = n.parent) {
    if (n.name === "Image") return true;
  }
  return false;
}

/** True when any cursor or selection range overlaps [from, to]. */
function selectionTouchesLine(view: EditorView, from: number, to: number): boolean {
  for (const r of view.state.selection.ranges) {
    if (r.from <= to && r.to >= from) return true;
  }
  return false;
}

function buildDecorations(view: EditorView): DecorationSet {
  // We collect ranges first, then sort, because line + mark decorations are
  // produced out of order while walking the tree, and RangeSetBuilder requires
  // strictly increasing `from` (with start-side ordering for same position).
  const deco: Range<Decoration>[] = [];

  for (const { from, to } of view.visibleRanges) {
    const tree = syntaxTree(view.state);
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;

        // ── Block-level line styling ───────────────────────────────────────
        if (name.startsWith("ATXHeading")) {
          const level = Number(name.slice("ATXHeading".length)) || 1;
          const line = view.state.doc.lineAt(node.from);
          deco.push(lineDeco(HEADING_LINE[level] ?? "cm-md-h1").range(line.from));
          return;
        }
        if (name === "Blockquote") {
          let pos = node.from;
          while (pos <= node.to) {
            const line = view.state.doc.lineAt(pos);
            deco.push(lineDeco("cm-md-quote").range(line.from));
            if (line.to + 1 > node.to) break;
            pos = line.to + 1;
          }
          return;
        }
        if (name === "FencedCode" || name === "CodeBlock") {
          let pos = node.from;
          while (pos <= node.to) {
            const line = view.state.doc.lineAt(pos);
            deco.push(lineDeco("cm-md-codeblock").range(line.from));
            if (line.to + 1 > node.to) break;
            pos = line.to + 1;
          }
          return;
        }

        // ── Inline styling ─────────────────────────────────────────────────
        if (name === "StrongEmphasis") {
          deco.push(markDeco("cm-md-strong").range(node.from, node.to));
          return;
        }
        if (name === "Emphasis") {
          deco.push(markDeco("cm-md-em").range(node.from, node.to));
          return;
        }
        if (name === "InlineCode") {
          deco.push(markDeco("cm-md-code").range(node.from, node.to));
          return;
        }
        if (name === "Link") {
          deco.push(markDeco("cm-md-link").range(node.from, node.to));
          return;
        }

        // ── List bullets: swap source char for a • widget when inactive ─────
        if (name === "ListMark") {
          const active = selectionTouchesLine(view, node.from, node.to);
          if (!active) {
            // Only bullet (unordered) markers get the glyph; ordered "1." marks
            // are left visible (concealing them would lose the number).
            const ch = view.state.doc.sliceString(node.from, node.from + 1);
            if (ch === "-" || ch === "*" || ch === "+") {
              deco.push(bulletDeco.range(node.from, node.to));
            }
          }
          return;
        }

        // ── Syntax marks: conceal on inactive lines ────────────────────────
        if (MARK_NODES.has(name)) {
          // Never conceal a bare URL unless it's the autolink target inside a
          // formatted Link (the Link branch above already styled the whole
          // span); a standalone URL node should stay visible.
          if (name === "URL") return;
          const active = selectionTouchesLine(view, node.from, node.to);
          // Inside an Image (`![](url)`), the imagePreview plugin replaces the
          // whole node with an inline <img> when inactive — so we must NOT also
          // conceal the image's marks here, or the two `Decoration.replace`s
          // collide and the image renders as nothing. When active, fall through
          // so the raw `![](url)` source is revealed for editing.
          if (!active && hasImageAncestor(node.node)) return;
          if (!active) {
            deco.push(hideDeco.range(node.from, node.to));
          }
          return;
        }
      },
    });
  }

  deco.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);

  const builder = new RangeSetBuilder<Decoration>();
  for (const d of deco) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

/**
 * The live-preview ViewPlugin. Rebuilds decorations on any doc change, viewport
 * change, or selection change (the last is what makes marks reveal/hide as the
 * caret moves between lines).
 */
export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
