/**
 * DOCUMENT COMPOSER — the block-based email editor, in one place.
 *
 * This is the whole editing surface that used to live inline in
 * `app/(app)/campaign/[id]/design.tsx`: the undo/redo history, the debounced
 * autosave and its indicator, the block stack with its palette, the live HTML
 * preview, the merge-tag row, and the theme picker above the preview. It was
 * lifted out — behaviour unchanged — the moment a SECOND document became
 * editable (`app/(app)/campaign-template/[id].tsx`, the template editor).
 * Everything a designer knows about composing an email therefore holds in both
 * places by construction rather than by two files agreeing to stay in step.
 *
 * The screens keep what is genuinely theirs: the access gate, the record's own
 * header, and — crucially — WHAT SAVING MEANS. A campaign autosaves through
 * `campaigns.updateCampaignDoc`, a template through
 * `campaignTemplates.updateTemplate`; this component only knows it has an
 * `onSave` that resolves or rejects.
 *
 * ── Editing model (unchanged from the campaign designer) ────────────────────
 * Local `EmailDocument` state wrapped in a linear undo/redo history
 * (`lib/emailDesigner.ts`'s `History<EmailDocument>` — a snapshot zipper),
 * debounce-autosaved 600ms after the last edit. Cmd/Ctrl+Z / +Shift+Z
 * undo/redo on web, mirroring `SiteMapEditor`'s keyboard-shortcut precedent.
 *
 * ── Read-only means it ─────────────────────────────────────────────────────
 * When `editable` is false the block cards render with `readOnly`, which makes
 * every field static and removes every add/remove/upload control, instead of
 * the no-op handlers that used to let someone type into a locked document and
 * lose the words on reload. The two callers arrive there for different
 * reasons — a campaign past `draft`/`changes_requested`, or a viewer without
 * `campaigns.design` power on a template — so the explanatory line is theirs
 * to supply (`lockedNotice`).
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
  reorderBlocks,
  undoHistory,
  updateBlock,
  type History,
} from "../../../lib/emailDesigner";
import { SortableRows } from "../../grid/SortableRows";
import { BlockCard } from "./BlockCard";
import { BlockPalette } from "./BlockPalette";
import { MergeTagRow } from "./MergeTagRow";
import { CampaignThemePicker, type ThemeChoice } from "./CampaignThemePicker";
import EmailHtmlPreview from "../../email/EmailHtmlPreview";
import { useDesignerImageUploader } from "./useImageUploader";

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
  /** False renders the whole stack locked (see the module doc). */
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
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
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
    },
    [history, applyDoc],
  );

  const handleDelete = useCallback(
    (blockId: string) => {
      if (!history) return;
      applyDoc(removeBlock(history.present, blockId));
      setSelectedId((cur) => (cur === blockId ? null : cur));
    },
    [history, applyDoc],
  );

  const handleReorder = useCallback(
    (orderedIds: string[]) => {
      if (!history) return;
      applyDoc(reorderBlocks(history.present, orderedIds));
    },
    [history, applyDoc],
  );

  /**
   * Move a block one place up or down.
   *
   * The drag handle was the ONLY way to reorder, which needs a pointer and a
   * 15px grip; on a phone, reordering a fifteen-block newsletter was a
   * long-press-and-scroll fight. `moveBlock` returns the same doc reference at
   * either end of the stack, and `pushHistory` is skipped on a no-op, so a
   * bumped-into-the-ceiling tap costs neither a history step nor a save.
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

  const handleUndo = useCallback(() => setHistory((h) => (h ? undoHistory(h) : h)), []);
  const handleRedo = useCallback(() => setHistory((h) => (h ? redoHistory(h) : h)), []);

  // Cmd/Ctrl+Z undo, Cmd/Ctrl+Shift+Z redo — web only (mirrors SiteMapEditor).
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      if (e.shiftKey) handleRedo();
      else handleUndo();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [handleUndo, handleRedo]);

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

  const blockIds = doc.blocks.map((b) => b.id);

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
      ) : editable ? (
        <SortableRows
          ids={blockIds}
          onReorder={handleReorder}
          renderRow={({ id: blockId, drag }) => {
            const index = doc.blocks.findIndex((b) => b.id === blockId);
            const block = index < 0 ? undefined : doc.blocks[index];
            if (!block) return null;
            return (
              <BlockCard
                block={block}
                selected={selectedId === blockId}
                onSelect={() => setSelectedId(blockId)}
                onChange={(patch) => handleUpdate(blockId, patch)}
                onDuplicate={() => handleDuplicate(blockId)}
                onDelete={() => handleDelete(blockId)}
                onMoveUp={() => handleMove(blockId, -1)}
                onMoveDown={() => handleMove(blockId, 1)}
                canMoveUp={index > 0}
                canMoveDown={index < doc.blocks.length - 1}
                drag={drag}
                uploadImage={uploadImage}
                run={run}
              />
            );
          }}
        />
      ) : (
        // Every write is refused for this caller (a submitted campaign, a
        // template someone lacks design power on), so the cards render
        // LOCKED — visibly static fields rather than live-looking ones wired
        // to no-op handlers, which is what used to let a reviewer type into a
        // submitted campaign and watch the words vanish on reload.
        doc.blocks.map((block) => (
          <BlockCard
            key={block.id}
            block={block}
            selected={false}
            readOnly
            onSelect={() => {}}
            onChange={() => {}}
            onDuplicate={() => {}}
            onDelete={() => {}}
          />
        ))
      )}
    </View>
  );

  const previewColumn = (
    <View className={split ? "ml-4 w-[380px]" : "mt-6"}>
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
      <EmailHtmlPreview html={previewHtml} height={split ? 620 : 420} />
      <View className="mt-4">
        <MergeTagRow />
      </View>
    </View>
  );

  return split ? (
    <View className="flex-row">
      {editorColumn}
      {previewColumn}
    </View>
  ) : (
    <View>
      {editorColumn}
      {previewColumn}
    </View>
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
