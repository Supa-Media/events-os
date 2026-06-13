import { ReactNode, useState } from "react";
import { View, Pressable, StyleSheet, StyleProp, ViewStyle } from "react-native";
import { colors, radius, spacing } from "../../lib/theme";

type Props = {
  children: ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * A bordered white surface. When `onPress` is given it becomes pressable with a
 * simple opacity press state (function-style Pressable styles don't work on web,
 * so we toggle opacity via state instead).
 */
export function Card({ children, onPress, style }: Props) {
  const [pressed, setPressed] = useState(false);

  if (!onPress) {
    return <View style={[styles.card, style]}>{children}</View>;
  }

  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={[styles.card, pressed && styles.pressed, style]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  pressed: { opacity: 0.7 },
});
