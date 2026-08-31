/**
 * MARKETING · Designs — the filing cabinet you move through, WITH the controls
 * that change it.
 *
 * ── Why this moved ─────────────────────────────────────────────────────────
 * The first cut hung this rail off the left edge of the whole page, level with
 * the colors — while the grid it filters sat three sections further down, the
 * "New folder" button lived in the page toolbar at the very top, and "Folder
 * settings" was a third button in the files section header. Three controls for
 * one idea, none of them beside the thing they act on, which is exactly the
 * founder's read: "the design files and folders are disjointed from the actual
 * controls to handle and add to them and change them."
 *
 * So the rail now lives INSIDE the Design files section, immediately beside the
 * grid, and it carries its own controls: the head row adds a folder, and the
 * open folder is renamed, re-filed or deleted from the rail itself. Nothing
 * about folders is anywhere else on the page.
 *
 * ── Two shapes, one list ────────────────────────────────────────────────────
 * A column beside the grid on a desk; a horizontal strip of chips above it on a
 * phone, where a column would eat half the screen. Same shelves, same order,
 * same counts, same head row — only the direction changes.
 *
 * The one deliberate difference: on a desk the open folder's settings sit on
 * its own row, where a gear beside a name reads as "this folder"; a chip strip
 * has no room for a control inside a chip, so there the same action is a
 * labelled button in the head row. Both are one press from the folder they act
 * on, which is the property that matters.
 *
 * ── Rows still don't carry a pencil and a bin ───────────────────────────────
 * The gear OPENS the folder in the viewer panel, where every folder edit lives
 * (`FolderInspector`). Browsing stays browsing: only the shelf you already have
 * open shows a control, and only for someone who can actually edit it.
 */
import { Pressable, ScrollView, Text, View } from "react-native";
import { Button, Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import { isVirtualShelf, type Shelf, type ShelfId } from "./library.shared";

export function FolderRail({
  shelves,
  activeShelf,
  onSelect,
  narrow,
  canEdit,
  canAddFolder,
  onNewFolder,
  onOpenFolder,
}: {
  shelves: Shelf[];
  activeShelf: ShelfId;
  onSelect: (shelfId: ShelfId) => void;
  /** Lay out as a horizontal strip instead of a column. */
  narrow: boolean;
  /** Whether the two folder-editing affordances render at all. */
  canEdit: boolean;
  /** False at `DESIGN_FOLDER_MAX_COUNT` — the button stays, disabled. */
  canAddFolder: boolean;
  onNewFolder: () => void;
  /** Open a real folder in the viewer panel, to rename, re-file or delete it. */
  onOpenFolder: (folderId: string) => void;
}) {
  // "All files" and "Unfiled" are views, not rows in `designFolders`: there is
  // nothing to rename and nothing to delete, so they never grow a gear.
  const openFolder =
    shelves.find(
      (shelf) => shelf.id === activeShelf && !isVirtualShelf(shelf.id),
    ) ?? null;

  if (narrow) {
    return (
      <View className="mb-4">
        <RailHead
          canEdit={canEdit}
          canAddFolder={canAddFolder}
          onNewFolder={onNewFolder}
          // On a strip the head row is the only place a folder control fits.
          settingsFor={openFolder}
          onOpenFolder={onOpenFolder}
        />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingRight: 8 }}
        >
          {shelves.map((shelf) => (
            <ShelfChip
              key={shelf.id}
              shelf={shelf}
              active={shelf.id === activeShelf}
              onPress={() => onSelect(shelf.id)}
            />
          ))}
        </ScrollView>
      </View>
    );
  }

  return (
    <View className="w-[214px] shrink-0">
      <RailHead
        canEdit={canEdit}
        canAddFolder={canAddFolder}
        onNewFolder={onNewFolder}
        settingsFor={null}
        onOpenFolder={onOpenFolder}
      />
      <View className="gap-0.5">
        {shelves.map((shelf) => (
          <ShelfRow
            key={shelf.id}
            shelf={shelf}
            active={shelf.id === activeShelf}
            onPress={() => onSelect(shelf.id)}
            onSettings={
              canEdit && shelf.folderId && shelf.id === openFolder?.id
                ? () => onOpenFolder(shelf.folderId as string)
                : undefined
            }
          />
        ))}
      </View>
    </View>
  );
}

/** The label and the folder controls, identical in both shapes. */
function RailHead({
  canEdit,
  canAddFolder,
  onNewFolder,
  settingsFor,
  onOpenFolder,
}: {
  canEdit: boolean;
  canAddFolder: boolean;
  onNewFolder: () => void;
  /** The open folder, when its settings belong in this row (strip only). */
  settingsFor: Shelf | null;
  onOpenFolder: (folderId: string) => void;
}) {
  return (
    <View className="mb-1.5 flex-row flex-wrap items-center justify-between gap-x-1">
      <Text className="pl-2.5 text-2xs font-bold uppercase tracking-wider text-faint">
        Folders
      </Text>
      <View className="flex-row flex-wrap items-center">
        {canEdit && settingsFor?.folderId ? (
          <Button
            title={`Edit “${settingsFor.name}”`}
            icon="settings"
            size="sm"
            variant="ghost"
            onPress={() => onOpenFolder(settingsFor.folderId as string)}
          />
        ) : null}
        {canEdit ? (
          <Button
            title="New folder"
            icon="folder-plus"
            size="sm"
            variant="ghost"
            disabled={!canAddFolder}
            onPress={onNewFolder}
          />
        ) : null}
      </View>
    </View>
  );
}

function ShelfRow({
  shelf,
  active,
  onPress,
  onSettings,
}: {
  shelf: Shelf;
  active: boolean;
  onPress: () => void;
  /** Present only on the open folder, and only for someone who may edit it. */
  onSettings?: () => void;
}) {
  return (
    // The row is a plain View holding two sibling presses rather than a gear
    // nested inside the row's own Pressable: nesting one press inside another
    // resolves differently on web and native, and "I tapped the gear and it
    // just selected the folder" is the kind of bug that only shows up on a
    // phone.
    <View
      className={`flex-row items-center rounded-md ${
        active ? "bg-accent-soft" : "web:hover:bg-sunken"
      }`}
    >
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={`${shelf.name}, ${shelf.count} ${shelf.count === 1 ? "file" : "files"}`}
        className={`min-w-0 flex-1 flex-row items-center gap-2 py-1.5 ${
          shelf.depth === 1 ? "pl-6" : "pl-2.5"
        } ${onSettings ? "pr-1" : "pr-2.5"}`}
      >
        <Text
          className={`min-w-0 flex-1 text-sm ${active ? "font-semibold text-accent" : "text-muted"}`}
          numberOfLines={1}
        >
          {shelf.name}
        </Text>
        <Text
          className={`text-2xs ${active ? "text-accent" : "text-faint"}`}
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {shelf.count}
        </Text>
      </Pressable>
      {onSettings ? (
        <Pressable
          onPress={onSettings}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={`Folder settings for ${shelf.name}`}
          className="rounded-md py-1.5 pl-1.5 pr-2 web:hover:bg-brand-100"
        >
          <Icon name="settings" size={13} color={colors.accent} />
        </Pressable>
      ) : null}
    </View>
  );
}

function ShelfChip({
  shelf,
  active,
  onPress,
}: {
  shelf: Shelf;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${shelf.name}, ${shelf.count} ${shelf.count === 1 ? "file" : "files"}`}
      className={`flex-row items-center gap-1.5 rounded-pill border px-3 py-1.5 ${
        active ? "border-accent bg-accent-soft" : "border-border bg-raised"
      }`}
    >
      <Text
        className={`text-sm ${active ? "font-semibold text-accent" : "text-muted"}`}
      >
        {shelf.depth === 1 ? `↳ ${shelf.name}` : shelf.name}
      </Text>
      <Text
        className={`text-2xs ${active ? "text-accent" : "text-faint"}`}
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {shelf.count}
      </Text>
    </Pressable>
  );
}
