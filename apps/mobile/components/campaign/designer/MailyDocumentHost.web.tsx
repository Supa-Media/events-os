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
import { Pressable, Text, View, useWindowDimensions } from "react-native";
import { useConvex } from "convex/react";
import { Editor } from "@maily-to/core";
import { ImageUploadExtension } from "@maily-to/core/extensions";
import { isNodeSelection } from "@tiptap/core";
import type { Editor as TiptapEditor, JSONContent } from "@tiptap/core";
import { colors } from "../../../lib/theme";
import { errorMessage } from "../../../lib/errors";
import { fetchCampaignPreview } from "../../../lib/emailPreview";
import EmailHtmlPreview from "../../email/EmailHtmlPreview";
import { ImageUploadButton, ReadOnlyProvider } from "./DesignerControls";
import { ImageLibraryPicker, useImageLibraryRegistration } from "./ImageLibraryPicker";
import { Icon, Radio, RadioGroup, type IconName } from "../../ui";
// Explicit `.web` suffix (not a bare specifier): `MailyImagePickerModal` has
// no native counterpart at all (no bridge file to fall back to) — a bare
// import resolves fine under Metro's platform-extension lookup but not under
// plain `tsc`/Node resolution, which doesn't know that convention.
import { MailyImagePickerModal } from "./MailyImagePickerModal.web";
import { MailyMetaFields } from "./MailyMetaFields";
import { ComposerFormatSwitchLink } from "./ComposerFormatSwitchLink";
import {
  MAILY_AUTOSAVE_DEBOUNCE_MS,
  decideAutosave,
  shouldResaveAfterCompletion,
} from "./mailyAutosave";
import { isTiptapDocEmpty } from "./mailyDoc";
import { PW_NODE_PACK_EXTENSIONS } from "./pwNodePack";
import { PwDocAttrsExtension } from "./pwDocAttrs";
import {
  FILLED_IMAGE_NODE_TYPES,
  findFilledImageClickTarget,
  findImagePlaceholderWrapper,
  resolveImageNodePos,
} from "./pwImagePlaceholderIntercept";
import { isNodeDeleteKeydown } from "./pwSelectedNodeDelete";
import { clampPopperLeft } from "./pwPopperClamp";
import {
  BUTTON_ALIGNMENTS,
  buttonAlignmentUpdate,
  resolveSelectedButtonAlignment,
  type ButtonAlignment,
  type SelectedNodeLike,
} from "./pwButtonAlignment";
import { forceIframeColorScheme } from "./previewColorScheme";
import {
  PREVIEW_WIDTHS,
  PREVIEW_WIDTH_IDS,
  DEFAULT_PREVIEW_WIDTH_ID,
  type PreviewWidthId,
} from "./previewWidth";
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
  formatSwitch,
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
  // Mirrors `imagePickerTarget` for the delete-keymap capture listener below
  // (a stable callback, same ref discipline as `editableRef`/`onSaveRef`) —
  // Delete/Backspace must never hijack a keystroke meant for the picker
  // modal's own Close/Upload controls while it's open.
  const imagePickerTargetRef = useRef(imagePickerTarget);
  imagePickerTargetRef.current = imagePickerTarget;
  // Preview pane's Light/Dark VIEW toggle (founder bug #3) — defaults to
  // light regardless of the designer's own OS/browser preference; see
  // `previewColorScheme.ts`'s module doc for why this can't be a CSS-only
  // fix. Purely a view control: the real send keeps rendering both.
  const [previewScheme, setPreviewScheme] = useState<"light" | "dark">("light");
  // Preview pane's Mobile/Tablet/Desktop WIDTH toggle (founder bug #7) — a
  // SECOND, independent view control alongside `previewScheme`; see
  // `previewWidth.ts`'s module doc. Composes freely with light/dark (each
  // toggle only ever touches its own half of the preview: colour scheme
  // rewrites the HTML string, width constrains the iframe's own box).
  const [previewWidthId, setPreviewWidthId] = useState<PreviewWidthId>(DEFAULT_PREVIEW_WIDTH_ID);
  // Document-level Font control (founder bug #5 — Google-Docs-style, lives
  // on the DOCUMENT since themes-the-system are dead, not a picker over a
  // theme table). Initialized from the doc's own attr once; from then on
  // the editor's live doc attrs are authoritative (see `changeFontStack`).
  const [fontStackId, setFontStackId] = useState<PwFontStackId>(() => {
    const attr = (doc?.attrs as { pwFontFamily?: unknown } | undefined)?.pwFontFamily;
    return isPwFontStackId(attr) ? attr : DEFAULT_PW_FONT_STACK_ID;
  });
  // Founder bug #5, round two: OUR OWN button-alignment control (see
  // `pwButtonAlignment.ts`'s module doc for why this exists instead of
  // relying on maily's own nested-Popover `AlignmentSwitch`). `null` means
  // "no button node is currently selected" — the control below doesn't
  // render at all then, only appearing when there's actually something for
  // it to act on. Kept in sync by a `transaction` listener registered in
  // `handleCreate` (every selection AND doc change goes through a
  // transaction, so this one hook covers both "designer clicked a different
  // button" and "the selected button's alignment changed").
  const [selectedButtonAlignment, setSelectedButtonAlignment] = useState<ButtonAlignment | null>(null);
  // The selected button's OWN ProseMirror position — NOT derived from
  // `editor.state.selection` at click time (see the module doc: that's
  // exactly the timing sensitivity that made maily's own control
  // unreliable). Captured when selection last changed; re-verified fresh
  // against the CURRENT doc in `setSelectedButtonAlignment` before writing.
  const selectedButtonPosRef = useRef<number | null>(null);

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

  // Founder bug #2 (both halves): maily's own "Click or Drop image here"
  // placeholder is a raw `<input type="file">` with no click handler to
  // intercept at the React level — only a capture-phase DOM listener runs
  // early enough to cancel its native file dialog (see
  // `pwImagePlaceholderIntercept.ts`'s module doc). The SAME listener also
  // catches a click on an ALREADY-FILLED image (maily's `image`/`logo`, or
  // our own `pwBleedImage`) and routes it to the SAME picker to REPLACE that
  // node's `src`/`alt` in place — stock maily has no "replace" affordance at
  // all once an image has a `src`, so this is the only place that click ever
  // gets handled. Read-only never wires this: nothing renders an editable
  // placeholder OR an editable filled image then.
  useEffect(() => {
    if (!editable) return;
    const container = editorContainerRef.current;
    if (!container) return;
    function handleClickCapture(e: MouseEvent) {
      const editor = editorRef.current;
      if (!editor) return;

      const placeholderWrapper = findImagePlaceholderWrapper(e.target);
      if (placeholderWrapper) {
        const pos = resolveImageNodePos(editor.view, editor.state.doc, placeholderWrapper);
        if (pos == null) return;
        // Cancel the input's native file-picker dialog — must happen
        // synchronously, in this capture-phase listener, before the input's
        // own default action runs (see the module doc's "why this works").
        e.preventDefault();
        e.stopPropagation();
        const nodeType = editor.state.doc.nodeAt(pos)?.type.name;
        if (!nodeType) return;
        setImagePickerTarget({ pos, nodeType });
        return;
      }

      const filledWrapper = findFilledImageClickTarget(e.target);
      if (filledWrapper) {
        const pos = resolveImageNodePos(editor.view, editor.state.doc, filledWrapper, FILLED_IMAGE_NODE_TYPES);
        if (pos == null) return;
        e.preventDefault();
        e.stopPropagation();
        const nodeType = editor.state.doc.nodeAt(pos)?.type.name;
        if (!nodeType) return;
        // Select the node too, not just open the picker — the SAME "click
        // selects" behavior every other node in the editor already has
        // (buttons, sections, …). Matters for founder bug #1: closing the
        // picker without picking a replacement (Escape/click-away) should
        // leave the image genuinely selected, so Delete/Backspace still
        // removes it — not just "opened a modal that did nothing."
        editor.commands.setNodeSelection(pos);
        setImagePickerTarget({ pos, nodeType });
      }
    }
    container.addEventListener("click", handleClickCapture, true);
    return () => container.removeEventListener("click", handleClickCapture, true);
  }, [editable]);

  // Founder bug #1: Delete/Backspace should remove the currently selected
  // block/atom node (a button, an image, a `pwBleedImage`/`pwPoll`, a
  // section, …) — see `pwSelectedNodeDelete.ts`'s module doc for exactly why
  // this doesn't already work via `@tiptap/core`'s own keymap.
  //
  // Listens on `document`, not `editorContainerRef` — a capture-phase
  // listener only ever sees events whose target is INSIDE the listening
  // element's own subtree (capture walks document → … → target); for a
  // NON-focusable node-view element (a plain `<img>`, our `pwBleedImage`/
  // `pwPoll`'s bare `renderHTML` markup, or after this file's OWN image-
  // click handler above calls `preventDefault`/`stopPropagation` and closes
  // a modal), the browser's focus can land on `document.body` ITSELF —
  // outside our container entirely — so a container-scoped listener never
  // fires (confirmed in the harness: `.ProseMirror-selectednode` genuinely
  // present, `document.activeElement === document.body`, Delete did
  // nothing). `container.contains(activeElement) || activeElement ===
  // document.body` below is the safety gate that keeps this document-level
  // listener from ever hijacking a keystroke meant for a DIFFERENT, genuinely
  // focused control elsewhere on the page (the Subject/Preview-text meta
  // inputs above this editor, in particular) — those keep real DOM focus on
  // their own `<input>`, which is neither inside our container nor `body`.
  useEffect(() => {
    if (!editable) return;
    const container = editorContainerRef.current;
    if (!container) return;
    function handleKeyDownCapture(e: KeyboardEvent) {
      // Never hijack a keystroke while the image picker modal is open — its
      // own Close/Upload buttons and the library grid are plain interactive
      // controls, not a place Delete/Backspace should reach past into the
      // document (see `imagePickerTargetRef` below).
      if (imagePickerTargetRef.current) return;
      if (!isNodeDeleteKeydown(e.key, e.target as { tagName?: string; isContentEditable?: boolean } | null)) {
        return;
      }
      const active = document.activeElement;
      if (!container!.contains(active) && active !== document.body) return;
      const editor = editorRef.current;
      if (!editor) return;
      if (!isNodeSelection(editor.state.selection)) return;
      e.preventDefault();
      e.stopPropagation();
      editor.chain().focus().deleteSelection().run();
    }
    document.addEventListener("keydown", handleKeyDownCapture, true);
    return () => document.removeEventListener("keydown", handleKeyDownCapture, true);
  }, [editable]);

  // Founder bug #4: maily's own button bubble-menu toolbar (`ButtonView`,
  // `@maily-to/core`) is a non-portaled Radix Popover positioned via
  // `@radix-ui/react-popper`'s `strategy: "fixed"` — for a button near the
  // left edge of its column, Radix's own collision-avoidance has nowhere to
  // put the ~620px-wide toolbar but flush against the browser's left edge,
  // visually disconnected from the button and, on a narrow enough window,
  // genuinely clipped (see `pwPopperClamp.ts`'s module doc). This observer
  // re-clamps Radix's own positioning wrapper back on-screen every time Radix
  // (re)computes it — scoped to the editor's own container, since these
  // popovers are never portaled (they render exactly where the React tree
  // puts them, nested under `editorContainerRef`).
  useEffect(() => {
    if (!editable) return;
    const container = editorContainerRef.current;
    if (!container || typeof MutationObserver === "undefined") return;

    function clampWrapper(wrapper: HTMLElement) {
      const currentTransform = wrapper.style.transform;
      if (!currentTransform) return;
      const width = wrapper.getBoundingClientRect().width;
      if (width <= 0) return;
      const corrected = clampPopperLeft(currentTransform, window.innerWidth, width);
      if (corrected) wrapper.style.transform = corrected;
    }

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          const target = mutation.target as HTMLElement;
          if (target.hasAttribute?.("data-radix-popper-content-wrapper")) clampWrapper(target);
          continue;
        }
        for (const node of Array.from(mutation.addedNodes)) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.hasAttribute("data-radix-popper-content-wrapper")) {
            clampWrapper(node);
          }
          node
            .querySelectorAll?.("[data-radix-popper-content-wrapper]")
            .forEach((el) => clampWrapper(el as HTMLElement));
        }
      }
    });
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style"],
    });
    return () => observer.disconnect();
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

  /** Reads the editor's CURRENT selection and updates
   *  `selectedButtonAlignment`/`selectedButtonPosRef` accordingly — stable
   *  (refs only) so it can be registered on the editor's own `transaction`
   *  event exactly once, in `handleCreate` (see that callback's own doc on
   *  why direct `editor.on(...)` registration, not a `useEffect`, is the
   *  right place: the editor instance itself is only ever created once —
   *  the module doc's surprise #2). */
  const syncSelectedButtonAlignment = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const selection = editor.state.selection;
    const resolved = isNodeSelection(selection)
      ? resolveSelectedButtonAlignment(selection as unknown as SelectedNodeLike)
      : null;
    selectedButtonPosRef.current = resolved?.pos ?? null;
    setSelectedButtonAlignment(resolved?.alignment ?? null);
  }, []);

  /** Writes a NEW alignment onto whichever button `selectedButtonPosRef`
   *  currently points at — see `pwButtonAlignment.ts`'s module doc for why
   *  this is a direct, position-based `tr.setNodeMarkup` rather than
   *  `editor.commands.updateAttributes(name, attrs)` (which walks the
   *  CURRENT selection instead of a captured position). `buttonAlignmentUpdate`
   *  re-verifies the position still resolves to a button and merges the
   *  CURRENT (not stale-closure) attrs, failing closed (no-op) otherwise. */
  const changeSelectedButtonAlignment = useCallback((alignment: ButtonAlignment) => {
    const editor = editorRef.current;
    const pos = selectedButtonPosRef.current;
    if (!editor || pos == null) return;
    const update = buttonAlignmentUpdate(editor.state.doc, pos, alignment);
    if (!update) return;
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.setNodeMarkup(pos, undefined, update.attrs);
        return true;
      })
      .run();
  }, []);

  const handleCreate = useCallback(
    (editor: TiptapEditor) => {
      editorRef.current = editor;
      // Every selection change AND every doc change dispatches a
      // `transaction` — one hook covers both "designer clicked a different
      // button" and "the selected button's alignment (or anything else)
      // changed underneath it" (e.g. our OWN `changeSelectedButtonAlignment`
      // above, which is exactly how the control's `isActive`-style
      // highlighting below stays correct after a click).
      editor.on("transaction", syncSelectedButtonAlignment);
    },
    [syncSelectedButtonAlignment],
  );
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

      {editable && formatSwitch ? <ComposerFormatSwitchLink formatSwitch={formatSwitch} /> : null}

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
                {/* Founder bug #5, round two — OUR OWN reliable replacement
                 *  for maily's flaky nested-Popover `AlignmentSwitch` (see
                 *  `pwButtonAlignment.ts`'s module doc). Only rendered while
                 *  a button node is actually selected — same "nothing to act
                 *  on, don't show a control" discipline `ImageUploadButton`/
                 *  `ImageLibraryPicker` already follow for `!uploadImage`. */}
                {selectedButtonAlignment ? (
                  <ButtonAlignmentControl
                    value={selectedButtonAlignment}
                    onChange={changeSelectedButtonAlignment}
                  />
                ) : null}
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
          <View className="mb-2 flex-row flex-wrap items-center justify-between gap-2">
            <Text className="text-xs font-bold uppercase tracking-wider text-faint">
              Preview
            </Text>
            <View className="flex-row flex-wrap items-center gap-2">
              {/* Founder bug #7: a SECOND, independent toggle from Light/Dark
               *  below — constrains the iframe's own rendered width so a
               *  designer can see how the email reflows at a phone/tablet
               *  viewport, not just full desktop-webmail width. Composes
               *  freely with Light/Dark (`previewWidth.ts`'s module doc). */}
              <View className="flex-row overflow-hidden rounded-md border border-border-strong">
                {PREVIEW_WIDTH_IDS.map((option) => (
                  <Text
                    key={option}
                    accessibilityRole="button"
                    onPress={() => setPreviewWidthId(option)}
                    className={`px-2 py-1 text-2xs font-semibold ${
                      previewWidthId === option ? "bg-accent text-white" : "bg-raised text-muted"
                    }`}
                  >
                    {PREVIEW_WIDTHS[option].label}
                  </Text>
                ))}
              </View>
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
          </View>
          {isTiptapDocEmpty(doc) ? (
            <View className="items-center rounded-lg border border-dashed border-border bg-raised px-6 py-14">
              <Text className="text-sm text-muted">Nothing here yet — start typing.</Text>
            </View>
          ) : previewState === "ready" && previewHtml ? (
            // `overflow-x-auto` — the iframe below is set to the SELECTED
            // width (founder bug #7), which for Tablet (768px) routinely
            // exceeds this pane's own `w-[380px]`; a horizontal scroller
            // keeps the wider preview fully reachable instead of clipping it
            // (the built-in web browser convention for "content wider than
            // its viewport", not a bug this pane needs to hide).
            <div style={{ overflowX: "auto" }}>
              <div style={{ width: PREVIEW_WIDTHS[previewWidthId].width ?? "100%" }}>
                <EmailHtmlPreview
                  html={forceIframeColorScheme(previewHtml, previewScheme)}
                  // Preview-only: fit the whole email (founder bug,
                  // 2026-07-30 — "weird that we can't see the whole thing").
                  // SPLIT view keeps a fixed pane on purpose: it sits beside
                  // the editor, and a document-height pane would stretch the
                  // editor column to thousands of px alongside it.
                  height={split ? 560 : "auto"}
                />
              </div>
            </div>
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

const BUTTON_ALIGNMENT_ICON: Record<ButtonAlignment, IconName> = {
  left: "align-left",
  center: "align-center",
  right: "align-right",
};
const BUTTON_ALIGNMENT_LABEL: Record<ButtonAlignment, string> = {
  left: "Align button left",
  center: "Align button center",
  right: "Align button right",
};

/**
 * Founder bug #5, round two — Left/Center/Right for the CURRENTLY SELECTED
 * button (see `pwButtonAlignment.ts`'s module doc for why this exists at
 * all: maily's own nested-Popover `AlignmentSwitch` didn't reliably persist
 * a click in this environment). A compact icon-only segmented pill — same
 * visual language as the Light/Dark and Mobile/Tablet/Desktop pills in the
 * preview pane below, sized down to icons (not full words) since this one
 * lives in the ALREADY-fairly-full main toolbar and only appears
 * conditionally, not permanently claiming space.
 */
function ButtonAlignmentControl({
  value,
  onChange,
}: {
  value: ButtonAlignment;
  onChange: (alignment: ButtonAlignment) => void;
}) {
  return (
    <RadioGroup
      accessibilityLabel="Button alignment"
      horizontal
      className="flex-row overflow-hidden rounded-md border border-border-strong"
    >
      {BUTTON_ALIGNMENTS.map((alignment) => {
        const active = value === alignment;
        return (
          <Radio
            key={alignment}
            checked={active}
            onSelect={() => onChange(alignment)}
            accessibilityLabel={BUTTON_ALIGNMENT_LABEL[alignment]}
            className={`h-[30px] w-[30px] items-center justify-center ${
              active ? "bg-accent" : "bg-raised hover:bg-sunken"
            }`}
          >
            <Icon
              name={BUTTON_ALIGNMENT_ICON[alignment]}
              size={14}
              color={active ? "#FFFFFF" : colors.muted}
            />
          </Radio>
        );
      })}
    </RadioGroup>
  );
}

export default MailyDocumentHost;
