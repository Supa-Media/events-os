import { Text, View, StyleSheet } from "react-native";
import { radius, spacing, readinessColor, readinessBg } from "../../lib/theme";

type Props = {
  /** 0–100 readiness percentage. */
  value: number;
  size?: "md" | "lg";
};

/**
 * Readiness shown as a % chip, colored by value (<34 danger, <67 amber, else
 * success).
 */
export function ReadinessBadge({ value, size = "md" }: Props) {
  const fg = readinessColor(value);
  const bg = readinessBg(value);
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[styles.text, size === "lg" && styles.textLg, { color: fg }]}>
        {value}%
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    borderRadius: radius.sm,
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
    alignSelf: "flex-start",
  },
  text: { fontSize: 13, fontWeight: "700" },
  textLg: { fontSize: 18 },
});
