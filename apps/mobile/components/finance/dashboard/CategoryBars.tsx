/**
 * DASH-2 "Where it went" panel — horizontal category bars, single gold hue,
 * values right-aligned in ink, "Other + uncoded" rendered in a muted fill so
 * it reads as the leftover bucket rather than a real category. Data source +
 * documented limitation: see `categoryRollup.ts`.
 */
import { Text, View } from "react-native";
import { formatCents } from "@events-os/shared";
import { GOLD } from "./chartColors";
import type { CategoryRollupResult } from "./categoryRollup";

export function CategoryBars({ rollup }: { rollup: CategoryRollupResult }) {
  const rows = [
    ...rollup.top.map((c) => ({ name: c.name, spentCents: c.spentCents, other: false })),
    ...(rollup.otherCents > 0
      ? [{ name: "Other + uncoded", spentCents: rollup.otherCents, other: true }]
      : []),
  ];

  if (rows.length === 0) return null;

  return (
    <View className="gap-2.5">
      {/* Must always render — this panel's figures can otherwise look like
       *  they silently contradict the "Spent" KPI tile above it (see
       *  categoryRollup.ts's mode-aware doc comment). */}
      <Text className="text-2xs text-muted">{rollup.caption}</Text>
      {rows.map((r) => {
        const widthPct = Math.max(2, Math.min(100, (r.spentCents / rollup.maxCents) * 100));
        return (
          <View key={r.name} className="gap-1">
            <View className="flex-row items-center justify-between gap-2">
              <Text
                className={`flex-1 text-xs ${r.other ? "text-muted" : "text-ink"}`}
                numberOfLines={1}
              >
                {r.name}
              </Text>
              <Text
                className={`text-xs font-semibold ${r.other ? "text-muted" : "text-ink"}`}
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {formatCents(r.spentCents)}
              </Text>
            </View>
            <View className="h-1.5 w-full overflow-hidden rounded-pill bg-sunken">
              <View
                className="h-full rounded-pill"
                style={{
                  width: `${widthPct}%`,
                  backgroundColor: r.other ? "#D8CFC9" : GOLD,
                }}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}
