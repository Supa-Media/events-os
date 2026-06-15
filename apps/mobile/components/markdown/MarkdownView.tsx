/**
 * MarkdownView — a read-only renderer for displaying a doc's Markdown body
 * (e.g. on the public share page).
 *
 * It reuses the same CodeMirror 6 live-preview stack as the editor in
 * `editable={false}` mode. Because nothing is ever focused, no line is "active",
 * so every syntax mark stays concealed — giving a clean rendered-Markdown look
 * with zero extra dependencies and pixel-for-pixel consistency with the editor.
 *
 * This is intentionally the same component across platforms (it delegates to the
 * platform-split MarkdownEditor), so it works on web and inside the native
 * WebView alike.
 */
import { MarkdownEditor } from "./MarkdownEditor";
import type { MarkdownEditorProps } from "./types";

export type MarkdownViewProps = Pick<MarkdownEditorProps, "value">;

export function MarkdownView({ value }: MarkdownViewProps) {
  return <MarkdownEditor value={value} onChange={noop} editable={false} />;
}

function noop() {}

export default MarkdownView;
