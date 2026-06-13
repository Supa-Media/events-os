import { ReactNode } from "react";
import { View, Text } from "react-native";
import { Icon, type IconName } from "./Icon";
import { colors } from "../../lib/theme";

type Props = {
  title: string;
  message?: string;
  icon?: IconName;
  /** Optional action(s) — e.g. a Button. */
  action?: ReactNode;
};

/** Centered empty placeholder with an optional icon halo and action. */
export function EmptyState({ title, message, icon, action }: Props) {
  return (
    <View className="items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-raised px-6 py-14">
      {icon ? (
        <View className="mb-1 h-12 w-12 items-center justify-center rounded-pill bg-accent-soft">
          <Icon name={icon} size={22} color={colors.accent} />
        </View>
      ) : null}
      <Text className="text-center font-display text-lg text-ink">{title}</Text>
      {message ? (
        <Text className="max-w-md text-center text-base text-muted">{message}</Text>
      ) : null}
      {action ? <View className="mt-2">{action}</View> : null}
    </View>
  );
}
