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

import { livePreview } from "./livePreview";
import { editorTheme } from "./theme";

export type BuildExtensionsOptions = {
  editable: boolean;
  placeholder?: string;
  /** Called with the new doc string whenever the document changes. */
  onChange?: (markdown: string) => void;
};

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

  if (opts.placeholder) exts.push(placeholderExt(opts.placeholder));

  if (opts.onChange) {
    const cb = opts.onChange;
    exts.push(
      EditorView.updateListener.of((u) => {
        if (u.docChanged) cb(u.state.doc.toString());
      }),
    );
  }

  return exts;
}
