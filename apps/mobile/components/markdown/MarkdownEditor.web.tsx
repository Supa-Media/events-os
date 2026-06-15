/**
 * MarkdownEditor (web) — an Obsidian-style live-preview Markdown editor built on
 * CodeMirror 6, mounted directly into the DOM. react-native-web is React DOM
 * under the hood, so a plain DOM React component renders inside RN screens.
 *
 * The stored value is always literal Markdown — this editor never converts to a
 * rich-document model. Syntax marks (`#`, `**`, `` ` ``, `>`, bullets …) are
 * concealed on inactive lines and revealed when the caret enters the line, via
 * the `livePreview` ViewPlugin (see ./livePreview.ts).
 *
 * Usage:
 *
 *   import { MarkdownEditor } from "@/components/markdown";
 *
 *   function HowToDocEditor() {
 *     const [body, setBody] = useState("# Title\n\nSome **bold** text.");
 *     return (
 *       <MarkdownEditor
 *         value={body}
 *         onChange={setBody}
 *         placeholder="Write your how-to…"
 *       />
 *     );
 *   }
 */
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";

import { buildExtensions } from "./setup";
import type { MarkdownEditorProps } from "./types";

export function MarkdownEditor({
  value,
  onChange,
  editable = true,
  placeholder,
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Keep the latest onChange without re-creating the editor on every render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Create the EditorView once (re-created only when editable/placeholder flip).
  useEffect(() => {
    if (!hostRef.current) return;

    const state = EditorState.create({
      doc: value,
      extensions: buildExtensions({
        editable,
        placeholder,
        onChange: (md) => onChangeRef.current(md),
      }),
    });

    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, placeholder]);

  // Sync external value changes into the editor without clobbering the caret
  // when the change originated from the editor itself.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  return (
    <div
      ref={hostRef}
      style={{
        height: "100%",
        width: "100%",
        overflow: "auto",
        backgroundColor: "#FDF6F6",
        borderRadius: 14,
        border: "1px solid #EFE0DC",
      }}
    />
  );
}

export default MarkdownEditor;
