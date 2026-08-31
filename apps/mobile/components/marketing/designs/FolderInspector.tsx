/**
 * MARKETING · Designs — one folder, opened.
 *
 * Renaming, re-parenting, reordering, PINNING and deleting a folder, in the
 * same panel everything else is edited in. The rail stays a rail: no pencil, no
 * bin, no chevrons beside a folder's name.
 *
 * ── Pinning is the "give it its own section" switch ─────────────────────────
 * A pinned folder draws itself, contents and all, as a section on the tab
 * instead of waiting to be selected. That is the whole of the feature, and it
 * lives on the ordinary folder form because a pinned folder is an ordinary
 * folder — "Colors" and "Faces" are two of them, seeded by migration `0085`,
 * and can be unpinned here like any other.
 *
 * It saves on the switch through `setFolderPinned` rather than on Save, for the
 * same reason filing does: a person flipping a switch has not asked to commit
 * whatever else is half-typed in the form.
 *
 * ── Two rules the backend has and this panel makes visible ──────────────────
 *  1. `parentId` is KEEP-IF-NOT-RESENT, so promoting a child back to the top
 *     level is the explicit `clearParent` flag. Getting that wrong means a
 *     rename silently re-files a shelf and everything on it.
 *  2. Deleting a folder does NOT delete what's in it — `deleteFolder` moves
 *     those designs to Unfiled and returns how many it moved. This says so
 *     BEFORE the press, and the caller reports the number after, rather than
 *     letting a marketer discover it. A folder that still contains a
 *     sub-folder can't be deleted at all (the backend refuses rather than
 *     cascading), so the control is disabled and says why instead of offering
 *     an action that throws.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import {
  DESIGN_FOLDER_NAME_MAX,
  type DesignFolder,
} from "@events-os/shared";
import { Button, Select, Switch, TextField } from "../../ui";
import type { ActionRunner } from "../../../lib/useActionToast";
import { Inspector, ReorderControls } from "./Inspector";
import { asId, neighbourFor, swappedIds } from "./ids";
import { parentChoicesFor } from "./library.shared";

/** A labelled switch shaped like the panel's other fields, so pinning sits in
 *  the form rather than beside it. */
function SwitchRow({
  label,
  value,
  onValueChange,
  hint,
}: {
  label: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  hint: string;
}) {
  return (
    <View className="mb-4">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="text-xs font-semibold uppercase tracking-wide text-muted">
          {label}
        </Text>
        <Switch
          value={value}
          onValueChange={onValueChange}
          accessibilityLabel={label}
        />
      </View>
      <Text className="mt-1 text-xs leading-4 text-faint">{hint}</Text>
    </View>
  );
}

export function FolderInspector({
  folder,
  folders,
  itemCount,
  run,
  onClose,
  onDeleted,
}: {
  folder: DesignFolder | null;
  folders: DesignFolder[];
  /** How many things of any kind are in it right now — what a delete would
   *  release. */
  itemCount: number;
  run: ActionRunner["run"];
  onClose: () => void;
  /** Told how many items the delete released, so the screen can say so where
   *  the folder used to be. */
  onDeleted: (folderName: string, releasedItems: number) => void;
}) {
  const upsertFolder = useMutation(api.marketingDesigns.upsertFolder);
  const deleteFolder = useMutation(api.marketingDesigns.deleteFolder);
  const reorderFolders = useMutation(api.marketingDesigns.reorderFolders);
  const setFolderPinned = useMutation(api.marketingDesigns.setFolderPinned);

  const [name, setName] = useState(folder?.name ?? "");
  const [parentId, setParentId] = useState(folder?.parentId ?? "");
  /** Local so the switch moves at once; the write follows immediately, and a
   *  failed one is reported by `run` with the switch left where the person put
   *  it rather than snapping back under their finger. */
  const [pinned, setPinned] = useState(folder?.pinned ?? false);

  const parentChoices = parentChoicesFor(folders, folder?.id ?? null);
  const hasChildren = folders.some((f) => f.parentId === folder?.id);
  // Siblings, because reordering is per level: a child moving "earlier" moves
  // within its parent, not past its parent.
  const siblings = folders.filter((f) => f.parentId === (folder?.parentId ?? null));
  const index = folder ? siblings.findIndex((f) => f.id === folder.id) : -1;

  function save() {
    void run(
      () =>
        upsertFolder({
          ...(folder ? { folderId: asId(folder.id) } : {}),
          name: name.trim(),
          // A NEW folder carries the switch's state; an existing one has
          // already saved it through `setFolderPinned`.
          ...(folder ? {} : { pinned }),
          // `parentId` alone can only ever MOVE a folder in — an edit that
          // omits it keeps the parent it has, which is what makes a rename
          // safe. Promoting a child back to the top level therefore needs the
          // explicit `clearParent`.
          ...(parentId
            ? { parentId: asId(parentId) }
            : folder
              ? { clearParent: true }
              : {}),
        }),
      { errorTitle: "Couldn't save that folder", onSuccess: onClose },
    );
  }

  function move(delta: 1 | -1) {
    if (!folder) return;
    const other = neighbourFor(siblings, folder.id, delta);
    if (!other) return;
    void run(
      () =>
        reorderFolders({
          folderIds: swappedIds(folders, folder.id, other.id).map(asId),
        }),
      { errorTitle: "Couldn't reorder" },
    );
  }

  return (
    <Inspector
      title={folder ? folder.name : "New folder"}
      subtitle={
        folder
          ? `${itemCount} ${itemCount === 1 ? "thing" : "things"} in it${pinned ? " · pinned" : ""}`
          : "A folder holds anything — colors, faces and files"
      }
      onClose={onClose}
      footer={
        <>
          <Button
            title={folder ? "Save" : "Add folder"}
            size="sm"
            disabled={!name.trim()}
            onPress={save}
          />
          {folder ? (
            <Button
              title="Delete folder"
              size="sm"
              variant="ghost"
              disabled={hasChildren}
              onPress={() =>
                void run(() => deleteFolder({ folderId: asId(folder.id) }), {
                  errorTitle: "Couldn't delete that folder",
                  onSuccess: (value) => {
                    onDeleted(
                      folder.name,
                      (value as { releasedItems: number }).releasedItems,
                    );
                    onClose();
                  },
                })
              }
            />
          ) : null}
        </>
      }
    >
      {folder && index >= 0 ? (
        <ReorderControls
          label={folder.name}
          onEarlier={() => move(-1)}
          onLater={() => move(1)}
          earlierDisabled={index === 0}
          laterDisabled={index === siblings.length - 1}
        />
      ) : null}

      <TextField
        label="Folder name"
        value={name}
        onChangeText={setName}
        maxLength={DESIGN_FOLDER_NAME_MAX}
        hint="Name it after the job — “Instagram posts”, “Easter 2026”."
      />

      <SwitchRow
        label="Give it its own section"
        value={pinned}
        onValueChange={(next) => {
          setPinned(next);
          if (!folder) return;
          void run(
            () => setFolderPinned({ folderId: asId(folder.id), pinned: next }),
            { errorTitle: "Couldn't change that" },
          );
        }}
        hint="A pinned folder draws itself on the tab — its colors, its faces and its files — instead of waiting to be picked in the rail. “Colors” and “Faces” are pinned folders."
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

      {folder ? (
        <View className="mt-1 rounded-md bg-sunken px-3 py-2.5">
          <Text className="text-xs leading-5 text-muted">
            {hasChildren
              ? "This folder has folders inside it, so it can't be deleted — move or delete those first."
              : itemCount > 0
                ? `Deleting this folder releases its ${itemCount} ${itemCount === 1 ? "thing" : "things"}. Nothing gets thrown away — whatever is also in another folder stays there, and whatever isn't lands in Unfiled.`
                : "Nothing in this folder, so deleting it takes nothing with it."}
          </Text>
        </View>
      ) : null}
    </Inspector>
  );
}
