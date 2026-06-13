import { useState } from "react";
import { Modal, View, Text, Pressable, ScrollView } from "react-native";
import { Icon } from "./Icon";
import { colors } from "../../lib/theme";

type Role = { _id: string; label: string };

type Props = {
  visible: boolean;
  title?: string;
  roles: Role[];
  selectedId?: string | null;
  onPick: (roleId: string) => void;
  onClear?: () => void;
  onClose: () => void;
};

/**
 * Centered modal popover for assigning a role to a slot. Mirrors PersonPicker
 * but takes roles as a prop (no query) and renders a neutral icon circle instead
 * of an avatar, since roles aren't people. Rows have class-driven hover and a
 * selected check.
 */
export function RolePicker({
  visible,
  title = "Assign role",
  roles,
  selectedId,
  onPick,
  onClear,
  onClose,
}: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
            <Text className="font-display text-lg text-ink">{title}</Text>
            <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView className="max-h-96">
            {onClear ? (
              <Row label="Clear role" muted icon="x" onPress={onClear} />
            ) : null}

            {roles.length === 0 ? (
              <Text className="px-5 py-6 text-center text-base text-muted">
                No roles defined
              </Text>
            ) : (
              roles.map((r) => (
                <Row
                  key={r._id}
                  label={r.label}
                  selected={r._id === selectedId}
                  onPress={() => onPick(r._id)}
                />
              ))
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Row({
  label,
  selected,
  muted,
  icon,
  onPress,
}: {
  label: string;
  selected?: boolean;
  muted?: boolean;
  icon?: "x";
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      className={`flex-row items-center justify-between border-b border-border px-5 py-3 ${
        hovered ? "bg-sunken" : "bg-raised"
      }`}
    >
      <View className="flex-row items-center gap-3">
        <View className="h-7 w-7 items-center justify-center rounded-pill bg-sunken">
          <Icon name={muted ? (icon ?? "tag") : "tag"} size={14} color={colors.muted} />
        </View>
        <Text
          className={`text-base ${
            muted
              ? "text-muted"
              : selected
                ? "font-semibold text-accent"
                : "text-ink"
          }`}
        >
          {label}
        </Text>
      </View>
      {selected ? <Icon name="check" size={16} color={colors.accent} /> : null}
    </Pressable>
  );
}
