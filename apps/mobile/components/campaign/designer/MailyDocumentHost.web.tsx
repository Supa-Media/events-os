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
// Founder bug #4 (bubble-menu labels overlapping, e.g. a button's Border
// Radius/Style dropdowns) — see this file's own doc, no new import needed
// there.
import "./mailyOverrides.css";

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
// Explicit `.web` suffix (not a bare specifier): `MailyImagePickerModal` has
// no native counterpart at all (no bridge file to fall back to) — a bare
// import resolves fine under Metro's platform-extension lookup but not under
// plain `tsc`/Node resolution, which doesn't know that convention.
import { MailyImagePickerModal } from "./MailyImagePickerModal.web";
import { MailyMetaFields } from "./MailyMetaFields";
import {
  MAILY_AUTOSAVE_DEBOUNCE_MS,
  decideAutosave,
  shouldResaveAfterCompletion,
} from "./mailyAutosave";
import { isTiptapDocEmpty } from "./mailyDoc";
import { PW_NODE_PACK_EXTENSIONS } from "./pwNodePack";
import { PwDocAttrsExtension } from "./pwDocAttrs";
import { findImagePlaceholderWrapper, resolveImageNodePos } from "./pwImagePlaceholderIntercept";
import { forceIframeColorScheme } from "./previewColorScheme";
import {
  PW_FONT_STACK_IDS,
  PW_FONT_STACKS,
  DEFAULT_PW_FONT_STACK_ID,
  isPwFontStackId,
  pwFontFamilyCss,
  type PwFontStackId,
} from "@events-os/shared";
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
  // The DOM node the editor mounts into — RN Web forwards `View`'s `ref` to
  // its underlying `<div>`, which is what the image-placeholder capture
  // listener below needs (see `pwImagePlaceholderIntercept.ts`'s module doc).
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  // Which image/logo placeholder node a click just intercepted — `null` means
  // the picker modal is closed. Set by the capture-phase listener, cleared by
  // the modal's own close/pick/upload paths.
  const [imagePickerTarget, setImagePickerTarget] = useState<{
    pos: number;
    nodeType: string;
  } | null>(null);
  // Preview pane's Light/Dark VIEW toggle (founder bug #3) — defaults to
  // light regardless of the designer's own OS/browser preference; see
  // `previewColorScheme.ts`'s module doc for why this can't be a CSS-only
  // fix. Purely a view control: the real send keeps rendering both.
  const [previewScheme, setPreviewScheme] = useState<"light" | "dark">("light");
  // Document-level Font control (founder bug #5 — Google-Docs-style, lives
  // on the DOCUMENT since themes-the-system are dead, not a picker over a
  // theme table). Initialized from the doc's own attr once; from then on
  // the editor's live doc attrs are authoritative (see `changeFontStack`).
  const [fontStackId, setFontStackId] = useState<PwFontStackId>(() => {
    const attr = (doc?.attrs as { pwFontFamily?: unknown } | undefined)?.pwFontFamily;
    return isPwFontStackId(attr) ? attr : DEFAULT_PW_FONT_STACK_ID;
  });

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

  // Founder bug #2: maily's own "Click or Drop image here" placeholder is a
  // raw `<input type="file">` with no click handler to intercept at the React
  // level — only a capture-phase DOM listener runs early enough to cancel its
  // native file dialog (see `pwImagePlaceholderIntercept.ts`'s module doc).
  // Read-only never wires this: nothing renders an editable placeholder then.
  useEffect(() => {
    if (!editable) return;
    const container = editorContainerRef.current;
    if (!container) return;
    function handleClickCapture(e: MouseEvent) {
      const wrapper = findImagePlaceholderWrapper(e.target);
      if (!wrapper) return;
      const editor = editorRef.current;
      if (!editor) return;
      const pos = resolveImageNodePos(editor.view, editor.state.doc, wrapper);
      if (pos == null) return;
      // Cancel the input's native file-picker dialog — must happen
      // synchronously, in this capture-phase listener, before the input's
      // own default action runs (see the module doc's "why this works").
      e.preventDefault();
      e.stopPropagation();
      const nodeType = editor.state.doc.nodeAt(pos)?.type.name;
      if (!nodeType) return;
      setImagePickerTarget({ pos, nodeType });
    }
    container.addEventListener("click", handleClickCapture, true);
    return () => container.removeEventListener("click", handleClickCapture, true);
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
    // The Public Worship node pack (`pwHeading`/`pwParagraph`/`pwBleedImage`/
    // `pwPoll`) is ALWAYS registered, not conditional on `uploadImage` — every
    // built-in and every real newsletter is built from these node types
    // (`tiptapNewsletterTemplate.ts`), and omitting them is exactly the bug
    // `pwNodePack.ts`'s module doc describes: an unrecognized node type makes
    // Tiptap's own JSON parser discard the WHOLE document, silently, back to
    // empty — "opened the built-in template and it was blank."
    // `PwDocAttrsExtension` is likewise unconditional — `pwCanvasColor` (and
    // now `pwFontFamily`, founder bug #5) need to survive a round-trip on
    // EVERY document, not just ones a designer happens to touch the Font
    // control on (see that file's own module doc on the silent-drop bug this
    // closes).
    const base = [...PW_NODE_PACK_EXTENSIONS, PwDocAttrsExtension];
    if (!uploadImage) return base;
    return [
      ...base,
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

  /** Change the document's font stack (founder bug #5). `setDocAttribute` is
   *  ProseMirror's own transform-level API for a root `doc` attr — the usual
   *  `updateAttributes(name, attrs)` command can't reach it (it walks
   *  `nodesBetween` over the current SELECTION, which by construction never
   *  visits the root doc node itself). Dispatching straight through
   *  `editor.view` still fires the SAME `onUpdate` this file's autosave
   *  already listens for (Tiptap wraps `EditorView`'s own `dispatchTransaction`,
   *  which `view.dispatch` always goes through) — no separate save path
   *  needed here. */
  function changeFontStack(id: PwFontStackId) {
    const editor = editorRef.current;
    if (!editor) return;
    editor.view.dispatch(editor.state.tr.setDocAttribute("pwFontFamily", id));
    setFontStackId(id);
  }

  /** Fill a SPECIFIC image/logo placeholder node — the node the intercepted
   *  click identified (`imagePickerTarget`), never "whatever's selected" —
   *  `setNodeSelection(pos)` first pins the selection to exactly that node so
   *  `updateAttributes` can't land on a different one (see
   *  `pwImagePlaceholderIntercept.ts`'s doc on why the position is resolved
   *  up front instead of trusted to still be selected later). */
  function fillImagePlaceholder(target: { pos: number; nodeType: string }, url: string, alt: string) {
    editorRef.current
      ?.chain()
      .focus()
      .setNodeSelection(target.pos)
      .updateAttributes(target.nodeType, { src: url, alt })
      .run();
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
          {/* Chrome-polish pass: ONE quiet control bar, not two stacked rows.
           *  The prior layout gave the Font control its own row (a 3-button
           *  segmented pill showing every label at once — "Sans (Inter) |
           *  Serif (Georgia) | Mono (Courier New)" — sized wider than
           *  anything else in the chrome) directly above a SECOND row for
           *  Insert-image/library, and rendered that second row even in
           *  read-only mode (empty but for its own `mb-3`, pure dead space —
           *  `SaveIndicator` returns `null` when `!editable`). Both are fixed
           *  by gating the whole bar on `editable` and folding the Font
           *  control into it as a compact `<select>` (`FontStackSelect`
           *  below) instead of a pill — see that component's own doc. */}
          {editable ? (
            <View className="mb-3 flex-row flex-wrap items-center justify-between gap-2">
              <View className="flex-row flex-wrap items-center gap-2">
                <FontStackSelect value={fontStackId} onChange={changeFontStack} />
                {uploadImage ? (
                  <>
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
                  </>
                ) : null}
              </View>
              <SaveIndicator editable={editable} saveState={saveState} error={saveError} />
            </View>
          ) : null}

          {/* A plain `<div>`, not RN's `View` — same "web-only file needs a
           *  real DOM ref/style" precedent as `MarkdownEditor.web.tsx`'s own
           *  `hostRef` container. Two things a `View` can't give this node:
           *  a `ref` that's actually an `HTMLDivElement` (what the
           *  image-placeholder capture listener needs, `editorContainerRef`)
           *  and a `fontFamily` style (RN's `ViewStyle` only allows that on
           *  `Text`, not `View` — `View`'s types reject it even though RNW
           *  would render it fine). `className` still works identically:
           *  NativeWind's JSX transform intercepts at the pragma level, not
           *  per-component, so a plain intrinsic element gets the same
           *  interop a `View` would. */}
          <div
            // `overflow-hidden` used to clip maily's own hover chrome — the
            // block drag handle + `+` insert button, which float in a LEFT
            // GUTTER outside the prose content column (rendered via a
            // tippy.js popper positioned ~46px left of the block, confirmed
            // in `__adv__/harness/`: with no rail, that popper lands at a
            // NEGATIVE x relative to this container and gets clipped clean
            // off — "hover a block, the +/drag handle are missing"). Two
            // changes fix it: `overflow-visible` so the popper is never
            // clipped regardless of where it lands, and `pl-10` (40px) so
            // the prose column starts far enough right that the gutter has
            // real room INSIDE the visible card instead of hanging off its
            // left edge. Losing `overflow-hidden` costs nothing visible today
            // — nothing in ordinary (non-hover) content touches the
            // container's rounded corners.
            className="overflow-visible rounded-lg border border-border bg-raised pl-10"
            // The Font control's other half — the editor's OWN display, not
            // just the send-side renderer (founder bug #5's explicit "both"
            // requirement). `fontFamily` cascades from here down through
            // maily's prose content by ordinary CSS inheritance; maily's own
            // `mly:prose` class doesn't set a competing `font-family` on the
            // content root, so this reaches every node without touching
            // `pwNodePack.ts`'s per-node styles.
            style={{ minHeight: 320, fontFamily: pwFontFamilyCss(fontStackId), position: "relative" }}
            ref={editorContainerRef}
          >
            <Editor
              contentJson={doc}
              editable={editable}
              extensions={extensions}
              onCreate={handleCreate}
              onUpdate={handleUpdate}
            />
            {imagePickerTarget ? (
              <MailyImagePickerModal
                onClose={() => setImagePickerTarget(null)}
                onPick={(image) => fillImagePlaceholder(imagePickerTarget, image.url, image.alt)}
                uploadImage={uploadImage}
                run={run}
                onUploaded={(uploaded, suggestedLabel) => {
                  fillImagePlaceholder(imagePickerTarget, uploaded.url, suggestedLabel);
                  register(uploaded.storageId, suggestedLabel);
                }}
              />
            ) : null}
          </div>
        </View>

        <View className={split ? "ml-4 w-[380px]" : "mt-6"}>
          <View className="mb-2 flex-row items-center justify-between">
            <Text className="text-xs font-bold uppercase tracking-wider text-faint">
              Preview
            </Text>
            {/* Founder bug #3: this pane used to inherit the designer's own
             *  OS/browser dark-mode preference (the iframe has no way to
             *  resolve `prefers-color-scheme` any other way) — always defaults
             *  to light now, with dark still one tap away, since real
             *  recipients DO see dark mode (`previewColorScheme.ts`). */}
            <View className="flex-row overflow-hidden rounded-md border border-border-strong">
              {(["light", "dark"] as const).map((option) => (
                <Text
                  key={option}
                  accessibilityRole="button"
                  onPress={() => setPreviewScheme(option)}
                  className={`px-2 py-1 text-2xs font-semibold ${
                    previewScheme === option ? "bg-accent text-white" : "bg-raised text-muted"
                  }`}
                >
                  {option === "light" ? "Light" : "Dark"}
                </Text>
              ))}
            </View>
          </View>
          {isTiptapDocEmpty(doc) ? (
            <View className="items-center rounded-lg border border-dashed border-border bg-raised px-6 py-14">
              <Text className="text-sm text-muted">Nothing here yet — start typing.</Text>
            </View>
          ) : previewState === "ready" && previewHtml ? (
            <EmailHtmlPreview
              html={forceIframeColorScheme(previewHtml, previewScheme)}
              height={split ? 560 : 420}
            />
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

/**
 * Document-level Font picker (founder bug #5), "Google-Docs-style" per this
 * file's own module doc — a COMPACT dropdown, not the 3-button segmented
 * pill this replaced. That pill showed all three full labels ("Sans (Inter)
 * | Serif (Georgia) | Mono (Courier New)") side by side at once — the widest
 * single control in the chrome, and heavier than the document it sits above
 * has any business competing with (maily's own aesthetic: the document is
 * the surface, controls stay quiet — see maily's OWN bubble-menu `<select
 * appearance:none>`s, `mailyOverrides.css`'s doc). A native `<select>` shows
 * only the CURRENT choice until opened, in that same spirit — literally
 * maily's own control shape — without reaching for an internal, unexported
 * maily component (`@maily-to/core` only exports `Editor`) or a cross-
 * platform popover (`ui/FilterSelect.tsx`'s `Pressable`+`Popover` pattern)
 * that would pull `@expo/vector-icons`' font-based glyphs into a document
 * chrome control that has no native counterpart to share code with anyway —
 * this file is already `.web.tsx`-only.
 *
 * A plain DOM element, so — like the editor container `<div>` above —
 * `className` is a normal HTML attribute here: no `cssInterop` registration
 * needed the way `View`/`Text` need one (see `build.mjs`'s doc on why those
 * two specifically require `jsxImportSource: "nativewind"` to keep a passed
 * `className` from being overwritten).
 */
function FontStackSelect({
  value,
  onChange,
}: {
  value: PwFontStackId;
  onChange: (id: PwFontStackId) => void;
}) {
  return (
    <select
      aria-label="Font"
      value={value}
      onChange={(e) => {
        const next = e.target.value;
        if (isPwFontStackId(next)) onChange(next);
      }}
      className="h-[30px] rounded-md border border-border-strong bg-raised px-2 text-xs font-medium text-muted hover:bg-sunken"
    >
      {PW_FONT_STACK_IDS.map((id) => (
        <option key={id} value={id}>
          {PW_FONT_STACKS[id].label}
        </option>
      ))}
    </select>
  );
}

export default MailyDocumentHost;
