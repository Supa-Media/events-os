/**
 * CAMPAIGN DESIGNER — the block-based email editor.
 *
 * Editing model: local `EmailDocument` state wrapped in a linear undo/redo
 * history (`lib/emailDesigner.ts`'s `History<EmailDocument>` — a snapshot
 * zipper, deliberately simpler than `SiteMapEditor`'s op-stack: there's no
 * free positioning here, just an ordered block stack), debounce-autosaved to
 * `campaigns.updateCampaignDoc` 600ms after the last edit. Cmd/Ctrl+Z / +Shift+Z
 * undo/redo on web, mirroring `SiteMapEditor`'s keyboard-shortcut precedent.
 *
 * Layout: a block stack (drag-reorder via `SortableRows`, the same grip-handle
 * idiom as `EditableGrid`) plus an "Add block" palette on the left/main
 * column; a live HTML preview (`EmailHtmlPreview`, rendering
 * `renderCampaignEmail` against a sample recipient) and a tap-to-copy
 * merge-tag row on the right — stacked below on narrow/native screens.
 *
 * Read-only once the campaign leaves "draft" (`updateCampaignDoc` throws
 * `NOT_DRAFT` server-side past that point — see `CampaignMetaCard`'s doc).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Text, View, useWindowDimensions } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useConvex, useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  renderCampaignEmail,
  type EmailBlockKind,
  type EmailDocument,
} from "@events-os/shared";
import { Screen, FULL_WIDTH, Button, Icon } from "../../../../components/ui";
import { colors } from "../../../../lib/theme";
import {
  canRedo,
  canUndo,
  duplicateBlock,
  initHistory,
  insertBlock,
  pushHistory,
  redoHistory,
  removeBlock,
  reorderBlocks,
  undoHistory,
  updateBlock,
  type History,
} from "../../../../lib/emailDesigner";
import { SortableRows } from "../../../../components/grid/SortableRows";
import { BlockCard } from "../../../../components/campaign/designer/BlockCard";
import { BlockPalette } from "../../../../components/campaign/designer/BlockPalette";
import { MergeTagRow } from "../../../../components/campaign/designer/MergeTagRow";
import EmailHtmlPreview from "../../../../components/email/EmailHtmlPreview";

/** Below this width the preview stacks under the editor instead of beside it. */
const SPLIT_BREAKPOINT = 960;
/** Debounce between the last edit and the autosave call. */
const AUTOSAVE_DEBOUNCE_MS = 600;

/** Sample recipient the live preview renders against — never sent anywhere. */
const PREVIEW_RECIPIENT = { name: "Ada Lovelace", email: "ada@example.com" };

export default function CampaignDesignScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const campaignId = id as Id<"campaigns">;

  const campaign = useQuery(api.campaigns.getCampaign, { campaignId });
  const updateDoc = useMutation(api.campaigns.updateCampaignDoc);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  // `storage.getUrl` is a query, not a mutation — resolved on demand via the
  // imperative Convex client (`app/(app)/doc/[id].tsx`'s upload-flow precedent),
  // not `useQuery` (which subscribes reactively, not what a one-off resolve
  // after an upload needs).
  const convex = useConvex();

  const [history, setHistory] = useState<History<EmailDocument> | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const lastSavedRef = useRef<EmailDocument | null>(null);

  const editable = campaign?.status === "draft";
  const { width } = useWindowDimensions();
  const split = width >= SPLIT_BREAKPOINT;

  // Seed history exactly once, when the campaign first loads.
  useEffect(() => {
    if (campaign && history === null) {
      setHistory(initHistory(campaign.doc as EmailDocument));
      lastSavedRef.current = campaign.doc as EmailDocument;
    }
  }, [campaign, history]);

  const emptyDoc = useMemo<EmailDocument>(() => ({ blocks: [] }), []);
  const doc = history?.present ?? emptyDoc;

  // Debounced autosave: fires whenever `history.present` changes to a
  // reference that isn't the last-saved one (undo/redo land back on an
  // earlier snapshot's exact reference, so returning to an already-saved
  // state correctly skips a redundant save).
  useEffect(() => {
    if (!editable || history === null) return;
    if (history.present === lastSavedRef.current) return;
    const timer = setTimeout(() => {
      const toSave = history.present;
      setSaveState("saving");
      void updateDoc({ campaignId, doc: toSave }).then(() => {
        lastSavedRef.current = toSave;
        setSaveState("saved");
      });
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, editable, campaignId]);

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

  // Image upload: generate-URL → POST → resolve a servable URL, the
  // `CoverPhotoPicker` / `doc/[id].tsx` precedent (the app's only prior
  // image-upload flows).
  const uploadImage = useMemo(() => {
    if (!editable) return undefined;
    return async (file: Blob, contentType: string): Promise<string> => {
      const uploadUrl = await generateUploadUrl();
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: file,
      });
      const { storageId } = await res.json();
      const url = await convex.query(api.storage.getUrl, { storageId });
      if (!url) throw new Error("Could not resolve uploaded image URL");
      return url;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable]);

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

  if (campaign === undefined || history === null) return <Screen loading />;

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
        <SaveIndicator editable={editable} saveState={saveState} />
      </View>

      {!editable ? (
        <Text className="mb-3 text-xs text-muted">
          This campaign has been sent — the design is locked.
        </Text>
      ) : (
        <View className="mb-4">
          <BlockPalette onAdd={handleAdd} />
        </View>
      )}

      {doc.blocks.length === 0 ? (
        <View className="items-center rounded-lg border border-dashed border-border bg-raised px-6 py-14">
          <Icon name="mail" size={22} color={colors.faint} />
          <Text className="mt-2 text-sm text-muted">
            Add a block above to start writing this email.
          </Text>
        </View>
      ) : editable ? (
        <SortableRows
          ids={blockIds}
          onReorder={handleReorder}
          renderRow={({ id: blockId, drag }) => {
            const block = doc.blocks.find((b) => b.id === blockId);
            if (!block) return null;
            return (
              <BlockCard
                block={block}
                selected={selectedId === blockId}
                onSelect={() => setSelectedId(blockId)}
                onChange={(patch) => handleUpdate(blockId, patch)}
                onDuplicate={() => handleDuplicate(blockId)}
                onDelete={() => handleDelete(blockId)}
                drag={drag}
                uploadImage={uploadImage}
              />
            );
          }}
        />
      ) : (
        doc.blocks.map((block) => (
          <BlockCard
            key={block.id}
            block={block}
            selected={false}
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
      <Text className="mb-2 text-xs font-bold uppercase tracking-wider text-faint">
        Live preview
      </Text>
      <EmailHtmlPreview html={previewHtml} height={split ? 620 : 420} />
      <View className="mt-4">
        <MergeTagRow />
      </View>
    </View>
  );

  return (
    <Screen maxWidth={FULL_WIDTH}>
      <View className="mb-3 flex-row items-center justify-between gap-3">
        <Text className="font-display text-lg text-ink" numberOfLines={1}>
          {campaign.name}
        </Text>
        <Button title="Done" variant="secondary" onPress={() => router.push(`/campaign/${campaignId}` as never)} />
      </View>
      {split ? (
        <View className="flex-row">
          {editorColumn}
          {previewColumn}
        </View>
      ) : (
        <View>
          {editorColumn}
          {previewColumn}
        </View>
      )}
    </Screen>
  );
}

function SaveIndicator({
  editable,
  saveState,
}: {
  editable: boolean;
  saveState: "idle" | "saving" | "saved";
}) {
  if (!editable) return null;
  if (saveState === "saving") {
    return <Text className="text-xs text-muted">Saving…</Text>;
  }
  if (saveState === "saved") {
    return <Text className="text-xs text-success">Saved</Text>;
  }
  return null;
}
