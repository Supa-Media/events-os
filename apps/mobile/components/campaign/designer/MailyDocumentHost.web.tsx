/**
 * MailyDocumentHost (web) — the real maily.to editor: document-as-surface,
 * floating toolbar, `+`/slash-command gutter, meta fields inline at the top
 * (the founder's screenshot — see `docs/plans/maily-editor-overhaul.md`).
 * `.web.tsx` ONLY: `@maily-to/core`'s `<Editor>` is a contenteditable DOM
 * component and must never reach the native bundle — see
 * `MailyDocumentHost.native.tsx`'s doc.
 *
 * ── Surprises in @maily-to/core's actual behavior (not its docs) ───────────
 *
 *  1. `onUpdate` hands you the TIPTAP `Editor` INSTANCE, not JSON — the plan
 *     doc's "maily's `onUpdate` gives Tiptap JSON" is the intent, not the
 *     literal shape. You call `editor.getJSON()` yourself (`scheduleAutosave`
 *     below).
 *
 *  2. `extensions`/`contentJson`/`onUpdate`/`onCreate` are effectively
 *     captured ONCE, at creation. Maily's own `<Editor>` calls
 *     `@tiptap/react`'s `useEditor(options)` with NO second `deps` argument,
 *     which defaults to `deps: []` — the editor instance is built once and
 *     never rebuilt from a changed `options` object on its own. `useEditor`
 *     DOES call `editor.setOptions(...)` when some non-callback option
 *     changes between renders (a "fast path" short of a full rebuild), but
 *     — this is the sharp edge — it explicitly re-pins
 *     `editable: this.editor.isEditable` while doing so (read
 *     `@tiptap/react`'s `EditorInstanceManager.onRender`), so a NEW
 *     `editable` VALUE passed down as a prop never actually reaches the
 *     underlying ProseMirror view through that path. The fix used here is
 *     the one already established in this codebase
 *     (`MarkdownEditor.native.tsx`'s read/write remount): don't rely on the
 *     prop at all — call the editor's own imperative `editor.setEditable(…)`
 *     in an effect keyed on our `editable` prop.
 *
 *  3. Undo/redo is free. Unlike the block canvas (`lib/emailDesigner.ts`'s
 *     hand-rolled `History<T>` zipper), ProseMirror ships its own history
 *     plugin (bundled in `MailyKit`) with Cmd/Ctrl+Z wired at the keymap
 *     level — nothing to build here.
 *
 *  4. CSS under RNW: `@maily-to/core/dist/index.css` imports as a plain,
 *     bundlable side-effecting import (confirmed at the bundler-graph level
 *     by the WS0 spike; this file carries that finding forward rather than
 *     re-verifying it) — no CSS-in-JS bridge needed, matching
 *     `EditorSpikeScreen.web.tsx`'s own note.
 *
 *  5. There's no built-in "image library" concept — only paste/drop upload
 *     via `ImageUploadExtension`'s `onImageUpload` hook (wired below to
 *     `useDesignerImageUploader`) and a bare URL field on the stock image
 *     node. The "Insert image" strip above the editor (upload OR pick from
 *     `ImageLibraryPicker`) is ours, inserting a stock image node via
 *     `editor.chain().focus().setImage({ src, alt })` — the same command
 *     `@tiptap/extension-image` always exposes.
 *
 * ── Autosave ─────────────────────────────────────────────────────────────
 * Same debounce + in-flight-re-save discipline as `BlocksDocumentComposer`'s
 * (read before writing this) — the DECISIONS are pure and shared
 * (`mailyAutosave.ts`), only the "did anything change" check differs:
 * `history.present` is a stable object reference there; `editor.getJSON()`
 * builds a fresh object on every call, so this compares SERIALIZED content.
 *
 * `onSave` ultimately calls `campaigns.updateCampaignDoc` /
 * `campaignTemplates.updateTemplate` (via `DocumentComposer.tsx`) — both
 * dispatch on the row's own `docFormat` (WS2b) and validate a tiptap-shaped
 * `doc` with `validateTiptapEmailDoc`, so a real autosave here round-trips.
 * This file's autosave logic is covered by `mailyAutosave.test.ts` against
 * mocked decisions, and end to end by `apps/convex/tests/campaignsTiptap.test.ts`.
 *
 * ── Preview ──────────────────────────────────────────────────────────────
 * `api.emailPreview.renderCampaignPreview` (`apps/convex/emailPreview.ts`,
 * WS2b) is a real action — `lib/emailPreview.ts#fetchCampaignPreview` calls
 * it directly. A fetch can still reject (network, `WRONG_FORMAT` on a
 * misrouted call, an org the caller can't read), which this component treats
 * as a routine, expected state — "Preview isn't available yet" — never a
 * live preview it can't actually produce.
 *
 * ── Read-only ────────────────────────────────────────────────────────────
 * `editable={false}` (1) calls `editor.setEditable(false)` so ProseMirror
 * itself refuses edits, (2) skips scheduling any autosave regardless of what
 * else fires (`decideAutosave`'s first check), and (3) wraps the insert-image
 * toolbar in `ReadOnlyProvider` so `ImageUploadButton`/`ImageLibraryPicker`
 * disappear by the SAME mechanism the block canvas already uses — no new
 * read-only idiom introduced.
 */
import "@maily-to/core/dist/index.css";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View, useWindowDimensions } from "react-native";
import { useConvex } from "convex/react";
import { Editor } from "@maily-to/core";
import { ImageUploadExtension } from "@maily-to/core/extensions";
import type { Editor as TiptapEditor, JSONContent } from "@tiptap/core";
import { errorMessage } from "../../../lib/errors";
import { fetchCampaignPreview } from "../../../lib/emailPreview";
import EmailHtmlPreview from "../../email/EmailHtmlPreview";
import { ImageUploadButton, ReadOnlyProvider } from "./DesignerControls";
import { ImageLibraryPicker, useImageLibraryRegistration } from "./ImageLibraryPicker";
import { MailyMetaFields } from "./MailyMetaFields";
import {
  MAILY_AUTOSAVE_DEBOUNCE_MS,
  decideAutosave,
  shouldResaveAfterCompletion,
} from "./mailyAutosave";
import { isTiptapDocEmpty } from "./mailyDoc";
import type { MailyDocumentHostProps } from "./MailyDocumentHost.types";

/** Below this width the preview stacks under the editor — matches
 *  `BlocksDocumentComposer`'s own breakpoint, so the two composers feel like
 *  one product. */
const SPLIT_BREAKPOINT = 960;
/** Extra settle time after a save lands before re-fetching the preview — the
 *  save's own 600ms debounce already batches keystrokes; this just keeps a
 *  burst of "landed, then immediately superseded" re-saves
 *  (`shouldResaveAfterCompletion`) from firing a preview fetch per hop. */
const PREVIEW_REFETCH_DEBOUNCE_MS = 400;

type SaveState = "idle" | "saving" | "saved" | "error";
type PreviewState = "loading" | "ready" | "unavailable";

export function MailyDocumentHost({
  campaignId,
  doc,
  editable,
  lockedNotice,
  onSave,
  run,
  uploadImage,
  meta,
}: MailyDocumentHostProps) {
  const convex = useConvex();
  const { width } = useWindowDimensions();
  const split = width >= SPLIT_BREAKPOINT;
  const { register } = useImageLibraryRegistration();

  const editorRef = useRef<TiptapEditor | null>(null);
  const lastSavedStringRef = useRef<string>(doc ? JSON.stringify(doc) : "");
  const pendingDocRef = useRef<JSONContent | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refs for values a stable callback still needs the LATEST of — the same
  // discipline `BlocksDocumentComposer` uses (`onSaveRef`, `historyRef`) so a
  // caller that forgets to memoize a prop can't turn every render into a
  // save, and so `scheduleAutosave`/`runSave` never close over a stale value.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const uploadImageRef = useRef(uploadImage);
  uploadImageRef.current = uploadImage;

  const [saveState, setSaveState] = useState<SaveState>("idle");
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;
  const [saveError, setSaveError] = useState<string | null>(null);

  const [previewState, setPreviewState] = useState<PreviewState>("loading");
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);

  const refreshPreview = useCallback(() => {
    setPreviewState((s) => (s === "ready" ? s : "loading"));
    fetchCampaignPreview(convex, campaignId)
      .then((result) => {
        setPreviewHtml(result.html);
        setPreviewState("ready");
      })
      .catch(() => {
        setPreviewState("unavailable");
      });
  }, [convex, campaignId]);

  const schedulePreviewRefetch = useCallback(() => {
    if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current);
    previewDebounceRef.current = setTimeout(refreshPreview, PREVIEW_REFETCH_DEBOUNCE_MS);
  }, [refreshPreview]);

  // Initial preview attempt on mount — see the module doc: this routinely
  // resolves "unavailable" until WS2b, which is the honest state to show.
  useEffect(() => {
    refreshPreview();
    return () => {
      if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `editable` doesn't reach the editor via a prop re-render (see the module
  // doc's surprise #2) — flip it imperatively instead.
  useEffect(() => {
    editorRef.current?.setEditable(editable);
  }, [editable]);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  /** Persist `toSave`; on completion, either resolve or immediately re-save
   *  whatever's newer — mirrors `BlocksDocumentComposer#saveDoc` exactly,
   *  keyed on the serialized string instead of an object reference. */
  const runSave = useCallback((toSave: JSONContent, toSaveString: string) => {
    setSaveState("saving");
    onSaveRef
      .current(toSave)
      .then(() => {
        lastSavedStringRef.current = toSaveString;
        setSaveError(null);
        const latest = pendingDocRef.current;
        const latestString = latest ? JSON.stringify(latest) : toSaveString;
        if (latest && shouldResaveAfterCompletion(toSaveString, latestString)) {
          runSave(latest, latestString);
          return;
        }
        setSaveState("saved");
        schedulePreviewRefetch();
      })
      .catch((err: unknown) => {
        setSaveError(errorMessage(err));
        setSaveState("error");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Reads the editor's CURRENT content and decides what to do about it —
   *  called from `onUpdate`. Stable (refs only) so it can be handed to
   *  `<Editor>` once and never go stale (see the module doc's surprise #2 on
   *  why a stable callback identity matters here specifically). */
  const scheduleAutosave = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const next = editor.getJSON();
    pendingDocRef.current = next;
    const nextString = JSON.stringify(next);
    const decision = decideAutosave({
      editable: editableRef.current,
      changed: nextString !== lastSavedStringRef.current,
      showingError: saveStateRef.current === "error",
    });
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (decision.action === "skip") return;
    if (decision.action === "clear-error") {
      setSaveState("saved");
      setSaveError(null);
      return;
    }
    debounceRef.current = setTimeout(() => runSave(next, nextString), decision.delayMs);
  }, [runSave]);

  const handleCreate = useCallback((editor: TiptapEditor) => {
    editorRef.current = editor;
  }, []);
  const handleUpdate = useCallback(
    (editor: TiptapEditor) => {
      editorRef.current = editor;
      scheduleAutosave();
    },
    [scheduleAutosave],
  );

  const extensions = useMemo(() => {
    if (!uploadImage) return [];
    return [
      ImageUploadExtension.configure({
        onImageUpload: async (file: Blob): Promise<string> => {
          const upload = uploadImageRef.current;
          if (!upload) throw new Error("Uploads aren't available on a locked document.");
          const uploaded = await upload(file, file.type || "image/jpeg");
          register(uploaded.storageId, "Pasted image");
          return uploaded.url;
        },
      }),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!uploadImage]);

  function insertImage(url: string, alt: string) {
    editorRef.current?.chain().focus().setImage({ src: url, alt }).run();
  }

  if (doc === undefined) return null;

  return (
    <ReadOnlyProvider value={!editable}>
      {meta ? (
        <MailyMetaFields
          subject={meta.subject}
          previewText={meta.previewText}
          fromLine={meta.fromLine}
          onSaveSubject={meta.onSaveSubject}
          onSavePreviewText={meta.onSavePreviewText}
          editable={editable}
        />
      ) : null}

      {!editable && lockedNotice ? (
        <Text className="mb-3 text-xs text-muted">{lockedNotice}</Text>
      ) : null}

      <View className={split ? "flex-row" : undefined}>
        <View className={split ? "flex-1" : undefined}>
          <View className="mb-3 flex-row items-center justify-between gap-2">
            {editable && uploadImage ? (
              <View className="flex-row flex-wrap items-center gap-2">
                <ImageUploadButton
                  uploadImage={uploadImage}
                  onUploaded={(uploaded, suggestedLabel) => {
                    insertImage(uploaded.url, suggestedLabel);
                    register(uploaded.storageId, suggestedLabel);
                  }}
                  run={run}
                  label="Insert image…"
                />
                <ImageLibraryPicker
                  onPick={(image) => insertImage(image.url, image.alt)}
                />
              </View>
            ) : (
              <View />
            )}
            <SaveIndicator editable={editable} saveState={saveState} error={saveError} />
          </View>

          <View
            className="overflow-hidden rounded-lg border border-border bg-raised"
            style={{ minHeight: 320 }}
          >
            <Editor
              contentJson={doc}
              editable={editable}
              extensions={extensions}
              onCreate={handleCreate}
              onUpdate={handleUpdate}
            />
          </View>
        </View>

        <View className={split ? "ml-4 w-[380px]" : "mt-6"}>
          <Text className="mb-2 text-xs font-bold uppercase tracking-wider text-faint">
            Preview
          </Text>
          {isTiptapDocEmpty(doc) ? (
            <View className="items-center rounded-lg border border-dashed border-border bg-raised px-6 py-14">
              <Text className="text-sm text-muted">Nothing here yet — start typing.</Text>
            </View>
          ) : previewState === "ready" && previewHtml ? (
            <EmailHtmlPreview html={previewHtml} height={split ? 560 : 420} />
          ) : previewState === "loading" ? (
            <View className="items-center rounded-lg border border-border bg-raised px-6 py-14">
              <Text className="text-sm text-faint">Loading preview…</Text>
            </View>
          ) : (
            <View className="items-center rounded-lg border border-dashed border-border bg-raised px-6 py-10">
              <Text className="text-center text-sm text-muted">
                Preview updates after save.
              </Text>
              <Text className="mt-1 text-center text-xs text-faint">
                Not available yet on this deployment.
              </Text>
            </View>
          )}
        </View>
      </View>
    </ReadOnlyProvider>
  );
}

/** Same shape as `BlocksDocumentComposer`'s own `SaveIndicator`, without a
 *  per-field document-validator error explainer — a rejected tiptap save
 *  (`validateTiptapEmailDoc`'s `INVALID_DOC`) surfaces the server's own
 *  message here instead of a client-side breakdown. */
function SaveIndicator({
  editable,
  saveState,
  error,
}: {
  editable: boolean;
  saveState: SaveState;
  error: string | null;
}) {
  if (!editable) return null;
  if (saveState === "saving") return <Text className="text-xs text-muted">Saving…</Text>;
  if (saveState === "saved") return <Text className="text-xs text-success">Saved</Text>;
  if (saveState === "error") {
    return (
      <Text className="max-w-[340px] text-right text-xs text-danger">
        Not saved — {error ?? "something went wrong."}
      </Text>
    );
  }
  return null;
}

export default MailyDocumentHost;
