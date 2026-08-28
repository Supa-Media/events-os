/**
 * MARKETING · Designs — the brand kit and the design library.
 *
 * The tab the marketing team asked for in as many words: "their own marketing
 * hub where they can edit and create and be creative." Before this, the brand
 * lived in a pinned Slack message and a Canva account — the hex codes were in
 * one person's head, the templates were findable only by asking, and a
 * volunteer making a flyer at 11pm guessed. This screen is the answer to all
 * three questions at once: what our colors are, what to set words in, and where
 * the file for an Instagram post lives.
 *
 * ── Everyone can read it. That is the feature ───────────────────────────────
 * `marketingDesigns.library` is readable by anyone signed in and there is no
 * view power to hold. `canEdit` only decides whether the edit affordances
 * render; a volunteer with no marketing power at all gets the full library,
 * every copy button, and every "Open in Canva" — just no pencils. There is
 * deliberately NO lock screen here, unlike `SiteView`: on that screen there is
 * nothing worth reading that the public page doesn't show better, and on this
 * one the reading IS the point.
 *
 * ── Folders are the marketer's filing, one level deep ───────────────────────
 * The folders are named by the team ("this is what we use for Instagram
 * posts"), and the nesting stops at two levels — a rule this screen enforces in
 * the picker, not just in the error: the parent list only ever offers top-level
 * folders, and a folder that already has children is not offered a parent at
 * all. A tree is a filing system nobody else can navigate; a shelf is one
 * anybody can.
 *
 * Designs with no folder — and, defensively, designs pointing at a folder this
 * payload doesn't contain — land in "Unfiled" rather than vanishing. A row that
 * renders nowhere is a row people re-create.
 *
 * ── Filing is its own control, not a field in the form ──────────────────────
 * The editor picks a folder only for a design being created. Moving an existing
 * one is the card's own "Filed under" select, which saves instantly through
 * `moveDesignToFolder`. That split is the backend's ("moving is
 * `moveDesignToFolder`'s job" — `upsertDesign` keeps the folder it wasn't
 * sent), and it is also the better screen: filing twenty loose designs is the
 * actual job, and opening a whole form to change one field is the friction that
 * stops people doing it. The narrow mutation is the safe one too — a full
 * upsert from a card that has been sitting open would re-send a stale title and
 * URL over somebody else's edit.
 *
 * ── Deleting ────────────────────────────────────────────────────────────────
 * Deletes are immediate, matching the rest of the desk (`LinksView`). Deleting
 * a folder does not delete what's in it — `deleteFolder` moves those designs to
 * Unfiled and returns how many it moved, and this screen SAYS SO in a notice
 * rather than letting a marketer discover it. A folder that still contains a
 * sub-folder can't be deleted at all (the backend refuses rather than
 * cascading), so its delete control is disabled and says why instead of
 * offering an action that throws.
 *
 * Reordering is up/down buttons sending the whole new order; see
 * `BrandKitSection`'s note for why not drag.
 */
import { useState } from "react";
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
// expo-image-picker is Expo Go-safe (classified `core` in native-deps.json);
// only reached on native.
import * as ImagePicker from "expo-image-picker";
import {
  DESIGN_FOLDER_MAX_COUNT,
  DESIGN_FOLDER_NAME_MAX,
  DESIGN_KINDS,
  DESIGN_KIND_LABELS,
  DESIGN_MAX_COUNT,
  DESIGN_NOTES_MAX,
  DESIGN_TITLE_MAX,
  DESIGN_URL_MAX,
  designEmbedUrl,
  isAllowedDesignUrl,
  type DesignAsset,
  type DesignFolder,
  type DesignKind,
  type DesignLibrary,
} from "@events-os/shared";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  Narrow,
  Screen,
  SectionHeader,
  Select,
  TextField,
  ToastView,
} from "../ui";
import { colors } from "../../lib/theme";
import { useActionRunner, type ActionRunner } from "../../lib/useActionToast";
import { BrandKitSection, MoveButtons, asId, swappedIds } from "./BrandKitSection";
import { DesignEmbed } from "./DesignEmbed";

// ── The upload slot ──────────────────────────────────────────────────────────

const FILE_LABELS = {
  artwork: {
    title: "Artwork",
    help: "The finished image itself. This is what an uploaded design IS.",
  },
  thumbnail: {
    title: "Thumbnail",
    help: "The tile shown in the library, and the still shown on phones where the Canva/Figma frame can't render. Always an upload we host — a Canva CDN preview URL expires and leaves a grey box.",
  },
} as const;

/**
 * One image slot on a design — upload, preview, remove.
 *
 * The same shape as `CardImagePicker` (web file input, native
 * `expo-image-picker`, deferred save) and deliberately a separate component
 * rather than a prop on that one: it goes through
 * `marketingDesigns.generateDesignUploadUrl`, so a design upload carries the
 * design desk's power rather than the Important Links desk's. Two powers, two
 * upload URLs, two pickers.
 *
 * It does not save. It hands a `storageId` back to the form, which sends it
 * with the rest of the design — a picker that saved on its own would give one
 * design two save paths and commit half a form nobody had finished.
 */
function DesignFilePicker({
  kind,
  current,
  pending,
  onPicked,
  onCleared,
  run,
}: {
  kind: "artwork" | "thumbnail";
  /** What the design shows today, or null when the slot is empty. */
  current: string | null;
  /** A storage id chosen in this session but not yet saved. */
  pending: string | null;
  onPicked: (storageId: string) => void;
  onCleared: () => void;
  run: ActionRunner["run"];
}) {
  const generateUploadUrl = useMutation(
    api.marketingDesigns.generateDesignUploadUrl,
  );
  const [uploading, setUploading] = useState(false);
  const labels = FILE_LABELS[kind];

  async function uploadBlob(blob: Blob, contentType: string) {
    setUploading(true);
    try {
      await run(
        async () => {
          const uploadUrl = await generateUploadUrl();
          const res = await fetch(uploadUrl, {
            method: "POST",
            headers: { "Content-Type": contentType },
            body: blob,
          });
          const { storageId } = await res.json();
          onPicked(storageId as string);
        },
        { errorTitle: "Couldn't upload that image" },
      );
    } finally {
      setUploading(false);
    }
  }

  function pickWeb() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void uploadBlob(file, file.type || "image/jpeg");
    };
    input.click();
  }

  async function pickNative() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.9,
    });
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    const resp = await fetch(asset.uri);
    const blob = await resp.blob();
    await uploadBlob(blob, asset.mimeType || blob.type || "image/jpeg");
  }

  const has = Boolean(pending || current);

  return (
    <View className="mb-3">
      <Text className="mb-1 text-sm font-semibold text-ink">{labels.title}</Text>
      <Text className="mb-2 text-xs text-muted">{labels.help}</Text>
      <View className="flex-row items-center gap-3">
        {/* A just-uploaded file has no servable URL yet (the design hasn't been
            saved), so it's shown as staged rather than as a broken frame. */}
        {pending ? (
          <View className="h-14 w-14 items-center justify-center rounded-md border border-border bg-surface">
            <Text className="text-[10px] text-muted">New</Text>
          </View>
        ) : current ? (
          <Image
            source={{ uri: current }}
            className="h-14 w-14 rounded-md border border-border"
            resizeMode="contain"
          />
        ) : null}
        {uploading ? <ActivityIndicator size="small" /> : null}
        <Button
          title={has ? "Replace" : "Upload"}
          size="sm"
          variant="secondary"
          disabled={uploading}
          onPress={() => {
            if (Platform.OS === "web") pickWeb();
            else void pickNative();
          }}
        />
        {has ? (
          <Button title="Remove" size="sm" variant="ghost" onPress={onCleared} />
        ) : null}
      </View>
      {pending ? (
        <Text className="mt-1.5 text-xs text-muted">
          Uploaded — save the design to keep it.
        </Text>
      ) : null}
    </View>
  );
}

// ── Drafts ───────────────────────────────────────────────────────────────────

/**
 * A blank design's fields, so "New design" and "Cancel" have one shape to reset
 * to.
 *
 * IMAGES ARE THREE-STATE, the same rule `LinksView`'s `EMPTY_DRAFT` writes
 * down and for the same reason:
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
const EMPTY_DESIGN = {
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
type DesignDraft = typeof EMPTY_DESIGN;

function draftFrom(design: DesignAsset): DesignDraft {
  return {
    ...EMPTY_DESIGN,
    kind: design.kind,
    title: design.title,
    folderId: design.folderId ?? "",
    url: design.url ?? "",
    notes: design.notes ?? "",
  };
}

const KIND_OPTIONS = DESIGN_KINDS.map((kind) => ({
  value: kind,
  label: DESIGN_KIND_LABELS[kind],
}));

/**
 * Folder choices for a picker, flattened to `Parent / Child` labels.
 *
 * A `Select` is a flat list, so the hierarchy has to survive in the label. It
 * only has to survive one level, which is the whole argument for the one-level
 * rule.
 */
function folderOptions(folders: DesignFolder[]) {
  const options = [{ value: "", label: "Unfiled" }];
  for (const top of folders.filter((f) => f.parentId === null)) {
    options.push({ value: top.id, label: top.name });
    for (const child of folders.filter((f) => f.parentId === top.id)) {
      options.push({ value: child.id, label: `${top.name} / ${child.name}` });
    }
  }
  return options;
}

// ── The design form ──────────────────────────────────────────────────────────

/** The design editor — one form for a new design and an existing one. */
function DesignEditor({
  draft,
  setDraft,
  folders,
  design,
  onSave,
  onCancel,
  saveLabel,
  run,
}: {
  draft: DesignDraft;
  setDraft: (next: DesignDraft) => void;
  folders: DesignFolder[];
  /** The design being edited, for its current images. Absent when creating. */
  design?: DesignAsset;
  onSave: () => void;
  onCancel: () => void;
  saveLabel: string;
  run: ActionRunner["run"];
}) {
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

  return (
    <View>
      <Select
        label="What is it"
        value={draft.kind}
        options={KIND_OPTIONS}
        onChange={(kind) => setDraft({ ...draft, kind: kind as DesignKind })}
        hint="Canva and Figma files preview inside the app. A link is anything else — Drive, Dropbox, Notion."
      />
      <TextField
        label="Title"
        value={draft.title}
        onChangeText={(title) => setDraft({ ...draft, title })}
        maxLength={DESIGN_TITLE_MAX}
        hint="What someone would search for — “Instagram post template”."
      />
      {/* Only when creating. `upsertDesign` keeps a design's folder if the
          field isn't resent ("moving is `moveDesignToFolder`'s job"), so an
          editor offering "Unfiled" here would let someone pick it, save, and
          watch nothing happen. Filing an existing design is the card's own
          "Filed under" control, which stays visible while this form is open. */}
      {design ? null : (
        <Select
          label="Folder"
          value={draft.folderId}
          options={folderOptions(folders)}
          onChange={(folderId) => setDraft({ ...draft, folderId })}
        />
      )}
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
          That isn&apos;t a link the library can store. It needs to start with
          https:// (or mailto:).
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
      <View className="flex-row items-center gap-2">
        <Button
          title={saveLabel}
          size="sm"
          disabled={!usable}
          onPress={onSave}
        />
        <Button title="Cancel" size="sm" variant="ghost" onPress={onCancel} />
      </View>
    </View>
  );
}

/** The folder form — a name, and (sometimes) a parent. */
function FolderEditor({
  name,
  setName,
  parentId,
  setParentId,
  parentChoices,
  onSave,
  onCancel,
  saveLabel,
}: {
  name: string;
  setName: (next: string) => void;
  parentId: string;
  setParentId: (next: string) => void;
  /**
   * Top-level folders this one may sit under, already filtered. Empty means the
   * folder must stay top-level — either there is nowhere to put it, or it has
   * children of its own and moving it would make a third level.
   */
  parentChoices: DesignFolder[];
  onSave: () => void;
  onCancel: () => void;
  saveLabel: string;
}) {
  return (
    <View>
      <TextField
        label="Folder name"
        value={name}
        onChangeText={setName}
        maxLength={DESIGN_FOLDER_NAME_MAX}
        hint="Name it after the job — “Instagram posts”, “Event flyers”."
      />
      {parentChoices.length > 0 ? (
        <Select
          label="Sits inside"
          value={parentId}
          options={[
            { value: "", label: "Nothing — it's a top-level folder" },
            ...parentChoices.map((f) => ({ value: f.id, label: f.name })),
          ]}
          onChange={setParentId}
          hint="Folders go two levels deep at most, so only top-level folders are offered here."
        />
      ) : null}
      <View className="flex-row items-center gap-2">
        <Button
          title={saveLabel}
          size="sm"
          disabled={!name.trim()}
          onPress={onSave}
        />
        <Button title="Cancel" size="sm" variant="ghost" onPress={onCancel} />
      </View>
    </View>
  );
}

// ── The screen ───────────────────────────────────────────────────────────────

export function MarketingDesignsView() {
  // Typed through the shared contract rather than read off the generated API:
  // `DesignLibrary` is what the query is specified to return, and naming it
  // here means this screen breaks loudly at compile time if the wire shape
  // moves, instead of quietly rendering undefined fields.
  const library = useQuery(api.marketingDesigns.library, {}) as
    | DesignLibrary
    | undefined;

  const upsertFolder = useMutation(api.marketingDesigns.upsertFolder);
  const deleteFolder = useMutation(api.marketingDesigns.deleteFolder);
  const reorderFolders = useMutation(api.marketingDesigns.reorderFolders);
  const upsertDesign = useMutation(api.marketingDesigns.upsertDesign);
  const deleteDesign = useMutation(api.marketingDesigns.deleteDesign);
  const reorderDesigns = useMutation(api.marketingDesigns.reorderDesigns);
  const moveDesignToFolder = useMutation(api.marketingDesigns.moveDesignToFolder);

  const { run, toast, dismiss } = useActionRunner();

  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const [folderName, setFolderName] = useState("");
  const [folderParent, setFolderParent] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);

  const [editingDesign, setEditingDesign] = useState<string | null>(null);
  const [designDraft, setDesignDraft] = useState<DesignDraft>(EMPTY_DESIGN);
  const [newDesign, setNewDesign] = useState<DesignDraft | null>(null);

  /** A non-error outcome that still needs saying — today, where a deleted
   *  folder's designs went. `useActionRunner` only surfaces failures, and this
   *  is not one. Same pattern as `MailingListView`. */
  const [notice, setNotice] = useState<string | null>(null);

  if (library === undefined) return <Screen loading />;

  const { folders, designs, canEdit } = library;
  const knownFolderIds = new Set(folders.map((f) => f.id));
  const topFolders = folders.filter((f) => f.parentId === null);
  const childrenOf = (folderId: string) =>
    folders.filter((f) => f.parentId === folderId);
  /** Designs filed here. Null means Unfiled — and so does a folder id this
   *  payload doesn't know about, so a design orphaned by a deleted folder shows
   *  up somewhere rather than nowhere. */
  const designsIn = (folderId: string | null) =>
    designs.filter((d) =>
      folderId === null
        ? d.folderId === null || !knownFolderIds.has(d.folderId)
        : d.folderId === folderId,
    );

  function saveFolder(folderId: string | null) {
    void run(
      () =>
        upsertFolder({
          ...(folderId ? { folderId: asId(folderId) } : {}),
          name: folderName.trim(),
          // `parentId` alone can only ever MOVE a folder in — an edit that
          // omits it keeps the parent it has, which is what makes a rename
          // safe. Promoting a child back to the top level therefore needs the
          // explicit `clearParent`, the same keep-if-not-resent shape the
          // image fields use.
          ...(folderParent
            ? { parentId: asId(folderParent) }
            : folderId
              ? { clearParent: true }
              : {}),
        }),
      {
        errorTitle: "Couldn't save that folder",
        onSuccess: () => {
          setEditingFolder(null);
          setCreatingFolder(false);
          setFolderName("");
          setFolderParent("");
        },
      },
    );
  }

  function saveDesign(designId: string | null, d: DesignDraft) {
    void run(
      () =>
        upsertDesign({
          ...(designId ? { designId: asId(designId) } : {}),
          kind: d.kind,
          title: d.title.trim(),
          // Sent only at birth. An open editor holds the folder the design had
          // when it was opened, so re-sending it would undo a move made from
          // the card's "Filed under" control while the form sat there.
          ...(!designId && d.folderId ? { folderId: asId(d.folderId) } : {}),
          ...(d.url.trim() ? { url: d.url.trim() } : {}),
          ...(d.notes.trim() ? { notes: d.notes.trim() } : {}),
          // Sent only when the marketer actually touched the slot — see
          // `EMPTY_DESIGN`'s three-state note.
          ...(d.imagePending ? { imageStorage: asId(d.imagePending) } : {}),
          ...(d.imageCleared ? { clearImage: true } : {}),
          ...(d.thumbPending
            ? { thumbnailStorage: asId(d.thumbPending) }
            : {}),
          ...(d.thumbCleared ? { clearThumbnail: true } : {}),
        }),
      {
        errorTitle: "Couldn't save that design",
        onSuccess: () => {
          setEditingDesign(null);
          setNewDesign(null);
        },
      },
    );
  }

  /** Move within the visible group, but send the whole list's new order. */
  function moveDesign(group: DesignAsset[], index: number, delta: number) {
    const other = group[index + delta];
    if (!other) return;
    void run(
      () =>
        reorderDesigns({
          designIds: swappedIds(designs, group[index].id, other.id).map(asId),
        }),
      { errorTitle: "Couldn't reorder" },
    );
  }

  function moveFolder(siblings: DesignFolder[], index: number, delta: number) {
    const other = siblings[index + delta];
    if (!other) return;
    void run(
      () =>
        reorderFolders({
          folderIds: swappedIds(folders, siblings[index].id, other.id).map(asId),
        }),
      { errorTitle: "Couldn't reorder" },
    );
  }

  function startEditingFolder(folder: DesignFolder) {
    setFolderName(folder.name);
    setFolderParent(folder.parentId ?? "");
    setCreatingFolder(false);
    setEditingFolder(folder.id);
  }

  /**
   * Where a folder may be moved to: top-level folders, minus itself, and only
   * when it has no children of its own. This is the one-level rule enforced in
   * the picker rather than left to the backend's error — an option you can pick
   * and then be told off for is a worse explanation than an option that isn't
   * there.
   */
  function parentChoicesFor(folderId: string | null): DesignFolder[] {
    if (folderId && childrenOf(folderId).length > 0) return [];
    return topFolders.filter((f) => f.id !== folderId);
  }

  /** One design card: the preview, the way out to the real tool, and — for
   *  someone who can edit — filing and the row's own controls. */
  function renderDesign(group: DesignAsset[], design: DesignAsset, index: number) {
    const editing = editingDesign === design.id;
    return (
      <Card key={design.id} padding="md" className="mb-3">
        <View className="flex-row items-center gap-2">
          <View className="flex-1">
            <Text className="text-sm font-semibold text-ink" numberOfLines={1}>
              {design.title}
            </Text>
            {design.notes ? (
              <Text className="text-xs text-muted" numberOfLines={2}>
                {design.notes}
              </Text>
            ) : null}
          </View>
          <Badge label={DESIGN_KIND_LABELS[design.kind]} />
          {canEdit && !editing ? (
            <MoveButtons
              onUp={() => moveDesign(group, index, -1)}
              onDown={() => moveDesign(group, index, 1)}
              upDisabled={index === 0}
              downDisabled={index === group.length - 1}
            />
          ) : null}
        </View>

        {editing ? (
          <View className="mt-3">
            <DesignEditor
              draft={designDraft}
              setDraft={setDesignDraft}
              folders={folders}
              design={design}
              saveLabel="Save"
              run={run}
              onSave={() => saveDesign(design.id, designDraft)}
              onCancel={() => setEditingDesign(null)}
            />
          </View>
        ) : (
          <DesignEmbed
            kind={design.kind}
            title={design.title}
            embedUrl={design.embedUrl}
            url={design.url}
            imageUrl={design.imageUrl}
            thumbnailUrl={design.thumbnailUrl}
          />
        )}

        {/* Outside the editing branch on purpose: filing is its own mutation
            with its own instant save, so it stays reachable while the form is
            open — and it is the ONLY way to move an existing design, since
            `upsertDesign` keeps the folder it wasn't sent. */}
        {canEdit ? (
          <View className="mt-3">
            <Select
              label="Filed under"
              value={design.folderId ?? ""}
              options={folderOptions(folders)}
              onChange={(folderId) =>
                void run(
                  () =>
                    moveDesignToFolder({
                      designId: asId(design.id),
                      ...(folderId ? { folderId: asId(folderId) } : {}),
                    }),
                  { errorTitle: "Couldn't move that design" },
                )
              }
            />
          </View>
        ) : null}

        {canEdit && !editing ? (
          <View className="flex-row items-center gap-2">
            <Button
              title="Edit"
              size="sm"
              variant="secondary"
              onPress={() => {
                setDesignDraft(draftFrom(design));
                setEditingDesign(design.id);
              }}
            />
            <Button
              title="Delete"
              size="sm"
              variant="ghost"
              onPress={() =>
                void run(() => deleteDesign({ designId: asId(design.id) }), {
                  errorTitle: "Couldn't delete that design",
                })
              }
            />
          </View>
        ) : null}
      </Card>
    );
  }

  /** A folder's heading row — its name, its count, and its own controls. */
  function renderFolderHeader(
    siblings: DesignFolder[],
    folder: DesignFolder,
    index: number,
    depth: 0 | 1,
  ) {
    // The designs inside are not a reason to block the delete — they move to
    // Unfiled. A sub-folder is: `deleteFolder` refuses rather than cascading.
    const deletable = childrenOf(folder.id).length === 0;
    if (editingFolder === folder.id) {
      return (
        <Card padding="md" className="mb-3">
          <FolderEditor
            name={folderName}
            setName={setFolderName}
            parentId={folderParent}
            setParentId={setFolderParent}
            parentChoices={parentChoicesFor(folder.id)}
            saveLabel="Save"
            onSave={() => saveFolder(folder.id)}
            onCancel={() => setEditingFolder(null)}
          />
        </Card>
      );
    }
    return (
      <View
        className={`mb-2 flex-row items-center gap-2 ${depth === 1 ? "pl-4" : ""}`}
      >
        <Icon
          name="folder"
          size={depth === 1 ? 14 : 16}
          color={depth === 1 ? colors.faint : colors.muted}
        />
        <Text
          className={
            depth === 1
              ? "flex-1 text-sm text-ink"
              : "flex-1 text-base font-semibold text-ink"
          }
          numberOfLines={1}
        >
          {folder.name}
        </Text>
        <Text className="text-xs text-faint">
          {folder.designCount} file{folder.designCount === 1 ? "" : "s"}
        </Text>
        {canEdit ? (
          <>
            <MoveButtons
              onUp={() => moveFolder(siblings, index, -1)}
              onDown={() => moveFolder(siblings, index, 1)}
              upDisabled={index === 0}
              downDisabled={index === siblings.length - 1}
            />
            <Pressable
              onPress={() => startEditingFolder(folder)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={`Rename ${folder.name}`}
            >
              <Icon name="edit-2" size={16} color={colors.muted} />
            </Pressable>
            <Pressable
              onPress={() =>
                void run(() => deleteFolder({ folderId: asId(folder.id) }), {
                  errorTitle: "Couldn't delete that folder",
                  onSuccess: (value) => {
                    const moved = (value as { movedDesigns: number })
                      .movedDesigns;
                    if (moved > 0) {
                      setNotice(
                        `Deleted “${folder.name}”. ${moved} design${moved === 1 ? "" : "s"} moved to Unfiled — nothing was thrown away.`,
                      );
                    }
                  },
                })
              }
              disabled={!deletable}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={
                deletable
                  ? `Delete ${folder.name}`
                  : `${folder.name} has folders inside it — empty it before deleting`
              }
            >
              <Icon
                name="trash-2"
                size={16}
                color={deletable ? colors.danger : colors.faint}
              />
            </Pressable>
          </>
        ) : null}
      </View>
    );
  }

  const unfiled = designsIn(null);

  return (
    <Screen>
      <Narrow>
        <Text className="mt-2 text-sm text-muted">
          Our colors, our fonts, and every design file — open to everyone in the
          org.
          {canEdit
            ? " You can edit all of it."
            : " Copy a hex or open a design; the marketing team keeps it up to date."}
        </Text>

        {notice ? (
          <Card padding="md" className="mt-4">
            <Text className="text-sm text-ink">{notice}</Text>
            <View className="mt-2 flex-row">
              <Button
                title="Got it"
                size="sm"
                variant="ghost"
                onPress={() => setNotice(null)}
              />
            </View>
          </Card>
        ) : null}

        <BrandKitSection
          colors={library.colors}
          fonts={library.fonts}
          canEdit={canEdit}
          run={run}
        />

        <SectionHeader
          title="Design files"
          count={designs.length}
          right={
            canEdit ? (
              <View className="flex-row items-center gap-2">
                {!creatingFolder && !editingFolder ? (
                  <Button
                    title="New folder"
                    icon="folder-plus"
                    size="sm"
                    variant="ghost"
                    disabled={folders.length >= DESIGN_FOLDER_MAX_COUNT}
                    onPress={() => {
                      setFolderName("");
                      setFolderParent("");
                      setEditingFolder(null);
                      setCreatingFolder(true);
                    }}
                  />
                ) : null}
                {!newDesign ? (
                  <Button
                    title="New design"
                    icon="plus"
                    size="sm"
                    variant="secondary"
                    disabled={designs.length >= DESIGN_MAX_COUNT}
                    onPress={() => setNewDesign(EMPTY_DESIGN)}
                  />
                ) : null}
              </View>
            ) : undefined
          }
        />

        {creatingFolder ? (
          <Card padding="md" className="mb-3">
            <Text className="mb-3 text-sm font-semibold text-ink">
              New folder
            </Text>
            <FolderEditor
              name={folderName}
              setName={setFolderName}
              parentId={folderParent}
              setParentId={setFolderParent}
              parentChoices={parentChoicesFor(null)}
              saveLabel="Add folder"
              onSave={() => saveFolder(null)}
              onCancel={() => {
                setCreatingFolder(false);
                setFolderName("");
                setFolderParent("");
              }}
            />
          </Card>
        ) : null}

        {newDesign ? (
          <Card padding="md" className="mb-4">
            <Text className="mb-3 text-sm font-semibold text-ink">
              New design
            </Text>
            <DesignEditor
              draft={newDesign}
              setDraft={setNewDesign}
              folders={folders}
              saveLabel="Add design"
              run={run}
              onSave={() => saveDesign(null, newDesign)}
              onCancel={() => setNewDesign(null)}
            />
          </Card>
        ) : null}

        {designs.length === 0 && folders.length === 0 ? (
          <EmptyState
            icon="image"
            title="No design files yet"
            message={
              canEdit
                ? "Make a folder for the way you actually work — “Instagram posts”, “Event flyers” — and drop the Canva and Figma links in it."
                : "The marketing team hasn't added any yet."
            }
          />
        ) : null}

        {topFolders.map((folder, index) => (
          <View key={folder.id} className="mb-4">
            {renderFolderHeader(topFolders, folder, index, 0)}
            {designsIn(folder.id).map((design, i, group) =>
              renderDesign(group, design, i),
            )}
            {childrenOf(folder.id).map((child, childIndex, siblings) => (
              <View key={child.id} className="mb-2">
                {renderFolderHeader(siblings, child, childIndex, 1)}
                <View className="pl-4">
                  {designsIn(child.id).map((design, i, group) =>
                    renderDesign(group, design, i),
                  )}
                </View>
              </View>
            ))}
          </View>
        ))}

        {unfiled.length > 0 ? (
          <View className="mb-6">
            <View className="mb-2 flex-row items-center gap-2">
              <Icon name="inbox" size={16} color={colors.muted} />
              <Text className="flex-1 text-base font-semibold text-ink">
                Unfiled
              </Text>
              <Text className="text-xs text-faint">
                {unfiled.length} file{unfiled.length === 1 ? "" : "s"}
              </Text>
            </View>
            {unfiled.map((design, i, group) => renderDesign(group, design, i))}
          </View>
        ) : null}
      </Narrow>
      <ToastView toast={toast} onDismiss={dismiss} />
    </Screen>
  );
}
