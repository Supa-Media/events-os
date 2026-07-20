/**
 * "Add block" row — one button per block kind. Inserts after the currently
 * selected block (or at the end when nothing's selected) via `onAdd`.
 */
import { Pressable, Text, View } from "react-native";
import type { EmailBlockKind } from "@events-os/shared";
import { Icon, type IconName } from "../../ui";
import { colors } from "../../../lib/theme";
import { BLOCK_KIND_LABELS, BLOCK_KINDS } from "../../../lib/emailDesigner";

const KIND_ICON: Record<EmailBlockKind, IconName> = {
  heading: "type",
  text: "align-left",
  image: "image",
  button: "mouse-pointer",
  divider: "minus",
  spacer: "move",
};

export function BlockPalette({ onAdd }: { onAdd: (kind: EmailBlockKind) => void }) {
  return (
    <View className="flex-row flex-wrap gap-2">
      {BLOCK_KINDS.map((kind) => (
        <Pressable
          key={kind}
          onPress={() => onAdd(kind)}
          accessibilityLabel={`Add ${BLOCK_KIND_LABELS[kind]} block`}
          className="flex-row items-center gap-1.5 rounded-md border border-border-strong bg-raised px-3 py-1.5 active:bg-sunken web:hover:bg-sunken"
        >
          <Icon name={KIND_ICON[kind]} size={14} color={colors.accent} />
          <Text className="text-xs font-semibold text-ink">{BLOCK_KIND_LABELS[kind]}</Text>
        </Pressable>
      ))}
    </View>
  );
}
