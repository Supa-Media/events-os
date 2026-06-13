import { Platform, Text, View } from "react-native";
import { readinessColor } from "../../lib/theme";

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
 * A circular readiness meter. On web it draws a real ring via a conic-gradient
 * background (react-native-web passes the gradient through as CSS). On native it
 * degrades to a filled disc tinted by the value — both legible and on-brand.
 */
export function ReadinessRing({
  value,
  size = 72,
}: {
  value: number;
  size?: number;
}) {
  const color = readinessColor(value);
  const track = "#EFE0DC";
  const thickness = Math.round(size * 0.13);
  const inner = size - thickness * 2;

  const ringStyle: any =
    Platform.OS === "web"
      ? {
          width: size,
          height: size,
          borderRadius: size / 2,
          // web-only CSS gradient — react-native-web passes it straight through.
          backgroundImage: `conic-gradient(${color} ${value * 3.6}deg, ${track} ${value * 3.6}deg)`,
        }
      : {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: thickness,
          borderColor: color,
        };

  return (
    <View style={ringStyle} className="items-center justify-center">
      <View
        style={{ width: inner, height: inner, borderRadius: inner / 2 }}
        className="items-center justify-center bg-raised"
      >
        <Text className="font-bold text-ink" style={{ fontSize: size * 0.26 }}>
          {value}%
        </Text>
      </View>
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

function toneClass(value: number): { bg: string; text: string } {
  if (value < 34) return { bg: "bg-danger-bg", text: "text-danger" };
  if (value < 67) return { bg: "bg-warn-bg", text: "text-warn" };
  return { bg: "bg-success-bg", text: "text-success" };
}
