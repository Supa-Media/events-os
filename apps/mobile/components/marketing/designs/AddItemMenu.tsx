/**
 * MARKETING · Designs — "add something to this folder".
 *
 * One button, three answers, because a folder holds three kinds of thing now. A
 * row of three buttons was the alternative and it puts "+ Face" on the toolbar
 * of a folder full of posters forever; a menu asks the question only when
 * somebody has said they want to add something.
 *
 * Whatever they pick opens that kind's inspector with THIS folder already
 * ticked (`DesignsView` passes it through), so adding a color to Easter 2026 is
 * one press and one form rather than a form plus a filing step people forget.
 */
import { useRef, useState } from "react";
import { View } from "react-native";
import { FOLDER_ITEM_KINDS, type FolderItemKind } from "@events-os/shared";
import {
  Button,
  ContextMenu,
  measureAnchor,
  type ContextMenuAnchor,
  type IconName,
} from "../../ui";

/** What each kind is called on the menu, and the icon that carries it. */
const KIND_LABELS: Record<FolderItemKind, { label: string; icon: IconName }> = {
  design: { label: "Design file", icon: "image" },
  color: { label: "Color", icon: "droplet" },
  font: { label: "Face", icon: "type" },
};

/** Menu order = the order a folder's body draws them: files, paint, type. */
const MENU_ORDER: FolderItemKind[] = ["design", "color", "font"];

export function AddItemMenu({
  onAdd,
  title = "Add",
  /** Kinds that are at their library-wide cap, disabled with the reason said
   *  in the label rather than silently missing. */
  full = [],
}: {
  onAdd: (kind: FolderItemKind) => void;
  title?: string;
  full?: FolderItemKind[];
}) {
  const ref = useRef<View>(null);
  const [anchor, setAnchor] = useState<ContextMenuAnchor | undefined>(undefined);

  return (
    <View ref={ref}>
      <Button
        title={title}
        icon="plus"
        size="sm"
        onPress={() => measureAnchor(ref.current, setAnchor)}
      />
      <ContextMenu
        anchor={anchor}
        onClose={() => setAnchor(undefined)}
        width={190}
        actions={MENU_ORDER.filter((kind) => FOLDER_ITEM_KINDS.includes(kind))
          .filter((kind) => !full.includes(kind))
          .map((kind) => ({
            label: KIND_LABELS[kind].label,
            icon: KIND_LABELS[kind].icon,
            onPress: () => onAdd(kind),
          }))}
      />
    </View>
  );
}
