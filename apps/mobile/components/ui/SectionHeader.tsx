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
  /**
   * Let the right-hand content drop onto its own line when it doesn't fit
   * beside the title, instead of squeezing both.
   *
   * Off by default because a header carrying one small button is better kept
   * on one line at every width. Marketing → Designs turns it on: its files
   * header carries a density toggle AND an add button, which together are
   * wider than a phone once the title has had its share.
   */
  wrap?: boolean;
};

/** A section label with optional count, an inline title accessory, and a trailing action. */
export function SectionHeader({
  title,
  count,
  titleAccessory,
  right,
  wrap = false,
}: Props) {
  return (
    <View
      className={`mb-3 mt-6 flex-row items-center justify-between gap-3 ${
        wrap ? "flex-wrap" : ""
      }`}
    >
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
