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
  /**
   * Concrete pixel height for the editor box. Required in practice because the
   * editor is almost always mounted inside a scroll container (a content-sized
   * parent), where a percentage/flex height collapses to ~0px and the editor
   * disappears. Defaults to 480.
   */
  minHeight?: number;
  /**
   * Web only. When provided, images pasted or dropped into the editor are
   * uploaded via this callback and embedded as Markdown `![](url)`. Receives the
   * image blob and content type; resolves to a stable, servable URL. Native
   * builds ignore it (no DOM clipboard/drag surface).
   */
  uploadImage?: (file: Blob, contentType: string) => Promise<string>;
};
