import { useState } from "react";
import {
  Pressable,
  Text,
  StyleSheet,
  ActivityIndicator,
  View,
  StyleProp,
  ViewStyle,
} from "react-native";
import { colors, radius, spacing } from "../../lib/theme";

type Variant = "primary" | "secondary" | "danger" | "ghost";
type Size = "md" | "sm";

type Props = {
  title: string;
  onPress: () => void;
  variant?: Variant;
  size?: Size;
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
};

/**
 * Standard button. Press feedback via opacity state (web-safe — function-style
 * Pressable styles are ignored on react-native-web).
 */
export function Button({
  title,
  onPress,
  variant = "primary",
  size = "md",
  disabled = false,
  loading = false,
  style,
}: Props) {
  const [pressed, setPressed] = useState(false);
  const isInert = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={isInert ? undefined : onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={[
        styles.base,
        size === "sm" ? styles.sm : styles.md,
        variantStyles[variant].container,
        pressed && !isInert && styles.pressed,
        isInert && styles.disabled,
        style,
      ]}
    >
      <View style={styles.inner}>
        {loading ? (
          <ActivityIndicator
            size="small"
            color={variantStyles[variant].text.color as string}
          />
        ) : (
          <Text
            style={[
              styles.text,
              size === "sm" && styles.textSm,
              variantStyles[variant].text,
            ]}
          >
            {title}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  md: { paddingVertical: spacing.md, paddingHorizontal: spacing.lg },
  sm: { paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
  inner: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  text: { fontSize: 15, fontWeight: "600" },
  textSm: { fontSize: 13 },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.5 },
});

const variantStyles: Record<
  Variant,
  { container: ViewStyle; text: { color: string } }
> = {
  primary: {
    container: { backgroundColor: colors.accent },
    text: { color: "#ffffff" },
  },
  secondary: {
    container: {
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
    },
    text: { color: colors.text },
  },
  danger: {
    container: { backgroundColor: colors.dangerBg, borderWidth: 1, borderColor: colors.danger },
    text: { color: colors.danger },
  },
  ghost: {
    container: { backgroundColor: "transparent" },
    text: { color: colors.accent },
  },
};
