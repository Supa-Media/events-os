import { ReactNode } from "react";
import { View, Text } from "react-native";

type Props = {
  title: string;
  subtitle?: string;
  /** Optional eyebrow shown above the title (e.g. breadcrumb / type). */
  eyebrow?: string;
  /** Right-aligned actions (buttons). */
  actions?: ReactNode;
};

/**
 * The page top bar: a serif display title with optional eyebrow + subtitle on
 * the left and actions on the right. Sits inside the content column so it lines
 * up with the page body.
 */
export function PageHeader({ title, subtitle, eyebrow, actions }: Props) {
  return (
    <View className="mb-6 flex-row items-start justify-between gap-4">
      <View className="flex-1">
        {eyebrow ? (
          <Text className="mb-1 text-xs font-bold uppercase tracking-wider text-accent">
            {eyebrow}
          </Text>
        ) : null}
        <Text className="font-display text-3xl text-ink">{title}</Text>
        {subtitle ? (
          <Text className="mt-1.5 text-base text-muted">{subtitle}</Text>
        ) : null}
      </View>
      {actions ? <View className="flex-row items-center gap-2 pt-1">{actions}</View> : null}
    </View>
  );
}
