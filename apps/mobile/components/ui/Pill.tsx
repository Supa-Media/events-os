import { useState } from "react";
import { Text, Pressable, View } from "react-native";

type Props = {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  /**
   * `"sm"` is the DENSE variant, for long filter rows where the chips are a
   * secondary control rather than the page's primary choice — Reconcile's nine
   * filter pills, say, which at the default size push the first row of data
   * most of the way down a phone screen. Keeping the default for the primary
   * selector above them (the books row) is deliberate: same component, two
   * sizes, and the size difference is what tells you which one is the bigger
   * decision.
   */
  size?: "md" | "sm";
  /**
   * A live count shown after the label. Passed SEPARATELY rather than
   * interpolated into `label` so it can be de-emphasised — a filter's count is
   * supporting detail, and rendering it at the label's own weight (as
   * `"Missing receipt  153"` did) makes every chip read as two competing
   * words. Tabular figures so the row doesn't reflow as counts tick.
   */
  count?: number;
};

/**
 * A rounded selectable chip used for filters and segmented choices. Hover and
 * selected states are class-driven (web-safe). When non-interactive it renders
 * a static tag.
 */
export function Pill({ label, selected = false, onPress, size = "md", count }: Props) {
  const [hovered, setHovered] = useState(false);
  const sm = size === "sm";
  const pad = sm ? "px-2.5 py-1" : "px-3 py-1";
  const labelSize = sm ? "text-xs" : "text-sm";
  const countSize = sm ? "text-2xs" : "text-xs";

  const body = (tone: string, countTone: string) => (
    <View className="flex-row items-baseline gap-1">
      <Text className={`${labelSize} ${tone}`}>{label}</Text>
      {count != null ? (
        <Text
          className={`${countSize} font-semibold ${countTone}`}
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {count}
        </Text>
      ) : null}
    </View>
  );

  if (!onPress) {
    return (
      <View className={`self-start rounded-pill border border-border bg-sunken ${pad}`}>
        {body("font-medium text-muted", "text-faint")}
      </View>
    );
  }

  const state = selected
    ? "border-accent bg-accent-soft"
    : hovered
      ? "border-border-strong bg-sunken"
      : "border-border bg-raised";

  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      className={`self-start rounded-pill border ${pad} ${state}`}
    >
      {body(
        selected ? "font-semibold text-accent" : "font-medium text-muted",
        selected ? "text-accent" : "text-faint",
      )}
    </Pressable>
  );
}
