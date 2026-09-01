/**
 * MARKETING · Designs — which folders one thing is in.
 *
 * The single control behind the folder model: a color, a face and a design are
 * all filed the same way, so all three inspectors render this same checklist
 * rather than three pickers that drift apart.
 *
 * ── Why a checklist and not a Select ────────────────────────────────────────
 * Membership is many-to-many now (`@events-os/shared`'s `marketingDesigns.ts`
 * argues why). A `Select` can express "which one", and the question here is
 * "which ones" — the org's red is in Colors AND in Easter 2026 at once. A
 * checklist also shows what the answer currently IS without opening anything,
 * which a closed dropdown cannot.
 *
 * ── It saves on every tick, for a thing that already exists ─────────────────
 * The caller decides, and both callers do the same thing: a NEW item collects
 * ticks into its draft and files them on save, an EXISTING item writes each
 * tick straight through `setItemFolders`. That is the same call the old
 * drag-to-file made, for the same reason — filing is not an edit to the row's
 * text, and making somebody press Save to move a swatch into a folder is how a
 * form ends up overwriting a name a colleague changed in another tab.
 *
 * ── The cap is shown before it bites ────────────────────────────────────────
 * `ITEM_FOLDER_MAX` is enforced by the backend, which can only refuse a press
 * that has already happened. So the boxes that would exceed it go disabled with
 * a line saying why, and the ones already ticked stay live so the way out is
 * always visible.
 */
import { Text, View } from "react-native";
import { ITEM_FOLDER_MAX, type DesignFolder } from "@events-os/shared";
import { CheckboxRow, Icon } from "../../ui";
import { colors } from "../../../lib/theme";

export function FolderChecklist({
  folders,
  value,
  onChange,
  label = "Folders",
  hint,
}: {
  /** Every folder in the library, in rail order. */
  folders: DesignFolder[];
  /** The ids currently ticked. */
  value: string[];
  /** The complete next set — whole-list, matching `setItemFolders`. */
  onChange: (next: string[]) => void;
  label?: string;
  hint?: string;
}) {
  const atCap = value.length >= ITEM_FOLDER_MAX;

  function toggle(folderId: string) {
    onChange(
      value.includes(folderId)
        ? value.filter((id) => id !== folderId)
        : [...value, folderId],
    );
  }

  if (folders.length === 0) {
    return (
      <View className="mb-4">
        <FieldLabel label={label} />
        <Text className="text-xs text-faint">
          There are no folders yet. Make one and anything can go in it — colors
          and faces included.
        </Text>
      </View>
    );
  }

  return (
    <View className="mb-4">
      <FieldLabel label={label} />
      {hint ? (
        <Text className="mb-2 text-xs leading-4 text-faint">{hint}</Text>
      ) : null}
      {folders.map((folder) => {
        const checked = value.includes(folder.id);
        return (
          <CheckboxRow
            key={folder.id}
            checked={checked}
            disabled={!checked && atCap}
            onPress={() => toggle(folder.id)}
            className="mb-2"
            // The one-level hierarchy survives in the label, the same way
            // `folderOptions` carries it into a flat picker.
            label={
              folder.parentId
                ? `${parentName(folders, folder.parentId)} / ${folder.name}`
                : folder.name
            }
          />
        );
      })}
      {atCap ? (
        <View className="mt-1 flex-row items-start gap-1.5">
          <Icon name="alert-circle" size={12} color={colors.warn} />
          <Text className="flex-1 text-2xs leading-4 text-warn">
            That&apos;s {ITEM_FOLDER_MAX} folders — the most one thing can be
            in. Untick one to file it somewhere else.
          </Text>
        </View>
      ) : (
        <Text className="mt-1 text-2xs leading-4 text-faint">
          In no folder at all, it still shows up under Unfiled.
        </Text>
      )}
    </View>
  );
}

function FieldLabel({ label }: { label: string }) {
  return (
    <Text className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
      {label}
    </Text>
  );
}

function parentName(folders: DesignFolder[], parentId: string): string {
  return folders.find((f) => f.id === parentId)?.name ?? "Folder";
}
