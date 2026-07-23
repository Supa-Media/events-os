/**
 * DASH-2 "Where it went" panel — horizontal category bars, single gold hue,
 * values right-aligned in ink, "Other + uncoded" rendered in a muted fill so
 * it reads as the leftover bucket rather than a real category. Data source +
 * documented limitation: see `categoryRollup.ts`.
 *
 * no-dead-numbers: `onPressRow`, when provided, drills a named row into its
 * exact source list. Never offered for the synthetic "Other + uncoded" row
 * (`other: true`) — that bucket is a residual/leftover figure with no single
 * source list that sums to it (see `categoryRollup.ts`'s own doc comment);
 * a caller passing `onPressRow` must supply a target ONLY for rows it can
 * back exactly (e.g. `CentralView`'s tag rollup, where each row already
 * mirrors a real `TagDetailModal` target one-for-one).
 */
import { Pressable, Text, View } from "react-native";
import { formatCents } from "@events-os/shared";
import { Icon } from "../../ui";
import { colors } from "../../../lib/theme";
import { GOLD } from "./chartColors";
import { InfoTooltip } from "../ui";
import type { CategoryRollupResult } from "./categoryRollup";

export function CategoryBars({
  rollup,
  onPressRow,
}: {
  rollup: CategoryRollupResult;
  onPressRow?: (name: string) => void;
}) {
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
        const pressable = !r.other && onPressRow ? () => onPressRow(r.name) : undefined;
        const body = (
          <>
            <View className="flex-row items-center justify-between gap-2">
              <View className="flex-1 flex-row items-center gap-1">
                <Text
                  className={`flex-1 text-xs ${r.other ? "text-muted" : "text-ink"}`}
                  numberOfLines={1}
                >
                  {r.name}
                </Text>
                {r.other ? (
                  <InfoTooltip text="Includes spend with no category assigned, plus event/project budgets in month view (which are excluded from the recurring category breakdown)." size={12} />
                ) : null}
                {pressable ? <Icon name="chevron-right" size={11} color={colors.accent} /> : null}
              </View>
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
          </>
        );
        if (!pressable) {
          return (
            <View key={r.name} className="gap-1">
              {body}
            </View>
          );
        }
        return (
          <Pressable
            key={r.name}
            onPress={pressable}
            accessibilityRole="button"
            className="gap-1 web:hover:opacity-80"
          >
            {body}
          </Pressable>
        );
      })}
    </View>
  );
}
