/**
 * DASH-2 "Meter semantics everywhere" — the shared spent-of-cap visual
 * language for the command-center chapter dashboard: a status dot, a slim
 * fill bar, and an "over" chip, all keyed off the SAME `meterTone(pct)` rule
 * (see `meterTone.ts` for the thresholds + why they're deliberately
 * different from the older `BudgetBar` in `parts.tsx`).
 */
import { Text, View } from "react-native";
import { colors } from "../../../lib/theme";
import { Badge } from "../../ui";
import { GOLD } from "./chartColors";
import { meterFillWidthPct, meterTone, type MeterTone } from "./meterTone";

const TONE_COLOR: Record<MeterTone, string> = {
  gold: GOLD,
  amber: colors.warn,
  red: colors.danger,
};

/** A thin spent-of-cap fill bar, colored by `meterTone(pct)`. */
export function Meter({
  pct,
  size = "md",
}: {
  pct: number;
  size?: "sm" | "md";
}) {
  const tone = meterTone(pct);
  const height = size === "sm" ? "h-1" : "h-1.5";
  return (
    <View className={`${height} w-full overflow-hidden rounded-pill bg-sunken`}>
      <View
        className="h-full rounded-pill"
        style={{ width: `${meterFillWidthPct(pct)}%`, backgroundColor: TONE_COLOR[tone] }}
      />
    </View>
  );
}

/** A small colored dot summarizing a row's meter tone at a glance — the
 *  "status dot" leading every dense row. */
export function MeterDot({ pct, size = 8 }: { pct: number; size?: number }) {
  const tone = meterTone(pct);
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: TONE_COLOR[tone],
      }}
    />
  );
}

/** The "over" chip — renders nothing at/under 100% (the meter fill + dot
 *  already carry the red signal past that; this just makes the raw number's
 *  MEANING explicit rather than implied by color alone). */
export function OverChip({ pct }: { pct: number }) {
  if (pct <= 100) return null;
  return <Badge label={`${Math.round(pct)}% · Over`} tone="danger" />;
}

/** Percent readout, colored to match its own meter tone — used next to a
 *  slim `Meter` where a bare `Badge` would be too heavy (dense table rows). */
export function MeterPct({ pct }: { pct: number }) {
  const tone = meterTone(pct);
  const toneClass = tone === "red" ? "text-danger" : tone === "amber" ? "text-warn" : "text-ink";
  return (
    <Text className={`text-xs font-semibold ${toneClass}`} style={{ fontVariant: ["tabular-nums"] }}>
      {Math.round(pct)}%
    </Text>
  );
}
