/**
 * MarkdownEditor (web) — an Obsidian-style live-preview Markdown editor built on
 * CodeMirror 6, mounted directly into the DOM. react-native-web is React DOM
 * under the hood, so a plain DOM React component renders inside RN screens.
 *
 * The stored value is always literal Markdown — this editor never converts to a
 * rich-document model. Syntax marks (`#`, `**`, `` ` ``, `>`, bullets …) are
 * concealed on inactive lines and revealed when the caret enters the line, via
 * the `livePreview` ViewPlugin (see ./livePreview.ts). Images embedded as
 * `![](url)` render inline (see ./imagePreview.ts).
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

import { buildExtensions, insertImageAtCaret } from "./setup";
import type { MarkdownEditorProps } from "./types";

export function MarkdownEditor({
  value,
  onChange,
  editable = true,
  placeholder,
  minHeight = 480,
  uploadImage,
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Keep the latest onChange without re-creating the editor on every render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Same for uploadImage — the paste/drop handlers read it through the ref so a
  // new callback identity per render doesn't tear down the editor.
  const uploadImageRef = useRef(uploadImage);
  uploadImageRef.current = uploadImage;

  // Create the EditorView once (re-created only when editable/placeholder flip).
  useEffect(() => {
    if (!hostRef.current) return;

    const state = EditorState.create({
      doc: value,
      extensions: buildExtensions({
        editable,
        placeholder,
        onChange: (md) => onChangeRef.current(md),
        // Wire image upload only when a callback is supplied. Indirect through
        // the ref so the editor isn't re-created when the prop identity changes.
        uploadImage: uploadImage
          ? (file, contentType) => uploadImageRef.current!(file, contentType)
          : undefined,
      }),
    });

    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, placeholder, !!uploadImage]);

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

  // "Add image" button: open the OS file picker, upload, embed `![](url)` at the
  // caret — the same upload path used for paste/drop.
  const showAddImage = editable && !!uploadImage;
  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    const view = viewRef.current;
    const upload = uploadImageRef.current;
    if (!file || !view || !upload) return;
    insertImageAtCaret(view, file, (f, ct) => upload(f, ct));
  }

  return (
    <div style={{ position: "relative", width: "100%" }}>
      <div
        ref={hostRef}
        style={{
          height: minHeight,
          width: "100%",
          overflow: "auto",
          backgroundColor: "#FDF6F6",
          borderRadius: 14,
          border: "1px solid #EFE0DC",
        }}
      />
      {showAddImage ? (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={onPickFile}
            style={{ display: "none" }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="Add image"
            style={{
              position: "absolute",
              top: 10,
              right: 14,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 10px",
              fontSize: 13,
              fontWeight: 600,
              color: "#7A5A5A",
              backgroundColor: "#FAEEE9",
              border: "1px solid #EFE0DC",
              borderRadius: 8,
              cursor: "pointer",
            }}
          >
            <span aria-hidden style={{ fontSize: 14, lineHeight: 1 }}>
              🖼
            </span>
            Add image
          </button>
        </>
      ) : null}
    </div>
  );
}

export default MarkdownEditor;
