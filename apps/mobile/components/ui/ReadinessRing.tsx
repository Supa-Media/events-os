import { Platform, Text, View } from "react-native";
import { readinessColor } from "../../lib/theme";
import { Icon } from "./Icon";
import { useEasedValue } from "./useEasedValue";

export const READINESS_TRACK = "#EFE0DC";

/**
 * The ring band itself: a conic-gradient arc on web (react-native-web passes the
 * CSS through), a bordered disc on native where gradients aren't available.
 * Shared by both the big ReadinessRing and the tiny MiniRing.
 */
function ringBandStyle({
  size,
  thickness,
  color,
  sweep,
  glow,
}: {
  size: number;
  thickness: number;
  color: string;
  sweep: number;
  glow?: string;
}): any {
  const base = { width: size, height: size, borderRadius: size / 2 };
  if (Platform.OS === "web") {
    return {
      ...base,
      backgroundImage: `conic-gradient(${color} ${sweep}deg, ${READINESS_TRACK} ${sweep}deg)`,
      ...(glow ? { boxShadow: glow } : null),
    };
  }
  return { ...base, borderWidth: thickness, borderColor: color };
}

/** Sonar halo pinging outward from a completed ring — the payoff (web only). */
function CompletionHalo({ size, color }: { size: number; color: string }) {
  return (
    <View
      pointerEvents="none"
      style={
        {
          position: "absolute",
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
          animationKeyframes: {
            "0%": { opacity: 0.45, transform: [{ scale: 1 }] },
            "100%": { opacity: 0, transform: [{ scale: 1.5 }] },
          },
          animationDuration: "1600ms",
          animationIterationCount: "infinite",
          animationTimingFunction: "ease-out",
        } as any
      }
    />
  );
}

/** White dot riding the sweep's leading edge, orbiting as the value grows. */
function Playhead({
  size,
  thickness,
  sweep,
  color,
}: {
  size: number;
  thickness: number;
  sweep: number;
  color: string;
}) {
  const dot = thickness + 3;
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        width: size,
        height: size,
        transform: [{ rotate: `${sweep}deg` }],
      }}
    >
      <View
        style={{
          position: "absolute",
          top: thickness / 2 - dot / 2,
          left: size / 2 - dot / 2,
          width: dot,
          height: dot,
          borderRadius: dot / 2,
          backgroundColor: "#FFFFFF",
          borderWidth: 2,
          borderColor: color,
        }}
      />
    </View>
  );
}

/**
 * A circular readiness meter, animated: the sweep eases in, the % counts up, a
 * playhead dot rides the leading edge, and a phase-colored glow intensifies as
 * the value climbs. At 100% the number gives way to a checkmark and (on web) a
 * sonar halo pings outward. `color`/`glowColor` override the default
 * readiness-tier tint so phase rings can wear their identity hue.
 */
export function ReadinessRing({
  value,
  size = 72,
  color,
  glowColor,
}: {
  /** 0–100, or null for an unmeasured phase (renders a dim "—"). */
  value: number | null;
  size?: number;
  color?: string;
  glowColor?: string;
}) {
  const eased = useEasedValue(value ?? 0);
  const complete = (value ?? 0) >= 100;
  const ringColor = color ?? (value == null ? READINESS_TRACK : readinessColor(value));
  const thickness = Math.round(size * 0.13);
  const inner = size - thickness * 2;
  const sweep = eased * 3.6;
  const isWeb = Platform.OS === "web";
  const glow =
    isWeb && glowColor && eased > 0
      ? `0 0 ${2 + (eased / 100) * 14}px ${glowColor}`
      : undefined;

  return (
    <View className="items-center justify-center">
      {complete && isWeb ? (
        <CompletionHalo size={size} color={glowColor ?? ringColor} />
      ) : null}

      <View
        style={ringBandStyle({ size, thickness, color: ringColor, sweep, glow })}
        className="items-center justify-center"
      >
        <View
          style={{ width: inner, height: inner, borderRadius: inner / 2 }}
          className="items-center justify-center bg-raised"
        >
          {complete ? (
            <Icon name="check" size={size * 0.34} color={ringColor} />
          ) : (
            <Text
              className={value == null ? "font-bold text-faint" : "font-bold text-ink"}
              style={{ fontSize: size * (value == null ? 0.3 : 0.26) }}
            >
              {value == null ? "—" : `${Math.round(eased)}%`}
            </Text>
          )}
        </View>

        {isWeb && value != null && eased > 2 && !complete ? (
          <Playhead size={size} thickness={thickness} sweep={sweep} color={ringColor} />
        ) : null}
      </View>
    </View>
  );
}

/**
 * A tiny ring for tab bars and dense rows — the visual echo of the big phase
 * rings, in the same hue, so a tab visibly "belongs" to its ring. Fills as the
 * module progresses; flips to a solid check disc when complete.
 */
export function MiniRing({
  value,
  size = 14,
  color,
}: {
  /** 0–100. */
  value: number;
  size?: number;
  color: string;
}) {
  const eased = useEasedValue(value, 700);
  const thickness = Math.max(2.5, size * 0.2);
  const inner = size - thickness * 2;

  if (value >= 100) {
    return (
      <View
        style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }}
        className="items-center justify-center"
      >
        <Icon name="check" size={size * 0.64} color="#FFFFFF" />
      </View>
    );
  }

  return (
    <View
      style={ringBandStyle({
        size,
        thickness,
        color: eased > 0 ? color : READINESS_TRACK,
        sweep: eased * 3.6,
      })}
      className="items-center justify-center"
    >
      <View
        style={{ width: inner, height: inner, borderRadius: inner / 2 }}
        className="bg-raised"
      />
    </View>
  );
}
