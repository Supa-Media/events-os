import { ReactNode } from "react";
import { View, Text, StyleSheet } from "react-native";
import { colors, spacing } from "../../lib/theme";

type Props = {
  title: string;
  message?: string;
  /** Optional action(s) — e.g. a Button. */
  action?: ReactNode;
};

/** Centered empty placeholder with an optional action. */
export function EmptyState({ title, message, action }: Props) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>{title}</Text>
      {message ? <Text style={styles.message}>{message}</Text> : null}
      {action ? <View style={styles.action}>{action}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.xl * 2,
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  title: { fontSize: 16, fontWeight: "700", color: colors.text, textAlign: "center" },
  message: { fontSize: 14, color: colors.muted, textAlign: "center" },
  action: { marginTop: spacing.md },
});
