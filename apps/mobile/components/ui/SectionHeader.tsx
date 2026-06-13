import { ReactNode } from "react";
import { View, Text, StyleSheet } from "react-native";
import { colors, spacing } from "../../lib/theme";

type Props = {
  title: string;
  /** Optional right-aligned content (e.g. an "Add" button). */
  right?: ReactNode;
};

/** A small uppercase section label with optional trailing action. */
export function SectionHeader({ title, right }: Props) {
  return (
    <View style={styles.row}>
      <Text style={styles.title}>{title}</Text>
      {right ? <View>{right}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
  },
  title: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: colors.muted,
  },
});
