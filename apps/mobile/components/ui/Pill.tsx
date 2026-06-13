import { useState } from "react";
import { Text, Pressable, View } from "react-native";

type Props = {
  label: string;
  selected?: boolean;
  onPress?: () => void;
};

/**
 * A rounded selectable chip used for filters and segmented choices. Hover and
 * selected states are class-driven (web-safe). When non-interactive it renders
 * a static tag.
 */
export function Pill({ label, selected = false, onPress }: Props) {
  const [hovered, setHovered] = useState(false);

  if (!onPress) {
    return (
      <View className="self-start rounded-pill border border-border bg-sunken px-3 py-1">
        <Text className="text-sm font-medium text-muted">{label}</Text>
      </View>
    );
  }

  const state = selected
    ? "border-accent bg-accent-soft"
    : hovered
      ? "border-border-strong bg-sunken"
      : "border-border bg-raised";

  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      className={`self-start rounded-pill border px-3 py-1 ${state}`}
    >
      <Text
        className={`text-sm ${selected ? "font-semibold text-accent" : "font-medium text-muted"}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}
