/**
 * DOCUMENT COMPOSER — the block-based email editor, in one place.
 *
 * This is the whole editing surface: the undo/redo history, the debounced
 * autosave and its indicator, the CANVAS with its palette and inspector, the
 * live HTML preview, the merge-tag row, and the theme picker above the
 * preview. Both editable documents render it — the campaign designer
 * (`app/(app)/campaign/[id]/design.tsx`) and the template editor
 * (`app/(app)/campaign-template/[id].tsx`) — so everything a designer knows
 * about composing an email holds in both places by construction.
 *
 * The screens keep what is genuinely theirs: the access gate, the record's own
 * header, and — crucially — WHAT SAVING MEANS. A campaign autosaves through
 * `campaigns.updateCampaignDoc`, a template through
 * `campaignTemplates.updateTemplate`; this component only knows it has an
 * `onSave` that resolves or rejects.
 *
 * ── The canvas (Stage 1 of docs/plans/email-editor-canvas.md) ───────────────
 * The editor used to be a stack of form cards on the left and a preview on the
 * right — "put information on the left and then preview on the right", as the
 * product owner put it, asking instead for something closer to Canva. So the
 * form stack is gone: `canvas/EmailCanvas.tsx` draws the document as what it
 * will look like, at the email's own 600px scale, in document order. Click a
 * block to select it; a contextual toolbar appears on it and its properties
 * appear in the inspector; headings, body copy, button labels and poll options
 * type straight onto the page.
 *
 * The sandboxed iframe preview STAYS, beside the canvas, as the read-only
 * "what Gmail will actually show" pane. The canvas is a second renderer of the
 * same document and the iframe is the arbiter between them — see the plan's §2
 * for why that split is the honest one, and `packages/shared/src/emailGeometry.ts`
 * for the single geometry table that keeps them from drifting.
 *
 * ── Editing model (unchanged) ──────────────────────────────────────────────
 * Local `EmailDocument` state wrapped in a linear undo/redo history
 * (`lib/emailDesigner.ts`'s `History<EmailDocument>` — a snapshot zipper),
 * debounce-autosaved 600ms after the last edit. Cmd/Ctrl+Z / +Shift+Z
 * undo/redo on web, mirroring `SiteMapEditor`'s keyboard-shortcut precedent.
 *
 * ── Read-only means it ─────────────────────────────────────────────────────
 * When `editable` is false the canvas renders the document with no selection,
 * no toolbars, no inspector and no palette — a locked page you can read,
 * instead of live-looking controls wired to no-op handlers, which is what used
 * to let someone type into a locked document and lose the words on reload. The
 * two callers arrive there for different reasons — a campaign past
 * `draft`/`changes_requested`, or a viewer without `campaigns.design` power on
 * a template — so the explanatory line is theirs to supply (`lockedNotice`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, View, useWindowDimensions } from "react-native";
import {
  renderCampaignEmail,
  type EmailBlockKind,
  type EmailDocument,
  type EmailTheme,
} from "@events-os/shared";
import { Button, Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import { errorMessage } from "../../../lib/errors";
import type { ActionRunner } from "../../../lib/useActionToast";
import {
  canRedo,
  canUndo,
  duplicateBlock,
  explainDocError,
  initHistory,
  insertBlock,
  moveBlock,
  pushHistory,
  redoHistory,
  removeBlock,
  undoHistory,
  updateBlock,
  type History,
} from "../../../lib/emailDesigner";
import { confirmAction } from "../helpers";
import { BlockPalette } from "./BlockPalette";
import { MergeTagRow } from "./MergeTagRow";
import { CampaignThemePicker, type ThemeChoice } from "./CampaignThemePicker";
import { ReadOnlyProvider } from "./DesignerControls";
import EmailHtmlPreview from "../../email/EmailHtmlPreview";
import { useDesignerImageUploader } from "./useImageUploader";
import { EmailCanvas, type CanvasEditingTarget } from "./canvas/EmailCanvas";
import { BlockInspector } from "./canvas/BlockInspector";
import { canvasTheme } from "./canvas/canvasStyles";
import { documentWarnings } from "./canvas/blockWarnings";
import {
  canMoveBlock,
  composerKeyIntent,
  keyEventIsInsideCanvas,
  selectionAfterDelete,
  selectionAfterHistoryChange,
  stepSelection,
} from "./canvas/canvasSelection";

/** Below this width the preview stacks under the editor instead of beside it. */
const SPLIT_BREAKPOINT = 960;
/** Debounce between the last edit and the autosave call. */
const AUTOSAVE_DEBOUNCE_MS = 600;

/** Sample recipient the live preview renders against — never sent anywhere. */
const PREVIEW_RECIPIENT = { name: "Ada Lovelace", email: "ada@example.com" };

/** Autosave states. `error` exists so a rejected save is VISIBLE — see
 *  `saveDoc`'s catch for why that's a routine state rather than a
 *  never-happens one. */
export type SaveState = "idle" | "saving" | "saved" | "error";

export type DocumentComposerProps = {
  /** The stored document. `undefined` while it's still loading — the composer
   *  renders nothing until it arrives, then seeds its history ONCE from it
   *  (later remote changes deliberately don't stomp local edits). */
  doc: EmailDocument | undefined;
  /** False renders the whole canvas locked (see the module doc). */
  editable: boolean;
  /** Why it's locked, in the caller's own words. Only shown when `!editable`. */
  lockedNotice?: string;
  /** Persist the document. MUST reject on failure — a rejection is what the
   *  save indicator turns into a reason via `explainDocError`. */
  onSave: (doc: EmailDocument) => Promise<unknown>;
  /**
   * Restyle. Resolves to the theme that actually landed (or null when the
   * write was refused), which the composer folds back into its local history:
   * the theme is applied SERVER-side to the document as stored, and this
   * screen autosaves `history.present` wholesale, so without the fold the very
   * next keystroke would push the old theme straight back over the restyle.
   *
   * Omit to hide the picker entirely.
   */
  onApplyTheme?: (choice: ThemeChoice) => Promise<EmailTheme | null>;
  /** Surfaces failures (uploads, theme writes) — the screen owns the toast. */
  run: ActionRunner["run"];
  /** Copy for the "nothing here yet" state while it can still be filled in. */
  emptyMessage?: string;
  /** The same state on a LOCKED document, where "add a block above" would be
   *  advice about a control that isn't on screen. */
  lockedEmptyMessage?: string;
};

export function DocumentComposer({
  doc: loadedDoc,
  editable,
  lockedNotice,
  onSave,
  onApplyTheme,
  run,
  emptyMessage = "Add a block above to start writing this email.",
  lockedEmptyMessage = "This email has no blocks yet.",
}: DocumentComposerProps) {
  const [history, setHistory] = useState<History<EmailDocument> | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<CanvasEditingTarget>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [canvasWidth, setCanvasWidth] = useState(0);
  // The canvas's own DOM subtree on web, so its keyboard shortcuts can be
  // scoped to it (see `keyEventIsInsideCanvas`). Null on native, where there
  // is no keyboard handler at all.
  const canvasRef = useRef<View | null>(null);
  const lastSavedRef = useRef<EmailDocument | null>(null);
  // A "latest" ref for `history` — the debounce timer's closure (and the
  // save-completion callback below) is captured at EFFECT-SETUP time, so
  // without this it can only ever see the `history` that was current when
  // ITS OWN save kicked off, not whatever the user has since undone/redone
  // to while that save was still in flight.
  const historyRef = useRef<History<EmailDocument> | null>(null);
  historyRef.current = history;
  // The callbacks are the SCREEN's, re-created on its every render unless it
  // memoizes. Reading them through refs keeps `saveDoc` (and the autosave
  // effect that depends on it) stable regardless — a caller that forgets a
  // `useCallback` must not turn every render into a save.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const { width } = useWindowDimensions();
  const split = width >= SPLIT_BREAKPOINT;
  const uploadImage = useDesignerImageUploader(editable);

  // Seed history exactly once, when the document first loads.
  useEffect(() => {
    if (loadedDoc && history === null) {
      setHistory(initHistory(loadedDoc));
      lastSavedRef.current = loadedDoc;
    }
  }, [loadedDoc, history]);

  const emptyDoc = useMemo<EmailDocument>(() => ({ blocks: [] }), []);
  const doc = history?.present ?? emptyDoc;

  /**
   * Persist `toSave`, then check whether `history.present` has moved on (an
   * undo/redo — or any edit — landing while THIS save was still in flight).
   * If it has, immediately re-save the CURRENT present instead of waiting
   * out another debounce cycle: without this, a save already in flight when
   * an undo lands can resolve AFTER that undo's own (independently
   * scheduled) save and clobber it on the server with the stale, pre-undo
   * document — the undo would silently fail to persist.
   */
  const saveDoc = useCallback((toSave: EmailDocument) => {
    setSaveState("saving");
    void onSaveRef
      .current(toSave)
      .then(() => {
        lastSavedRef.current = toSave;
        setSaveError(null);
        const latest = historyRef.current?.present;
        if (latest !== undefined && latest !== toSave) {
          saveDoc(latest);
          return;
        }
        setSaveState("saved");
      })
      // A REJECTION here used to be swallowed by a bare `void …then(…)`,
      // leaving the indicator stuck on "Saving…" forever with no clue why.
      // That mattered little when every block was valid the moment it was
      // added; with the composed blocks it's routinely reachable — a card
      // with a button label and not yet a link is `INVALID_DOC` until the
      // pair completes — so the reason is now shown, in the validator's own
      // words. `lastSavedRef` is deliberately NOT advanced, so the next
      // edit retries and a transient invalid state heals itself.
      .catch((err: unknown) => {
        setSaveError(errorMessage(err));
        setSaveState("error");
      });
  }, []);

  // Debounced autosave: fires whenever `history.present` changes to a
  // reference that isn't the last-saved one (undo/redo land back on an
  // earlier snapshot's exact reference, so returning to an already-saved
  // state correctly skips a redundant save).
  useEffect(() => {
    if (!editable || history === null) return;
    if (history.present === lastSavedRef.current) {
      // Nothing to save — but landing back HERE is exactly how a failed save
      // gets undone: half a button typed, "Not saved — ctaLabel and ctaUrl
      // must be set together", Cmd+Z. The editor and the server now agree,
      // so leaving the error up accuses the designer of an unsaved change
      // she has already backed out, with no edit left that would clear it.
      // Only `error` is rewritten: `idle` (freshly loaded, never saved) and
      // `saving` (a save still in flight for a doc this one supersedes) are
      // both still true.
      setSaveState((s) => (s === "error" ? "saved" : s));
      setSaveError(null);
      return;
    }
    const timer = setTimeout(() => saveDoc(history.present), AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [history, editable, saveDoc]);

  const applyDoc = useCallback((next: EmailDocument) => {
    setHistory((h) => (h ? pushHistory(h, next) : h));
  }, []);

  const handleAdd = useCallback(
    (kind: EmailBlockKind) => {
      if (!history) return;
      const { doc: next, id: newId } = insertBlock(history.present, kind, selectedId);
      applyDoc(next);
      setSelectedId(newId);
      setEditing(null);
    },
    [history, selectedId, applyDoc],
  );

  const handleUpdate = useCallback(
    (blockId: string, patch: Record<string, unknown>) => {
      if (!history) return;
      applyDoc(updateBlock(history.present, blockId, patch));
    },
    [history, applyDoc],
  );

  const handleDuplicate = useCallback(
    (blockId: string) => {
      if (!history) return;
      const { doc: next, id: newId } = duplicateBlock(history.present, blockId);
      applyDoc(next);
      if (newId) setSelectedId(newId);
      setEditing(null);
    },
    [history, applyDoc],
  );

  const handleDelete = useCallback(
    (blockId: string) => {
      if (!history) return;
      const ids = history.present.blocks.map((b) => b.id);
      applyDoc(removeBlock(history.present, blockId));
      // The block below takes the selection, so deleting three in a row is
      // three clicks rather than three clicks plus three re-selections.
      setSelectedId((cur) => (cur === blockId ? selectionAfterDelete(ids, blockId) : cur));
      setEditing(null);
    },
    [history, applyDoc],
  );

  /**
   * Deleting is the one action that destroys work, and on the canvas it sits
   * a few pixels from Duplicate. Undo recovers it on web; on a phone there is
   * no keyboard shortcut and the Undo button may be scrolled away.
   */
  const confirmDelete = useCallback(
    (blockId: string) => {
      confirmAction({
        title: "Delete this block?",
        message: "Its content goes with it. You can undo straight afterwards.",
        confirmLabel: "Delete block",
        destructive: true,
        onConfirm: () => handleDelete(blockId),
      });
    },
    [handleDelete],
  );

  /**
   * Move a block one place up or down.
   *
   * The up/down arrows are the reorder control on every surface — the block's
   * own toolbar and the inspector's header. They exist because dragging a
   * fifteen-block newsletter on a phone was a long-press-and-scroll fight, and
   * nothing about a canvas changes that. `moveBlock` returns the same doc
   * reference at either end of the stack, and `pushHistory` is skipped on a
   * no-op, so a bumped-into-the-ceiling tap costs neither a history step nor a
   * save.
   */
  const handleMove = useCallback(
    (blockId: string, delta: -1 | 1) => {
      if (!history) return;
      const next = moveBlock(history.present, blockId, delta);
      if (next === history.present) return;
      applyDoc(next);
      setSelectedId(blockId);
    },
    [history, applyDoc],
  );

  const onApplyThemeRef = useRef(onApplyTheme);
  onApplyThemeRef.current = onApplyTheme;

  /** See `onApplyTheme`'s doc for why the result has to be folded back into
   *  the local history rather than left to the server. */
  const applyTheme = useCallback(async (choice: ThemeChoice): Promise<boolean> => {
    const apply = onApplyThemeRef.current;
    if (!apply) return false;
    const theme = await apply(choice);
    if (!theme) return false;
    setHistory((h) => (h ? pushHistory(h, { ...h.present, theme }) : h));
    return true;
  }, []);

  /**
   * Undo/redo, and the SELECTION that has to move with them.
   *
   * Neither history step knows about selection, so undoing the insert of a
   * block used to leave `selectedId` pointing at a block that no longer
   * exists — nothing on screen was ringed, the inspector was empty, and the
   * next ArrowDown jumped to the first block of the document rather than
   * stepping from where the designer was. A selection that has been undone
   * away is dropped, and any in-place edit with it.
   */
  const stepHistory = useCallback(
    (step: (h: History<EmailDocument>) => History<EmailDocument>) => {
      // Read through the ref rather than updating inside `setHistory`: the
      // selection has to move in the same commit, and a state updater that
      // calls other setters is one React is free to run twice.
      const current = historyRef.current;
      if (current === null) return;
      const next = step(current);
      if (next === current) return;
      const ids = next.present.blocks.map((b) => b.id);
      setHistory(next);
      setSelectedId((cur) => selectionAfterHistoryChange(ids, cur));
      setEditing(null);
    },
    [],
  );

  const handleUndo = useCallback(() => stepHistory(undoHistory), [stepHistory]);
  const handleRedo = useCallback(() => stepHistory(redoHistory), [stepHistory]);

  const blockIds = useMemo(() => doc.blocks.map((b) => b.id), [doc]);
  const warnings = useMemo(() => documentWarnings(doc), [doc]);
  const theme = useMemo(() => canvasTheme(doc), [doc]);
  const selectedBlock = doc.blocks.find((b) => b.id === selectedId) ?? null;

  // Keyboard: undo/redo as before, plus canvas selection. Web only (mirrors
  // SiteMapEditor); a phone has no keyboard to serve here.
  //
  // Two guards, and both of them are load-bearing:
  //
  //  1. EVERY branch bails wherever the user is typing — not just in an
  //     `<input>`, but in any contenteditable editor, which is what the
  //     inspector's CodeMirror markdown box actually is. Backspace in a body
  //     you are writing must be a backspace, never "delete this block", which
  //     is the single most destructive way to get a canvas shortcut wrong.
  //  2. The CANVAS's keys are claimed only for events that came from inside
  //     the canvas. The listener has to be on `document` because undo/redo
  //     belongs to the whole editor, but a window-wide `preventDefault()` on
  //     ArrowUp/ArrowDown is a screen that has stopped scrolling by keyboard.
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const intent = composerKeyIntent(
        // Field by field: a DOM event's `metaKey`/`altKey` live on its
        // prototype, so spreading one hands over an object with none of them.
        {
          key: e.key,
          altKey: e.altKey,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          target,
        },
        {
          editable,
          insideCanvas: keyEventIsInsideCanvas(
            canvasRef.current as unknown as HTMLElement | null,
            target,
          ),
        },
      );
      if (intent.kind === "ignore") return;

      // Anything the composer claims, it claims WHOLE — including a shortcut
      // that turns out to have nothing to act on. Returning before this on an
      // empty selection is how Cmd+D used to open the bookmark dialog.
      e.preventDefault();
      if (intent.kind === "undo") return handleUndo();
      if (intent.kind === "redo") return handleRedo();

      const { action } = intent;
      if (action === "deselect") {
        setSelectedId(null);
        setEditing(null);
        return;
      }
      if (action === "select-prev" || action === "select-next") {
        setSelectedId((cur) => stepSelection(blockIds, cur, action === "select-prev" ? -1 : 1));
        return;
      }
      if (selectedId === null) return;
      if (action === "move-up") handleMove(selectedId, -1);
      else if (action === "move-down") handleMove(selectedId, 1);
      else if (action === "duplicate") handleDuplicate(selectedId);
      else if (action === "delete") confirmDelete(selectedId);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    handleUndo,
    handleRedo,
    handleMove,
    handleDuplicate,
    confirmDelete,
    blockIds,
    selectedId,
    editable,
  ]);

  const previewHtml = useMemo(
    () =>
      renderCampaignEmail(doc, {
        recipient: PREVIEW_RECIPIENT,
        unsubscribeUrl: "#",
        // orgAddress isn't exposed to the client yet (only
        // `integrationSettings.readCampaignsMailSettings`, an internalQuery) —
        // the live preview omits the footer address line until a public
        // reader lands; the real send still includes it.
      }),
    [doc],
  );

  if (history === null) return null;

  const editorColumn = (
    <View className={split ? "flex-1" : undefined}>
      <View className="mb-3 flex-row items-center justify-between gap-2">
        <View className="flex-row items-center gap-2">
          <Button
            title="Undo"
            variant="secondary"
            size="sm"
            icon="corner-up-left"
            onPress={handleUndo}
            disabled={!editable || !canUndo(history)}
          />
          <Button
            title="Redo"
            variant="secondary"
            size="sm"
            icon="corner-up-right"
            onPress={handleRedo}
            disabled={!editable || !canRedo(history)}
          />
          {/* The document-level half of the warnings answer: one line, and a
              way to jump to the first block that is stopping the save. */}
          {editable && warnings.blockingBlockIds.length > 0 ? (
            <Pressable
              onPress={() => {
                setSelectedId(warnings.blockingBlockIds[0]);
                setEditing(null);
              }}
              accessibilityRole="button"
              accessibilityLabel="Show the first block blocking this email from saving"
              className="flex-row items-center gap-1.5 rounded-md border border-danger bg-danger-bg px-2 py-1"
            >
              <Icon name="alert-triangle" size={12} color={colors.danger} />
              <Text className="text-2xs font-semibold text-danger">
                {warnings.blockingBlockIds.length === 1
                  ? "1 block can't save"
                  : `${warnings.blockingBlockIds.length} blocks can't save`}
              </Text>
            </Pressable>
          ) : null}
        </View>
        <SaveIndicator editable={editable} saveState={saveState} error={saveError} />
      </View>

      {!editable ? (
        lockedNotice ? (
          <Text className="mb-3 text-xs text-muted">{lockedNotice}</Text>
        ) : null
      ) : (
        <View className="mb-4">
          <BlockPalette onAdd={handleAdd} />
        </View>
      )}

      {doc.blocks.length === 0 ? (
        <View className="items-center rounded-lg border border-dashed border-border bg-raised px-6 py-14">
          <Icon name="mail" size={22} color={colors.faint} />
          <Text className="mt-2 text-sm text-muted">
            {editable ? emptyMessage : lockedEmptyMessage}
          </Text>
        </View>
      ) : (
        <View
          ref={canvasRef}
          // Focusable by CLICK but not by Tab. Scoping the canvas's shortcuts
          // to its own subtree only helps if clicking the canvas actually puts
          // focus inside it; a block's `Pressable` does that, but the page
          // around the document doesn't, and browsers differ on which elements
          // take focus from a mouse. `-1` makes the answer the same
          // everywhere without adding a stop to the tab order. No focus ring
          // follows: UA styles paint one on `:focus-visible`, which a click
          // isn't.
          tabIndex={-1}
          onLayout={(e) => setCanvasWidth(e.nativeEvent.layout.width)}
        >
          <EmailCanvas
            doc={doc}
            theme={theme}
            editable={editable}
            availableWidth={canvasWidth}
            selectedId={editable ? selectedId : null}
            onSelect={setSelectedId}
            editing={editing}
            onEditingChange={setEditing}
            onChange={handleUpdate}
            onDuplicate={handleDuplicate}
            onDelete={confirmDelete}
            onMove={handleMove}
            warningsByBlockId={editable ? warnings.byBlockId : {}}
          />
        </View>
      )}
    </View>
  );

  const sideColumn = (
    <View className={split ? "ml-4 w-[380px]" : "mt-6"}>
      {/* The inspector sits ABOVE the preview: it is the thing you reach for
          after every click on the canvas, and the preview is the thing you
          glance at. */}
      {editable ? (
        <View className="mb-4">
          <BlockInspector
            block={selectedBlock}
            warnings={selectedId ? (warnings.byBlockId[selectedId] ?? []) : []}
            onChange={(patch) => {
              if (selectedId) handleUpdate(selectedId, patch);
            }}
            onDuplicate={() => {
              if (selectedId) handleDuplicate(selectedId);
            }}
            onDelete={() => {
              if (selectedId) confirmDelete(selectedId);
            }}
            onMove={(delta) => {
              if (selectedId) handleMove(selectedId, delta);
            }}
            canMoveUp={canMoveBlock(blockIds, selectedId, -1)}
            canMoveDown={canMoveBlock(blockIds, selectedId, 1)}
            uploadImage={uploadImage}
            run={run}
          />
        </View>
      ) : null}

      {/* Above the preview, not below it: the theme is the thing the preview
          is FOR, and a picker under a 620px pane is a picker nobody finds. */}
      {editable && onApplyTheme ? (
        <View className="mb-3">
          <CampaignThemePicker currentThemeName={doc.theme?.name} onApply={applyTheme} />
        </View>
      ) : null}
      <Text className="mb-2 text-xs font-bold uppercase tracking-wider text-faint">
        Live preview
      </Text>
      {/* The sandboxed iframe/WebView, unchanged — the canvas is a faithful
          second renderer, and this stays on screen as the arbiter of what a
          real mail client will do with the document. */}
      <EmailHtmlPreview html={previewHtml} height={split ? 620 : 420} />
      <View className="mt-4">
        <MergeTagRow />
      </View>
    </View>
  );

  return (
    // `ReadOnlyProvider` wraps BOTH columns: every designer control below opts
    // into the lock by construction rather than by remembering a prop, which
    // is the whole reason it is context (see `DesignerControls.tsx`).
    <ReadOnlyProvider value={!editable}>
      {split ? (
        <View className="flex-row">
          {editorColumn}
          {sideColumn}
        </View>
      ) : (
        <View>
          {editorColumn}
          {sideColumn}
        </View>
      )}
    </ReadOnlyProvider>
  );
}

/**
 * The autosave state, and — when a save is refused — WHY, in the labels this
 * screen actually shows.
 *
 * The reason used to be the validator's own words (`blocks[3]: card:
 * "ctaLabel" and "ctaUrl" must be set together`), which names fields from the
 * document contract rather than anything on screen: there is no "ctaLabel"
 * here, there's a "Button label". `explainDocError` maps the gate's messages
 * onto the composer's vocabulary and keeps the raw string behind "Details",
 * so the original is still one tap away when someone needs to grep the
 * validator for it.
 */
function SaveIndicator({
  editable,
  saveState,
  error,
}: {
  editable: boolean;
  saveState: SaveState;
  error: string | null;
}) {
  const [showRaw, setShowRaw] = useState(false);

  if (!editable) return null;
  if (saveState === "saving") {
    return <Text className="text-xs text-muted">Saving…</Text>;
  }
  if (saveState === "saved") {
    return <Text className="text-xs text-success">Saved</Text>;
  }
  if (saveState === "error") {
    const explained = error === null ? null : explainDocError(error);
    return (
      <View className="max-w-[340px] items-end">
        <Text className="text-right text-xs text-danger">
          Not saved — {explained?.message ?? "something went wrong."}
        </Text>
        {explained && explained.recognized ? (
          <>
            <Pressable
              onPress={() => setShowRaw((s) => !s)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={
                showRaw ? "Hide the technical reason" : "Show the technical reason"
              }
            >
              <Text className="mt-0.5 text-2xs text-muted underline">
                {showRaw ? "Hide details" : "Details"}
              </Text>
            </Pressable>
            {showRaw ? (
              <Text className="mt-0.5 text-right text-2xs text-faint">{explained.raw}</Text>
            ) : null}
          </>
        ) : null}
      </View>
    );
  }
  return null;
}
