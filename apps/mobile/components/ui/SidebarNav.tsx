import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon, type IconName } from "./Icon";
import { colors } from "../../lib/theme";

type Props = {
  label: string;
  icon: IconName;
  active?: boolean;
  /** Compact rail mode (icon only) for narrow desktop. */
  compact?: boolean;
  onPress: () => void;
};

/**
 * A left-sidebar navigation item. Active state gets a soft brand fill + accent
 * text and an inset marker; hover gets a subtle sunken fill. Class-driven so it
 * behaves on web.
 */
export function SidebarNavItem({ label, icon, active = false, compact = false, onPress }: Props) {
  const [hovered, setHovered] = useState(false);

  const bg = active ? "bg-accent-soft" : hovered ? "bg-sunken" : "bg-transparent";
  const tint = active ? colors.accent : hovered ? colors.ink : colors.muted;

  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      className={`flex-row items-center gap-3 rounded-md px-3 py-2 ${bg} ${compact ? "justify-center" : ""}`}
    >
      <Icon name={icon} size={18} color={tint} />
      {compact ? null : (
        <Text
          className={`text-base ${active ? "font-semibold text-accent" : hovered ? "text-ink" : "text-muted"}`}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}
