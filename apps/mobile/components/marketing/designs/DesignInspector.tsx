/**
 * MARKETING · Designs — one design file, opened.
 *
 * This is the viewer the founder said was missing: the LIVE Canva or Figma
 * document, full panel width, with "Open in Canva" one tap away. The grid it
 * opened from drew a stored thumbnail — so the live frame in here is the only
 * one on the page, which is what makes a library of forty files load at all.
 *
 * ── Filing is a control, not a drag — and it is now a checklist ─────────────
 * The approved mockup files a design by dragging its tile onto a folder in the
 * rail. That is a mouse. This app is one file serving phone, tablet and web, so
 * filing lives here instead — one press, identical on every platform, and
 * reachable by a screen reader.
 *
 * It is a CHECKLIST rather than a picker because a design can be in several
 * folders at once now: the Easter poster is in "Flyers" and in "Easter 2026",
 * and neither membership costs the other anything. Ticks save instantly through
 * `setItemFolders` (which touches nothing but the filing, precisely so it
 * cannot overwrite a title somebody edited in another tab) rather than waiting
 * for Save, because filing twenty loose designs is the actual job and opening a
 * form per file is the friction that stops people doing it.
 *
 * ── The rest of the form is unchanged from the tab it replaces ──────────────
 * Three-state images (pending / cleared / untouched), `folderIds` sent only at
 * birth, optional text omitted when empty. Those rules are the backend's
 * (`upsertDesign`'s keep-if-not-resent doc), and every one of them has an
 * incident behind it.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { useAction, useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  DESIGN_KINDS,
  DESIGN_KIND_LABELS,
  DESIGN_NOTES_MAX,
  DESIGN_TITLE_MAX,
  DESIGN_URL_MAX,
  designEmbedUrl,
  isAllowedDesignUrl,
  type BrandColor,
  type DesignAsset,
  type DesignFolder,
  type DesignKind,
} from "@events-os/shared";
import { Button, CopyButton, Select, TextField } from "../../ui";
import { FolderChecklist } from "./FolderChecklist";
import type { ActionRunner } from "../../../lib/useActionToast";
import { DesignEmbed } from "../DesignEmbed";
import { Inspector, ReorderControls } from "./Inspector";
import { DesignFilePicker } from "./DesignFilePicker";
import { asId, neighbourFor, swappedIds } from "./ids";
import { designPreview, folderOptions } from "./library.shared";

const KIND_OPTIONS = DESIGN_KINDS.map((kind) => ({
  value: kind,
  label: DESIGN_KIND_LABELS[kind],
}));

/**
 * A blank design's fields.
 *
 * IMAGES ARE THREE-STATE, the same rule `LinksView`'s `EMPTY_DRAFT` writes down
 * and for the same reason:
 *
 *   `pending` set     a file uploaded in this session, to be saved with the row
 *   `cleared` true    remove whatever the row has
 *   neither           leave it alone
 *
 * The third state is the one that needs a name: the form never holds the bytes
 * of an already-saved upload, so "not sent" has to mean KEEP. `upsertDesign`'s
 * `clearImage` / `clearThumbnail` flags are the backend half of the same rule.
 * Flattening this to two states is how the first cut of the Links screen
 * deleted a logo on a rename.
 */
const EMPTY = {
  kind: "canva" as DesignKind,
  title: "",
  /** "" is Unfiled — `Select` deals in strings, and null isn't one. */
  folderId: "",
  url: "",
  notes: "",
  imagePending: null as string | null,
  imageCleared: false,
  thumbPending: null as string | null,
  thumbCleared: false,
};

export function DesignInspector({
  design,
  designs,
  folders,
  palette,
  /** The shelf's designs, for "move earlier / later" within what you can see. */
  group,
  /** Which shelf a new design lands on, as a folder id or "". */
  seedFolderIds,
  canEdit,
  run,
  onClose,
}: {
  design: DesignAsset | null;
  designs: DesignAsset[];
  folders: DesignFolder[];
  palette: BrandColor[];
  group: DesignAsset[];
  /** Folders a NEW design starts in — the one it was added from. */
  seedFolderIds: string[];
  canEdit: boolean;
  run: ActionRunner["run"];
  onClose: () => void;
}) {
  const upsertDesign = useMutation(api.marketingDesigns.upsertDesign);
  const deleteDesign = useMutation(api.marketingDesigns.deleteDesign);
  const reorderDesigns = useMutation(api.marketingDesigns.reorderDesigns);
  const setItemFolders = useMutation(api.marketingDesigns.setItemFolders);
  const refreshCover = useAction(api.marketingDesigns.refreshCover);
  const [refreshingCover, setRefreshingCover] = useState(false);

  const [draft, setDraft] = useState(
    design
      ? {
          ...EMPTY,
          kind: design.kind,
          title: design.title,
          url: design.url ?? "",
          notes: design.notes ?? "",
        }
      : EMPTY,
  );
  const [folderIds, setFolderIds] = useState<string[]>(
    design ? design.folderIds : seedFolderIds,
  );

  /** A new design files on save; an existing one files on the tick. */
  function file(next: string[]) {
    setFolderIds(next);
    if (!design) return;
    void run(
      () =>
        setItemFolders({
          kind: "design",
          itemId: design.id,
          folderIds: next.map(asId),
        }),
      { errorTitle: "Couldn't file that design" },
    );
  }

  const url = draft.url.trim();
  const urlOk = url.length === 0 || isAllowedDesignUrl(url);
  const hasArtwork = Boolean(
    draft.imagePending || (!draft.imageCleared && design?.imageUrl),
  );
  // An `image` design can be nothing but an upload; every other kind is a
  // pointer at something, so a URL is the whole row.
  const needsUrl = draft.kind !== "image";
  const usable =
    Boolean(draft.title.trim()) &&
    urlOk &&
    (needsUrl ? url.length > 0 : url.length > 0 || hasArtwork);
  // Computed with the SAME shared function the server runs, so what this says
  // about a link is what the library will actually do with it.
  const willEmbed = Boolean(designEmbedUrl(url));

  function save() {
    void run(
      () =>
        upsertDesign({
          ...(design ? { designId: asId(design.id) } : {}),
          kind: draft.kind,
          title: draft.title.trim(),
          // Sent only at birth. An open panel holds the folders the design had
          // when it was opened, so re-sending them would undo a filing made
          // from the checklist while the form sat there.
          ...(design ? {} : { folderIds: folderIds.map(asId) }),
          ...(url ? { url } : {}),
          ...(draft.notes.trim() ? { notes: draft.notes.trim() } : {}),
          // Sent only when the marketer actually touched the slot — see
          // `EMPTY`'s three-state note.
          ...(draft.imagePending ? { imageStorage: asId(draft.imagePending) } : {}),
          ...(draft.imageCleared ? { clearImage: true } : {}),
          ...(draft.thumbPending
            ? { thumbnailStorage: asId(draft.thumbPending) }
            : {}),
          ...(draft.thumbCleared ? { clearThumbnail: true } : {}),
        }),
      { errorTitle: "Couldn't save that design", onSuccess: onClose },
    );
  }

  function move(delta: 1 | -1) {
    if (!design) return;
    const other = neighbourFor(group, design.id, delta);
    if (!other) return;
    void run(
      () =>
        reorderDesigns({
          designIds: swappedIds(designs, design.id, other.id).map(asId),
        }),
      { errorTitle: "Couldn't reorder" },
    );
  }

  const index = design ? group.findIndex((d) => d.id === design.id) : -1;
  const preview = design ? designPreview(design, palette) : null;

  return (
    <Inspector
      title={design ? design.title : "New design"}
      subtitle={
        design
          ? `${DESIGN_KIND_LABELS[design.kind]} · ${filedUnder(design.folderIds, folders)}`
          : "A Canva or Figma link, or an upload"
      }
      onClose={onClose}
      // A read-only caller still gets "copy the link" — copying is reading.
      // With nothing to copy and nothing to change, the footer bar is not
      // drawn at all rather than sitting there empty.
      footer={
        canEdit || design?.url ? (
          <>
            {design?.url ? <CopyButton text={design.url} label /> : null}
            {canEdit ? (
              <>
                <Button
                  title={design ? "Save" : "Add design"}
                  size="sm"
                  disabled={!usable}
                  onPress={save}
                />
                {design?.url && design.kind !== "image" ? (
                  // Re-capture the tile's picture from the design's own page —
                  // for when the art changed in Canva and the grid still shows
                  // the old cover. The automatic capture only fills a blank;
                  // this button is the explicit overwrite.
                  <Button
                    title={refreshingCover ? "Refreshing…" : "Refresh cover"}
                    size="sm"
                    variant="ghost"
                    disabled={refreshingCover}
                    onPress={() => {
                      setRefreshingCover(true);
                      void run(
                        () => refreshCover({ designId: asId(design.id) }),
                        { errorTitle: "Couldn't refresh the cover" },
                      ).finally(() => setRefreshingCover(false));
                    }}
                  />
                ) : null}
                {design ? (
                  <Button
                    title="Remove"
                    size="sm"
                    variant="ghost"
                    onPress={() =>
                      void run(
                        () => deleteDesign({ designId: asId(design.id) }),
                        {
                          errorTitle: "Couldn't delete that design",
                          onSuccess: onClose,
                        },
                      )
                    }
                  />
                ) : null}
              </>
            ) : null}
          </>
        ) : undefined
      }
    >
      {design ? (
        <View className="mb-4">
          {/* The LIVE embed — the one on the page. The grid it came from drew a
              stored thumbnail precisely so this could be the only frame. */}
          <DesignEmbed
            kind={design.kind}
            title={design.title}
            embedUrl={design.embedUrl}
            url={design.url}
            imageUrl={design.imageUrl}
            thumbnailUrl={design.thumbnailUrl}
          />
          {!design.embedUrl && !design.imageUrl && !design.thumbnailUrl ? (
            <Text className="mt-2 text-xs text-muted">
              Nothing to preview yet — this one is a link. Upload a thumbnail
              below and the grid stops showing{" "}
              {preview?.kind === "placeholder" ? `“${preview.initials}”` : "a stand-in"}{" "}
              for it.
            </Text>
          ) : null}
        </View>
      ) : null}

      {design && design.notes && !canEdit ? (
        <Text className="mb-4 text-base leading-6 text-muted">{design.notes}</Text>
      ) : null}

      {canEdit ? (
        <>
          {design && index >= 0 ? (
            <ReorderControls
              label={design.title}
              onEarlier={() => move(-1)}
              onLater={() => move(1)}
              earlierDisabled={index === 0}
              laterDisabled={index === group.length - 1}
            />
          ) : null}
          <Select
            label="What is it"
            value={draft.kind}
            options={KIND_OPTIONS}
            onChange={(kind) => setDraft({ ...draft, kind: kind as DesignKind })}
            hint="Canva and Figma files preview here in the panel. A link is anything else — Drive, Dropbox, Notion."
          />
          <TextField
            label="Title"
            value={draft.title}
            onChangeText={(title) => setDraft({ ...draft, title })}
            maxLength={DESIGN_TITLE_MAX}
            hint="What someone would search for — “Instagram post template”."
          />
          <FolderChecklist
            folders={folders}
            value={folderIds}
            onChange={file}
            hint={
              design
                ? "Saves as soon as you tick — filing is its own action, so it can never overwrite a title somebody edited in another tab."
                : "Where it lands. A design can be in more than one folder — “Flyers” and “Easter 2026” both."
            }
          />
          <TextField
            label={draft.kind === "image" ? "Link (optional)" : "Link"}
            value={draft.url}
            onChangeText={(next) => setDraft({ ...draft, url: next })}
            maxLength={DESIGN_URL_MAX}
            autoCapitalize="none"
            hint="The share or edit link from Canva or Figma — the one that stays working. Never a preview image URL from their CDN; those expire."
          />
          {url.length > 0 && !urlOk ? (
            <Text className="mb-3 text-xs text-danger">
              That isn&apos;t a link the library can store. It needs to start
              with https:// (or mailto:).
            </Text>
          ) : null}
          {url.length > 0 && urlOk ? (
            <Text className="mb-3 text-xs text-muted">
              {willEmbed
                ? "This one previews inside the app."
                : "This one won't preview inline — it'll show its thumbnail and a button that opens it."}
            </Text>
          ) : null}
          <TextField
            label="Notes"
            value={draft.notes}
            onChangeText={(notes) => setDraft({ ...draft, notes })}
            maxLength={DESIGN_NOTES_MAX}
            hint="What it's for, in a line."
          />
          {draft.kind === "image" ? (
            <DesignFilePicker
              kind="artwork"
              current={draft.imageCleared ? null : (design?.imageUrl ?? null)}
              pending={draft.imagePending}
              onPicked={(id) =>
                setDraft({ ...draft, imagePending: id, imageCleared: false })
              }
              onCleared={() =>
                setDraft({ ...draft, imagePending: null, imageCleared: true })
              }
              run={run}
            />
          ) : null}
          <DesignFilePicker
            kind="thumbnail"
            current={draft.thumbCleared ? null : (design?.thumbnailUrl ?? null)}
            pending={draft.thumbPending}
            onPicked={(id) =>
              setDraft({ ...draft, thumbPending: id, thumbCleared: false })
            }
            onCleared={() =>
              setDraft({ ...draft, thumbPending: null, thumbCleared: true })
            }
            run={run}
          />
        </>
      ) : null}

    </Inspector>
  );
}

/**
 * "Logos", "Flyers + 2 more", or "Unfiled" — the subtitle's second half.
 *
 * Names the first folder and counts the rest rather than listing all of them: a
 * subtitle is one line, and "Flyers, Easter 2026, Print, Archive" pushes the
 * kind of thing it is off the end of it. The full list is the checklist below,
 * which is also where it is changed.
 */
function filedUnder(folderIds: string[], folders: DesignFolder[]): string {
  const names = folderIds
    .map((id) => folders.find((f) => f.id === id)?.name)
    .filter((name): name is string => Boolean(name));
  if (names.length === 0) return "Unfiled";
  if (names.length === 1) return names[0];
  return `${names[0]} + ${names.length - 1} more`;
}
