import { useState } from "react";
import { Pressable, Text, View, ActivityIndicator } from "react-native";
import { Icon, type IconName } from "./Icon";
import { colors } from "../../lib/theme";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "md" | "sm";

type Props = {
  title: string;
  onPress: () => void;
  variant?: Variant;
  size?: Size;
  disabled?: boolean;
  loading?: boolean;
  /** Optional leading line icon. */
  icon?: IconName;
  /** Extra NativeWind classes for layout (width, margins). */
  className?: string;
};

/**
 * Primary action control. Hover / pressed feedback is handled via state +
 * NativeWind classes (react-native-web ignores function-style Pressable
 * `style`, so we never use it for layout). Every variant has resting, hover,
 * and pressed treatments plus a disabled state.
 */
export function Button({
  title,
  onPress,
  variant = "primary",
  size = "md",
  disabled = false,
  loading = false,
  icon,
  className = "",
}: Props) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const inert = disabled || loading;

  const v = VARIANTS[variant];
  const bg = inert
    ? v.bg
    : pressed
      ? v.bgPressed
      : hovered
        ? v.bgHover
        : v.bg;

  const pad = size === "sm" ? "px-3 py-1.5" : "px-4 py-2.5";
  const textSize = size === "sm" ? "text-sm" : "text-base";

  return (
    <Pressable
      accessibilityRole="button"
      disabled={inert}
      onPress={inert ? undefined : onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      className={`flex-row items-center justify-center rounded-md ${pad} ${bg} ${v.border} ${inert ? "opacity-60" : ""} ${className}`}
    >
      <View className="flex-row items-center gap-2">
        {loading ? (
          <ActivityIndicator size="small" color={v.iconColor} />
        ) : (
          <>
            {icon ? (
              <Icon name={icon} size={size === "sm" ? 14 : 16} color={v.iconColor} />
            ) : null}
            <Text className={`font-semibold ${textSize} ${v.text}`}>{title}</Text>
          </>
        )}
      </View>
    </Pressable>
  );
}

const VARIANTS: Record<
  Variant,
  {
    bg: string;
    bgHover: string;
    bgPressed: string;
    border: string;
    text: string;
    iconColor: string;
  }
> = {
  primary: {
    bg: "bg-accent",
    bgHover: "bg-accent-hover",
    bgPressed: "bg-accent-hover",
    border: "border border-transparent",
    text: "text-white",
    iconColor: "#FFFFFF",
  },
  secondary: {
    bg: "bg-raised",
    bgHover: "bg-sunken",
    bgPressed: "bg-sunken",
    border: "border border-border-strong",
    text: "text-ink",
    iconColor: colors.ink,
  },
  ghost: {
    bg: "bg-transparent",
    bgHover: "bg-sunken",
    bgPressed: "bg-brand-100",
    border: "border border-transparent",
    text: "text-accent",
    iconColor: colors.accent,
  },
  danger: {
    bg: "bg-danger-bg",
    bgHover: "bg-brand-100",
    bgPressed: "bg-brand-200",
    border: "border border-danger",
    text: "text-danger",
    iconColor: colors.danger,
  },
};
