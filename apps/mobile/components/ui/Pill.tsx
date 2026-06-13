import { useState } from "react";
import { Text, Pressable, StyleSheet } from "react-native";
import { colors, radius, spacing } from "../../lib/theme";

type Props = {
  label: string;
  selected?: boolean;
  onPress?: () => void;
};

/**
 * A rounded pill, optionally selectable. Used for skills, components, and
 * compact pickers. Press feedback via opacity state (web-safe).
 */
export function Pill({ label, selected = false, onPress }: Props) {
  const [pressed, setPressed] = useState(false);

  if (!onPress) {
    return (
      <Text style={[styles.pill, selected && styles.selected]}>{label}</Text>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={[styles.pill, selected && styles.selected, pressed && styles.pressed]}
    >
      <Text style={[styles.text, selected && styles.textSelected]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    borderRadius: radius.pill,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.mutedBg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  selected: {
    backgroundColor: colors.accentBg,
    borderColor: colors.accent,
  },
  pressed: { opacity: 0.7 },
  text: { fontSize: 13, color: colors.muted, fontWeight: "500" },
  textSelected: { color: colors.accent, fontWeight: "600" },
});
