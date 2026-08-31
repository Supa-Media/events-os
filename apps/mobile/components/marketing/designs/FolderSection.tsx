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
import { FolderBody } from "./FolderBody";
import { countLabel, itemCount, type LibraryItems } from "./library.shared";

export function FolderSection({
  folder,
  items,
  total,
  palette,
  view,
  canEdit,
  full,
  searching,
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
  canEdit: boolean;
  /** Item kinds at their library-wide cap. */
  full: FolderItemKind[];
  searching: boolean;
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
            <AddItemMenu onAdd={onAdd} full={full} />
          </View>
        ) : null}
      </View>

      <FolderBody
        items={items}
        palette={palette}
        view={view}
        onOpenColor={onOpenColor}
        onOpenFont={onOpenFont}
        onOpenDesign={onOpenDesign}
        empty={
          <EmptyState
            icon={searching ? "search" : "folder"}
            title={
              searching
                ? `Nothing in ${folder.name} matches that`
                : `${folder.name} is empty`
            }
            message={
              searching
                ? "The search looks at the whole library, so it may be somewhere else."
                : canEdit
                  ? "A folder holds anything — a color, a face, a Canva link. Add the first thing."
                  : "The marketing team hasn't put anything here yet."
            }
          />
        }
      />
    </View>
  );
}
