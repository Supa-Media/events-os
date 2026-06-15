/**
 * Self-contained HTML document that hosts the CodeMirror 6 live-preview editor
 * inside a react-native-webview on native platforms.
 *
 * Why a CDN import instead of the bundled npm packages? CM6 is pure web JS that
 * must run in the WebView's own JS context, not RN's Hermes context, so it can't
 * be `import`ed from the RN bundle. We load it as an ES module from esm.sh (the
 * exact same package versions the web build uses) and inline the live-preview +
 * theme logic below so the editing behaviour is identical to MarkdownEditor.web.
 *
 * Bridge contract:
 *   RN -> WebView:  window.__setValue(markdown)      (via injectJavaScript)
 *                   window.__setEditable(bool)
 *                   window.__insertImage(url)        (inserts ![](url) at caret)
 *   WebView -> RN:  postMessage(JSON{type:"change", value})
 *                   postMessage(JSON{type:"ready"})
 *
 * NOTE: This variant requires a network connection on first load (CDN fetch).
 * For an offline-capable native build, pre-bundle CM6 with esbuild into an asset
 * and swap the import URL for a `file://` / bundled-asset URL — the rest of the
 * bridge is unchanged.
 */

// CM versions pinned to match apps/mobile/package.json so native == web.
const CM_VERSIONS = {
  state: "6.6.0",
  view: "6.43.1",
  commands: "6.10.3",
  language: "6.12.3",
  langMarkdown: "6.5.0",
};

/**
 * Build the HTML. `initialValue` seeds the document; everything else is driven
 * over the message bridge. The live-preview + theme source is inlined verbatim
 * (kept in sync with livePreview.ts / theme.ts).
 */
export function buildEditorHtml(opts: {
  initialValue: string;
  editable: boolean;
  placeholder?: string;
}): string {
  const initial = JSON.stringify(opts.initialValue ?? "");
  const editable = opts.editable ? "true" : "false";
  const placeholder = JSON.stringify(opts.placeholder ?? "");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #FDF6F6; }
  #root { height: 100%; }
  .cm-editor { height: 100%; }
  /* iOS WebView defaults to non-selectable content, which silently disables
     text selection, the copy/paste callout, and clipboard paste in the
     contentEditable. Force the editor surface to be selectable + pasteable. */
  .cm-content, .cm-line {
    -webkit-user-select: text !important;
    user-select: text !important;
    -webkit-touch-callout: default !important;
  }
  /* Inline images rendered in place of ![](url). */
  .cm-md-image {
    max-width: 100%;
    height: auto;
    border-radius: 8px;
    display: block;
    margin: 4px 0;
  }
</style>
</head>
<body>
<div id="root"></div>
<script type="module">
  import { EditorState, RangeSetBuilder } from "https://esm.sh/@codemirror/state@${CM_VERSIONS.state}";
  import {
    EditorView, Decoration, ViewPlugin, WidgetType, keymap,
    placeholder as placeholderExt
  } from "https://esm.sh/@codemirror/view@${CM_VERSIONS.view}";
  import { defaultKeymap, history, historyKeymap } from "https://esm.sh/@codemirror/commands@${CM_VERSIONS.commands}";
  import { syntaxTree } from "https://esm.sh/@codemirror/language@${CM_VERSIONS.language}";
  import { markdown, markdownLanguage } from "https://esm.sh/@codemirror/lang-markdown@${CM_VERSIONS.langMarkdown}";

  // ── live-preview (mirror of livePreview.ts) ───────────────────────────────
  class BulletWidget extends WidgetType {
    toDOM() { const s = document.createElement("span"); s.className = "cm-md-bullet"; s.textContent = "•"; return s; }
    eq() { return true; } ignoreEvent() { return false; }
  }
  const bulletDeco = Decoration.replace({ widget: new BulletWidget() });
  const hideDeco = Decoration.replace({});
  const lineDeco = (cls) => Decoration.line({ class: cls });
  const markDeco = (cls) => Decoration.mark({ class: cls });
  const HEADING_LINE = {1:"cm-md-h1",2:"cm-md-h2",3:"cm-md-h3",4:"cm-md-h4",5:"cm-md-h5",6:"cm-md-h6"};
  const MARK_NODES = new Set(["HeaderMark","EmphasisMark","CodeMark","QuoteMark","LinkMark","URL"]);

  function touches(view, from, to) {
    for (const r of view.state.selection.ranges) if (r.from <= to && r.to >= from) return true;
    return false;
  }
  function buildDecorations(view) {
    const deco = [];
    for (const { from, to } of view.visibleRanges) {
      const tree = syntaxTree(view.state);
      tree.iterate({ from, to, enter: (node) => {
        const name = node.name;
        if (name.startsWith("ATXHeading")) {
          const level = Number(name.slice(10)) || 1;
          const line = view.state.doc.lineAt(node.from);
          deco.push(lineDeco(HEADING_LINE[level] || "cm-md-h1").range(line.from)); return;
        }
        if (name === "Blockquote") {
          let pos = node.from;
          while (pos <= node.to) { const line = view.state.doc.lineAt(pos);
            deco.push(lineDeco("cm-md-quote").range(line.from));
            if (line.to + 1 > node.to) break; pos = line.to + 1; } return;
        }
        if (name === "FencedCode" || name === "CodeBlock") {
          let pos = node.from;
          while (pos <= node.to) { const line = view.state.doc.lineAt(pos);
            deco.push(lineDeco("cm-md-codeblock").range(line.from));
            if (line.to + 1 > node.to) break; pos = line.to + 1; } return;
        }
        if (name === "StrongEmphasis") { deco.push(markDeco("cm-md-strong").range(node.from, node.to)); return; }
        if (name === "Emphasis") { deco.push(markDeco("cm-md-em").range(node.from, node.to)); return; }
        if (name === "InlineCode") { deco.push(markDeco("cm-md-code").range(node.from, node.to)); return; }
        if (name === "Link") { deco.push(markDeco("cm-md-link").range(node.from, node.to)); return; }
        if (name === "ListMark") {
          if (!touches(view, node.from, node.to)) {
            const ch = view.state.doc.sliceString(node.from, node.from + 1);
            if (ch === "-" || ch === "*" || ch === "+") deco.push(bulletDeco.range(node.from, node.to));
          } return;
        }
        if (MARK_NODES.has(name)) {
          if (name === "URL") return;
          if (!touches(view, node.from, node.to)) deco.push(hideDeco.range(node.from, node.to));
          return;
        }
      }});
    }
    deco.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
    const builder = new RangeSetBuilder();
    for (const d of deco) builder.add(d.from, d.to, d.value);
    return builder.finish();
  }
  const livePreview = ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = buildDecorations(view); }
    update(u) { if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = buildDecorations(u.view); }
  }, { decorations: (v) => v.decorations });

  // ── image preview (mirror of imagePreview.ts) ─────────────────────────────
  // Renders ![alt](url) as an inline <img>, except the one the caret is touching
  // in edit mode (so its URL stays editable).
  class ImageWidget extends WidgetType {
    constructor(url, alt) { super(); this.url = url; this.alt = alt; }
    eq(other) { return other.url === this.url && other.alt === this.alt; }
    toDOM() { const img = document.createElement("img"); img.className = "cm-md-image"; img.src = this.url; img.alt = this.alt; return img; }
    ignoreEvent() { return false; }
  }
  function parseImage(src) {
    const m = /^!\\[([^\\]]*)\\]\\(\\s*<?([^)\\s>]*)>?(?:\\s+["'][^)]*["'])?\\s*\\)$/.exec(src);
    if (!m) return null;
    const url = (m[2] || "").trim();
    if (!url) return null;
    return { url, alt: m[1] || "" };
  }
  function buildImageDecorations(view, revealActive) {
    const builder = new RangeSetBuilder();
    for (const { from, to } of view.visibleRanges) {
      syntaxTree(view.state).iterate({ from, to, enter: (node) => {
        if (node.name !== "Image") return;
        const src = view.state.doc.sliceString(node.from, node.to);
        const parsed = parseImage(src);
        if (!parsed) return;
        if (revealActive && touches(view, node.from, node.to)) return;
        builder.add(node.from, node.to, Decoration.replace({ widget: new ImageWidget(parsed.url, parsed.alt) }));
      }});
    }
    return builder.finish();
  }
  const REVEAL_ACTIVE_IMAGES = ${editable};
  const imagePreview = ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = buildImageDecorations(view, REVEAL_ACTIVE_IMAGES); }
    update(u) {
      if (u.docChanged || u.viewportChanged || (REVEAL_ACTIVE_IMAGES && u.selectionSet))
        this.decorations = buildImageDecorations(u.view, REVEAL_ACTIVE_IMAGES);
    }
  }, { decorations: (v) => v.decorations });

  // ── theme (mirror of theme.ts) ────────────────────────────────────────────
  const editorTheme = EditorView.theme({
    "&": { color: "#210909", backgroundColor: "#FDF6F6", fontSize: "16px", height: "100%" },
    ".cm-scroller": { fontFamily: 'ui-sans-serif, system-ui, -apple-system, "DM Sans", sans-serif', lineHeight: "1.6", padding: "12px 8px" },
    ".cm-content": { caretColor: "#D23B3A" },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#D23B3A" },
    ".cm-selectionBackground, .cm-content ::selection": { backgroundColor: "#F2D2D2" },
    ".cm-gutters": { display: "none" },
    ".cm-placeholder": { color: "#A98C8C" },
    ".cm-md-h1": { fontSize: "1.9em", fontWeight: "700" },
    ".cm-md-h2": { fontSize: "1.55em", fontWeight: "700" },
    ".cm-md-h3": { fontSize: "1.3em", fontWeight: "700" },
    ".cm-md-h4": { fontSize: "1.12em", fontWeight: "700" },
    ".cm-md-h5": { fontSize: "1em", fontWeight: "700" },
    ".cm-md-h6": { fontSize: "0.92em", fontWeight: "700", color: "#7A5A5A" },
    ".cm-md-strong": { fontWeight: "700" },
    ".cm-md-em": { fontStyle: "italic" },
    ".cm-md-code": { fontFamily: "ui-monospace, Menlo, monospace", backgroundColor: "#FAEEE9", borderRadius: "4px", padding: "0.1em 0.3em", fontSize: "0.9em" },
    ".cm-md-link": { color: "#4A6BC0", textDecoration: "underline" },
    ".cm-md-quote": { borderLeft: "3px solid #EFE0DC", paddingLeft: "12px", color: "#7A5A5A", fontStyle: "italic" },
    ".cm-md-codeblock": { fontFamily: "ui-monospace, Menlo, monospace", backgroundColor: "#FAEEE9", fontSize: "0.9em" },
    ".cm-md-bullet": { color: "#D23B3A", paddingRight: "0.35em" },
  });

  // ── editor + bridge ───────────────────────────────────────────────────────
  const post = (msg) => window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  let suppress = false; // ignore change events caused by programmatic setValue

  const PLACEHOLDER = ${placeholder};
  const exts = [
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    markdown({ base: markdownLanguage }),
    EditorView.lineWrapping,
    livePreview,
    imagePreview,
    editorTheme,
    EditorState.readOnly.of(!(${editable})),
    EditorView.editable.of(${editable}),
    EditorView.updateListener.of((u) => { if (u.docChanged && !suppress) post({ type: "change", value: u.state.doc.toString() }); }),
  ];
  if (PLACEHOLDER) exts.push(placeholderExt(PLACEHOLDER));

  const view = new EditorView({
    state: EditorState.create({ doc: ${initial}, extensions: exts }),
    parent: document.getElementById("root"),
  });

  window.__setValue = (md) => {
    const cur = view.state.doc.toString();
    if (cur === md) return;
    suppress = true;
    view.dispatch({ changes: { from: 0, to: cur.length, insert: md } });
    suppress = false;
  };
  window.__setEditable = (on) => {
    view.dispatch({ effects: EditorView.editable.reconfigure ? [] : [] });
    // editable is a static facet here; full reconfigure would require a
    // Compartment. For the doc feature, editability is fixed per-mount, so we
    // simply re-render the WebView when it changes (handled on the RN side).
  };

  // Insert an image at the current caret. Native picks + uploads the image on
  // the RN side (no clipboard/file access inside the WebView), then injects the
  // resolved URL here. We embed it as ![](url) on its own line so the image
  // preview plugin renders it inline. The change event flows back as usual.
  window.__insertImage = (url) => {
    if (!url) return;
    const sel = view.state.selection.main;
    const head = sel.head;
    const before = head > 0 ? view.state.doc.sliceString(head - 1, head) : "\\n";
    const lead = before === "\\n" || head === 0 ? "" : "\\n";
    const snippet = lead + "![](" + url + ")\\n";
    view.dispatch({
      changes: { from: head, to: sel.to, insert: snippet },
      selection: { anchor: head + snippet.length },
    });
    view.focus();
  };

  post({ type: "ready" });
</script>
</body>
</html>`;
}
