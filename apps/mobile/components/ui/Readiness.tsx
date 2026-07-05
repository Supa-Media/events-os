import { Text, View } from "react-native";
import { readinessColor } from "../../lib/theme";
import { readinessTier } from "@events-os/shared";

/**
 * Readiness shown as a colored % chip. Color follows the value
 * (<34 danger · <67 warn · else success). Used inline in tables and rows.
 */
export function ReadinessBadge({
  value,
  size = "md",
}: {
  value: number;
  size?: "md" | "lg";
}) {
  const tone = toneClass(value);
  return (
    <View className={`self-start rounded-sm px-2 py-0.5 ${tone.bg}`}>
      <Text className={`font-bold ${size === "lg" ? "text-lg" : "text-sm"} ${tone.text}`}>
        {value}%
      </Text>
    </View>
  );
}

/**
 * A thin horizontal readiness bar with an inline label. Good for dense rows
 * where a ring would be too heavy.
 */
export function ReadinessBar({
  value,
  showLabel = true,
}: {
  value: number;
  showLabel?: boolean;
}) {
  const color = readinessColor(value);
  return (
    <View className="flex-row items-center gap-2">
      <View className="h-1.5 flex-1 overflow-hidden rounded-pill bg-sunken">
        <View
          style={{ width: `${value}%`, backgroundColor: color }}
          className="h-full rounded-pill"
        />
      </View>
      {showLabel ? (
        <Text className="w-9 text-right text-sm font-semibold text-ink">{value}%</Text>
      ) : null}
    </View>
  );
}

// Derives the tier from the shared `readinessTier` (one threshold rule) then
// maps tier → NativeWind chip classes.
function toneClass(value: number): { bg: string; text: string } {
  return {
    danger: { bg: "bg-danger-bg", text: "text-danger" },
    warn: { bg: "bg-warn-bg", text: "text-warn" },
    success: { bg: "bg-success-bg", text: "text-success" },
  }[readinessTier(value)];
}
