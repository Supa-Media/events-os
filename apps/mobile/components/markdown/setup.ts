/**
 * Shared CodeMirror 6 extension stack for the Markdown live-preview editor.
 *
 * Both the web component (mounts CM6 in the DOM) and the native WebView (loads a
 * stringified copy of this stack) build their EditorState from this list so the
 * editing experience is byte-for-byte identical across platforms.
 */
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState, Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExt } from "@codemirror/view";

import { imagePreview, imagePreviewEditable } from "./imagePreview";
import { livePreview } from "./livePreview";
import { editorTheme } from "./theme";

/**
 * Uploads an image blob and resolves to a servable URL to embed in the doc.
 * Supplied by the host component (which owns the Convex client). Web only —
 * paste/drop image handling is wired only when this is provided.
 */
export type UploadImage = (file: Blob, contentType: string) => Promise<string>;

export type BuildExtensionsOptions = {
  editable: boolean;
  placeholder?: string;
  /** Called with the new doc string whenever the document changes. */
  onChange?: (markdown: string) => void;
  /**
   * When provided (web editor only), pasted/dropped images are uploaded via
   * this callback and embedded as Markdown `![](url)`.
   */
  uploadImage?: UploadImage;
};

/** First image File found in a clipboard/drag DataTransfer, or null. */
function imageFromDataTransfer(dt: DataTransfer | null): File | null {
  if (!dt) return null;
  // Prefer items (covers clipboard paste of raw image data, which has no name).
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  for (const file of Array.from(dt.files ?? [])) {
    if (file.type.startsWith("image/")) return file;
  }
  return null;
}

/**
 * Insert an `![uploading…]()` placeholder at `pos`, upload the image, then swap
 * the placeholder for `![](<url>)`. The placeholder text is matched and replaced
 * by exact string (re-located at swap time) so concurrent typing can't corrupt
 * positions.
 */
function embedImage(
  view: EditorView,
  file: Blob,
  pos: number,
  uploadImage: UploadImage,
) {
  // Unique token so multiple concurrent uploads don't collide.
  const token = `![uploading…#${Math.random().toString(36).slice(2, 8)}]()`;
  view.dispatch({
    changes: { from: pos, insert: token },
    selection: { anchor: pos + token.length },
  });

  const replacePlaceholder = (replacement: string) => {
    const doc = view.state.doc.toString();
    const at = doc.indexOf(token);
    if (at === -1) return; // placeholder removed/edited away — give up silently.
    view.dispatch({
      changes: { from: at, to: at + token.length, insert: replacement },
    });
  };

  void uploadImage(file, file.type || "image/png")
    .then((url) => replacePlaceholder(`![](${url})`))
    .catch(() => replacePlaceholder("")); // drop the placeholder on failure.
}

/**
 * Embed an image at the current caret position. Used by the web editor's
 * "Add image" button (the file-picker path); paste/drop go through the
 * domEventHandlers below. Exported so the host component can wire the button.
 */
export function insertImageAtCaret(
  view: EditorView,
  file: Blob,
  uploadImage: UploadImage,
) {
  embedImage(view, file, view.state.selection.main.head, uploadImage);
}

export function buildExtensions(opts: BuildExtensionsOptions): Extension[] {
  const exts: Extension[] = [
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    markdown({ base: markdownLanguage }),
    EditorView.lineWrapping,
    livePreview,
    editorTheme,
    EditorState.readOnly.of(!opts.editable),
    EditorView.editable.of(opts.editable),
  ];

  // Render `![](url)` as actual <img> on both surfaces so pasted/uploaded
  // images are visible. Read mode (MarkdownView) renders every image; the
  // editor reveals the raw source of the image the caret is on so its URL
  // stays editable.
  exts.push(opts.editable ? imagePreviewEditable : imagePreview);

  if (opts.placeholder) exts.push(placeholderExt(opts.placeholder));

  if (opts.onChange) {
    const cb = opts.onChange;
    exts.push(
      EditorView.updateListener.of((u) => {
        if (u.docChanged) cb(u.state.doc.toString());
      }),
    );
  }

  // Web-only image paste/drop → upload → embed as `![](url)`.
  if (opts.editable && opts.uploadImage) {
    const uploadImage = opts.uploadImage;
    exts.push(
      EditorView.domEventHandlers({
        paste(event, view) {
          const file = imageFromDataTransfer(event.clipboardData);
          if (!file) return false;
          event.preventDefault();
          embedImage(view, file, view.state.selection.main.head, uploadImage);
          return true;
        },
        drop(event, view) {
          const file = imageFromDataTransfer(event.dataTransfer);
          if (!file) return false;
          event.preventDefault();
          const pos =
            view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
            view.state.selection.main.head;
          embedImage(view, file, pos, uploadImage);
          return true;
        },
      }),
    );
  }

  return exts;
}
