/**
 * DASH-2 "Spend by month" — the bar chart that DOUBLES as the dashboard's
 * period filter (no second control, per the brief): tapping a bar sets the
 * page's {year, month, period:"month"} state to that bar; tapping the
 * already-selected bar returns to `period:"ytd"`. One gold hue
 * (`chartColors.GOLD`); the selected bar renders full-strength, every other
 * bar dims; the current, still-in-progress month (`partialMonth`) renders
 * hollow/outlined rather than filled solid. The chapter's monthly operating
 * cap (see `capLine.ts`) draws as a dashed amber reference line — built from
 * plain `View`s (no `react-native-svg` in this app's dependency graph; see
 * the DASH-2 PR description for why).
 */
import { Pressable, Text, View } from "react-native";
import { formatCents } from "@events-os/shared";
import { colors } from "../../../lib/theme";
import { GOLD, GOLD_DIM } from "./chartColors";
import { chartScaleMaxCents, heightPct } from "./monthBarsGeometry";

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const CHART_HEIGHT = 120;
const DASH_COUNT = 40;

export function MonthBars({
  months,
  partialMonth,
  capCentsPerMonth,
  selectedMonth,
  onSelectMonth,
}: {
  /** 12 entries, index 0 = January (`dashboardCharts.spendByMonth`'s own
   *  `{month, spendCents}` shape). */
  months: { month: number; spendCents: number }[];
  /** The current, still-in-progress month — rendered hollow. `null` when
   *  the chart's year isn't the current year. */
  partialMonth: number | null;
  /** The dashed reference line's monthly cents figure — `null` draws no
   *  line (see `capLine.ts`'s documented derivation + limitation). */
  capCentsPerMonth: number | null;
  /** The page's currently-selected month (`period === "month"` ? `ym.month`
   *  : `null`) — `null` means YTD/no bar selected, every bar renders at full
   *  strength. */
  selectedMonth: number | null;
  /** Clicking a bar re-derives the page's {year, month, period} — see the
   *  module doc comment. */
  onSelectMonth: (month: number) => void;
}) {
  const spendCents = months.map((m) => m.spendCents);
  const scaleMax = chartScaleMaxCents(spendCents, capCentsPerMonth);
  const capHeight = capCentsPerMonth != null ? heightPct(capCentsPerMonth, scaleMax) : null;

  return (
    <View>
      <View style={{ height: CHART_HEIGHT }} className="relative">
        {capHeight != null ? (
          <View
            pointerEvents="none"
            className="absolute left-0 right-0 flex-row items-center justify-between"
            style={{ bottom: `${capHeight}%` }}
          >
            {Array.from({ length: DASH_COUNT }).map((_, i) => (
              <View key={i} style={{ width: 3, height: 2, backgroundColor: colors.warn }} />
            ))}
          </View>
        ) : null}

        <View className="h-full flex-row items-end justify-between gap-1.5">
          {months.map((m) => {
            const isPartial = m.month === partialMonth;
            const isSelected = selectedMonth === m.month;
            const dimmed = selectedMonth != null && !isSelected;
            const h = heightPct(m.spendCents, scaleMax);
            return (
              <Pressable
                key={m.month}
                onPress={() => onSelectMonth(m.month)}
                accessibilityRole="button"
                accessibilityLabel={`${MONTH_ABBR[m.month - 1]}: ${formatCents(m.spendCents)}${isSelected ? " (selected — tap to return to year-to-date)" : ""}`}
                className="flex-1 items-center justify-end web:hover:opacity-80"
                style={{ height: "100%" }}
              >
                <View
                  className="w-full rounded-t-sm"
                  style={{
                    height: `${Math.max(h, m.spendCents > 0 ? 2 : 0)}%`,
                    backgroundColor: isPartial ? "transparent" : dimmed ? GOLD_DIM : GOLD,
                    borderWidth: isPartial ? 1.5 : 0,
                    borderColor: GOLD,
                    borderStyle: isPartial ? "dashed" : "solid",
                    opacity: isPartial && dimmed ? 0.5 : 1,
                  }}
                />
              </Pressable>
            );
          })}
        </View>
      </View>

      <View className="mt-1.5 flex-row items-center justify-between gap-1.5">
        {months.map((m) => (
          <Text
            key={m.month}
            className={`flex-1 text-center text-2xs ${selectedMonth === m.month ? "font-bold text-ink" : "text-faint"}`}
          >
            {MONTH_ABBR[m.month - 1]}
          </Text>
        ))}
      </View>

      {capCentsPerMonth != null ? (
        <View className="mt-2 flex-row items-center gap-1.5">
          <View style={{ width: 12, height: 2, backgroundColor: colors.warn }} />
          <Text className="text-2xs text-muted">
            Operating cap · {formatCents(capCentsPerMonth)}/mo
          </Text>
        </View>
      ) : null}
    </View>
  );
}
