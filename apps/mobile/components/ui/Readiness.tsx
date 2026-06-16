import { Platform, Text, View } from "react-native";
import { readinessColor } from "../../lib/theme";
import {
  PHASE_KEYS,
  PHASE_LABELS,
  readinessTier,
  type PhaseScores,
} from "@events-os/shared";

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
  /** 0–100, or null for an unmeasured phase (renders a dim "—"). */
  value: number | null;
  size?: number;
}) {
  const track = "#EFE0DC";
  const color = value == null ? track : readinessColor(value);
  const thickness = Math.round(size * 0.13);
  const inner = size - thickness * 2;
  const sweep = value == null ? 0 : value * 3.6;

  const ringStyle: any =
    Platform.OS === "web"
      ? {
          width: size,
          height: size,
          borderRadius: size / 2,
          // web-only CSS gradient — react-native-web passes it straight through.
          backgroundImage: `conic-gradient(${color} ${sweep}deg, ${track} ${sweep}deg)`,
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
        <Text
          className={value == null ? "font-bold text-faint" : "font-bold text-ink"}
          style={{ fontSize: size * (value == null ? 0.3 : 0.26) }}
        >
          {value == null ? "—" : `${value}%`}
        </Text>
      </View>
    </View>
  );
}

/**
 * The four phase scores as a compact row of small labeled rings — the event
 * header's headline readiness signal. Each value is 0..1 or null; null renders
 * "—" so an empty phase doesn't read as "0% ready".
 */
export function PhaseBreakdown({
  phases,
  size = 52,
}: {
  phases: PhaseScores;
  size?: number;
}) {
  return (
    <View className="flex-row flex-wrap items-start gap-x-5 gap-y-2">
      {PHASE_KEYS.map((key) => {
        const score = phases[key];
        const pct = score == null ? null : Math.round(score * 100);
        return (
          <View key={key} className="items-center gap-1">
            <ReadinessRing value={pct} size={size} />
            <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
              {PHASE_LABELS[key]}
            </Text>
          </View>
        );
      })}
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
