import { Text, View, StyleSheet } from "react-native";
import { colors, radius, spacing } from "../../lib/theme";

type Tone = "neutral" | "accent" | "success" | "amber" | "danger";

type Props = {
  label: string;
  tone?: Tone;
};

const toneMap: Record<Tone, { bg: string; fg: string }> = {
  neutral: { bg: colors.mutedBg, fg: colors.muted },
  accent: { bg: colors.accentBg, fg: colors.accent },
  success: { bg: colors.successBg, fg: colors.success },
  amber: { bg: colors.amberBg, fg: colors.amber },
  danger: { bg: colors.dangerBg, fg: colors.danger },
};

/** A small colored status chip. */
export function Badge({ label, tone = "neutral" }: Props) {
  const t = toneMap[tone];
  return (
    <View style={[styles.badge, { backgroundColor: t.bg }]}>
      <Text style={[styles.text, { color: t.fg }]}>{label}</Text>
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
  text: { fontSize: 12, fontWeight: "600" },
});
