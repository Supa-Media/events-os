import { ReactNode } from "react";
import { ScrollView, View, StyleSheet, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, spacing } from "../../lib/theme";

type Props = {
  children?: ReactNode;
  /** When true, content is laid out in a scroll view (the default). */
  scroll?: boolean;
  /** Show a centered spinner instead of children. */
  loading?: boolean;
  /** Extra padding control. */
  padded?: boolean;
};

/**
 * Page wrapper: safe-area aware, light background. On web the
 * contentContainerStyle flexGrow:1 ensures content fills the available width.
 */
export function Screen({
  children,
  scroll = true,
  loading = false,
  padded = true,
}: Props) {
  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      </SafeAreaView>
    );
  }

  if (!scroll) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={[styles.flex, padded && styles.padded]}>{children}</View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[
          styles.scrollContent,
          padded && styles.padded,
        ]}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingBottom: spacing.xl * 2 },
  padded: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
