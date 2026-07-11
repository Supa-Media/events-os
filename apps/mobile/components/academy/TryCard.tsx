import { ReactNode } from "react";
import { View, Text } from "react-native";
import { Icon, type IconName } from "../ui";
import { colors } from "../../lib/theme";

/**
 * Shared shell for the Academy's interactive practice widgets — a dashed
 * "sandbox" surface with an eyebrow so hands-on blocks read differently from
 * the article prose around them. All state inside is throwaway and local;
 * nothing here writes to the backend.
 */
export function TryCard({
  eyebrow,
  icon,
  children,
}: {
  eyebrow: string;
  icon: IconName;
  children: ReactNode;
}) {
  return (
    <View className="rounded-lg border border-dashed border-border-strong bg-raised p-4">
      <View className="mb-3 flex-row items-center gap-2">
        <Icon name={icon} size={13} color={colors.accent} />
        <Text className="text-2xs font-bold uppercase tracking-wider text-accent">
          {eyebrow}
        </Text>
      </View>
      {children}
    </View>
  );
}
