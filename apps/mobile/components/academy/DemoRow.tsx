import type { ReactNode } from "react";
import { View, Text } from "react-native";

/**
 * The facsimile of a real workstream grid row that the practice widgets
 * share: title on the left, an interactive control (status chip, badge…) on
 * the right. One shell so "the real row" looks identical in every section.
 */
export function DemoRow({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <View
      className={`flex-row items-center gap-3 rounded-md border border-border bg-raised px-3 py-2.5 ${className ?? ""}`}
    >
      <Text className="flex-1 text-sm font-medium text-ink" numberOfLines={2}>
        {title}
      </Text>
      {children}
    </View>
  );
}
