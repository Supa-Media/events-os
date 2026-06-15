/** Shared prop contract for every MarkdownEditor platform variant. */
export type MarkdownEditorProps = {
  /** The document body — literal Markdown. This is the source of truth. */
  value: string;
  /** Fires with the new Markdown string on every edit. */
  onChange: (markdown: string) => void;
  /** When false, the editor is read-only (live-preview rendering still applies). */
  editable?: boolean;
  /** Placeholder shown when the document is empty. */
  placeholder?: string;
};
