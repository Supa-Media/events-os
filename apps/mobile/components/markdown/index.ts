/**
 * Obsidian-style live-preview Markdown editor.
 *
 * - `MarkdownEditor` — CodeMirror 6 live-preview editor. Platform-split:
 *   `.web.tsx` mounts CM6 in the DOM; `.native.tsx` hosts it in a WebView.
 * - `MarkdownView` — read-only renderer (share page) reusing the editor.
 *
 * The stored value is always literal Markdown — never a rich-document model.
 */
export { MarkdownEditor } from "./MarkdownEditor";
export { MarkdownView } from "./MarkdownView";
export type { MarkdownViewProps } from "./MarkdownView";
export type { MarkdownEditorProps } from "./types";
