import { ReactNode } from "react";
import { View, Text } from "react-native";

type Props = {
  title: string;
  /** Optional supporting count/subtitle shown next to the title. */
  count?: string | number;
  /** Optional right-aligned content (e.g. an action button). */
  right?: ReactNode;
};

/** A section label with optional count and trailing action. */
export function SectionHeader({ title, count, right }: Props) {
  return (
    <View className="mb-3 mt-6 flex-row items-center justify-between">
      <View className="flex-row items-baseline gap-2">
        <Text className="text-xs font-bold uppercase tracking-wider text-muted">
          {title}
        </Text>
        {count !== undefined ? (
          <Text className="text-xs font-semibold text-faint">{count}</Text>
        ) : null}
      </View>
      {right ? <View>{right}</View> : null}
    </View>
  );
}
