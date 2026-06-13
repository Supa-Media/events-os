import { ReactNode, useState } from "react";
import { View, Pressable, StyleProp, ViewStyle } from "react-native";

type Props = {
  children: ReactNode;
  onPress?: () => void;
  /** Padding density. */
  padding?: "none" | "sm" | "md" | "lg";
  /** Extra NativeWind classes. */
  className?: string;
  /** Escape hatch for layout-only style (gap, margins) on legacy callers. */
  style?: StyleProp<ViewStyle>;
};

const PAD = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-5",
} as const;

/**
 * A raised, hairline-bordered surface with a soft warm shadow. When `onPress`
 * is given it becomes interactive with hover/pressed treatments (handled via
 * state + classes, never function-style Pressable styles — RN-web ignores
 * those for layout).
 */
export function Card({
  children,
  onPress,
  padding = "lg",
  className = "",
  style,
}: Props) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  const base = `rounded-lg border bg-raised ${PAD[padding]} ${className}`;

  if (!onPress) {
    return (
      <View style={style} className={`${base} border-border shadow-card`}>
        {children}
      </View>
    );
  }

  const state = pressed
    ? "border-border-strong bg-sunken"
    : hovered
      ? "border-border-strong shadow-raised"
      : "border-border shadow-card";

  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={style}
      className={`${base} ${state}`}
    >
      {children}
    </Pressable>
  );
}
