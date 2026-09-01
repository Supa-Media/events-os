/**
 * MARKETING · Designs — a pinned folder, as its own section.
 *
 * Pinning is the whole feature in one word: a folder you pin stops waiting to
 * be selected in the rail and draws itself, contents and all, on the page. That
 * is how "Colors" and "Faces" exist at all after the folder model — they are
 * pinned folders holding the palette and the typefaces, seeded that way by
 * migration `0085`, and nothing about them is special-cased here.
 *
 * So this component knows nothing about colors or faces. It is a header and a
 * `FolderBody`, and an event folder holding a red, a face and four posters
 * renders through exactly the same path.
 *
 * ── It draws on the landing view only ───────────────────────────────────────
 * `DesignsView` renders these while you are standing on "Everything" and takes
 * them down the moment you select a folder or type a search — one specific
 * question deserves one answer, not the same cards repeated under every pinned
 * heading. That is also why the library's own wall skips anything a pinned
 * section is already showing: between the two halves, every item is drawn
 * exactly once.
 *
 * ── Its controls belong to it ───────────────────────────────────────────────
 * Add-into-this-folder and the folder's own settings sit on this header, not in
 * a page toolbar — the rule the rest of this tab follows. The gear opens the
 * folder in the viewer panel, where unpinning lives too, so a section can be
 * put away from the section itself.
 */
import { Text, View } from "react-native";
import {
  type BrandColor,
  type BrandFont,
  type DesignAsset,
  type DesignFolder,
  type FolderItemKind,
} from "@events-os/shared";
import { Button, EmptyState, Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import { AddItemMenu } from "./AddItemMenu";
import { UploadFilesButton } from "./UploadFilesButton";
import { FolderBody } from "./FolderBody";
import { countLabel, itemCount, type LibraryItems } from "./library.shared";
import type { ActionRunner } from "../../../lib/useActionToast";

export function FolderSection({
  folder,
  items,
  total,
  palette,
  view,
  live,
  canEdit,
  full,
  room,
  run,
  onUploaded,
  onAdd,
  onOpenFolder,
  onOpenColor,
  onOpenFont,
  onOpenDesign,
}: {
  folder: DesignFolder;
  /** What to draw — already narrowed by the search box. */
  items: LibraryItems;
  /** Everything in the folder, for the "3 of 8" count while searching. */
  total: number;
  palette: BrandColor[];
  view: "grid" | "list";
  /** The page's one live-embed budget — see `DesignsView`. */
  live: Set<string>;
  canEdit: boolean;
  /** Item kinds at their library-wide cap. */
  full: FolderItemKind[];
  /** How many more designs the library can hold — the bulk upload's headroom. */
  room: number;
  run: ActionRunner["run"];
  /** How many files a batch upload landed in THIS folder. */
  onUploaded: (count: number) => void;
  onAdd: (kind: FolderItemKind) => void;
  onOpenFolder: () => void;
  onOpenColor: (color: BrandColor) => void;
  onOpenFont: (font: BrandFont) => void;
  onOpenDesign: (design: DesignAsset) => void;
}) {
  return (
    <View className="mt-7">
      <View className="mb-3 flex-row flex-wrap items-center justify-between gap-3">
        <View className="flex-shrink flex-row items-center gap-2">
          <Icon name="bookmark" size={13} color={colors.accent} />
          <Text className="text-xs font-bold uppercase tracking-wider text-muted">
            {folder.name}
          </Text>
          <Text className="text-xs font-semibold text-faint">
            {countLabel(itemCount(items), total)}
          </Text>
        </View>
        {canEdit ? (
          <View className="flex-row items-center gap-2">
            <Button
              title="Folder settings"
              icon="settings"
              size="sm"
              variant="ghost"
              onPress={onOpenFolder}
            />
            <UploadFilesButton
              folderId={folder.id}
              room={room}
              run={run}
              onUploaded={onUploaded}
            />
            <AddItemMenu onAdd={onAdd} full={full} />
          </View>
        ) : null}
      </View>

      <FolderBody
        items={items}
        palette={palette}
        view={view}
        live={live}
        onOpenColor={onOpenColor}
        onOpenFont={onOpenFont}
        onOpenDesign={onOpenDesign}
        empty={
          <EmptyState
            icon="folder"
            title={`${folder.name} is empty`}
            message={
              canEdit
                ? "A folder holds anything — a color, a face, a Canva link, an event's photos and clips. Add the first thing."
                : "The marketing team hasn't put anything here yet."
            }
          />
        }
      />
    </View>
  );
}
