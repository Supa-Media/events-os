/**
 * CodeMirror 6 theme for the Markdown editor, tuned to the Events OS visual
 * tokens (warm cream surface, dark "ink" text, red accent). Kept as a plain
 * EditorView.theme so it works identically on web and inside the native WebView.
 *
 * The hex values mirror `apps/mobile/lib/theme.ts` (colors.*) — duplicated here
 * because this file is also stringified into the WebView HTML where it can't
 * import the RN theme module.
 */
import { EditorView } from "@codemirror/view";

const INK = "#210909";
const MUTED = "#7A5A5A";
const FAINT = "#A98C8C";
const SURFACE = "#FDF6F6";
const SUNKEN = "#FAEEE9";
const BORDER = "#EFE0DC";
const ACCENT = "#D23B3A";
const LINK = "#4A6BC0";

export const editorTheme = EditorView.theme({
  "&": {
    color: INK,
    backgroundColor: SURFACE,
    fontSize: "16px",
    height: "100%",
  },
  ".cm-scroller": {
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, "DM Sans", "Segoe UI", sans-serif',
    lineHeight: "1.6",
    padding: "12px 4px",
  },
  ".cm-content": {
    caretColor: ACCENT,
    maxWidth: "760px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: ACCENT },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    {
      backgroundColor: "#F2D2D2",
    },
  ".cm-gutters": { display: "none" },
  ".cm-placeholder": { color: FAINT },

  // ── Headings ──────────────────────────────────────────────────────────────
  ".cm-md-h1": { fontSize: "1.9em", fontWeight: "700", lineHeight: "1.25" },
  ".cm-md-h2": { fontSize: "1.55em", fontWeight: "700", lineHeight: "1.3" },
  ".cm-md-h3": { fontSize: "1.3em", fontWeight: "700" },
  ".cm-md-h4": { fontSize: "1.12em", fontWeight: "700" },
  ".cm-md-h5": { fontSize: "1em", fontWeight: "700" },
  ".cm-md-h6": { fontSize: "0.92em", fontWeight: "700", color: MUTED },

  // ── Inline ─────────────────────────────────────────────────────────────────
  ".cm-md-strong": { fontWeight: "700" },
  ".cm-md-em": { fontStyle: "italic" },
  ".cm-md-code": {
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    backgroundColor: SUNKEN,
    borderRadius: "4px",
    padding: "0.1em 0.3em",
    fontSize: "0.9em",
  },
  ".cm-md-link": { color: LINK, textDecoration: "underline" },

  // ── Blocks ──────────────────────────────────────────────────────────────────
  ".cm-md-quote": {
    borderLeft: `3px solid ${BORDER}`,
    paddingLeft: "12px",
    color: MUTED,
    fontStyle: "italic",
  },
  ".cm-md-codeblock": {
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    backgroundColor: SUNKEN,
    fontSize: "0.9em",
  },
  ".cm-md-bullet": { color: ACCENT, paddingRight: "0.35em" },
});
