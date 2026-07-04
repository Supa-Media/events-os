import { ReactNode } from "react";
import { View, Text } from "react-native";

type Props = {
  title: string;
  /** Optional supporting count/subtitle shown next to the title. */
  count?: string | number;
  /** Optional element rendered inline right after the title (e.g. an owner pill). */
  titleAccessory?: ReactNode;
  /** Optional right-aligned content (e.g. an action button). */
  right?: ReactNode;
};

/** A section label with optional count, an inline title accessory, and a trailing action. */
export function SectionHeader({ title, count, titleAccessory, right }: Props) {
  return (
    <View className="mb-3 mt-6 flex-row items-center justify-between gap-3">
      <View className="flex-shrink flex-row items-center gap-2.5">
        <View className="flex-row items-baseline gap-2">
          <Text className="text-xs font-bold uppercase tracking-wider text-muted">
            {title}
          </Text>
          {count !== undefined ? (
            <Text className="text-xs font-semibold text-faint">{count}</Text>
          ) : null}
        </View>
        {titleAccessory}
      </View>
      {right ? <View>{right}</View> : null}
    </View>
  );
}
