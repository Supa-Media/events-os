/**
 * DASH-2 KPI tile sparkline — a tiny bar-strip trend (not a true line chart:
 * this app has no `react-native-svg` dependency, and this PR may not add
 * one — see the PR description). Renders the elapsed months (through
 * `partialMonth`, or all 12 for a past year) as thin gold bars with the
 * final bar's endpoint emphasized by a small dot, sitting in the corner of
 * the "Spent · YTD" tile.
 */
import { View } from "react-native";
import { GOLD, GOLD_DIM } from "./chartColors";

const HEIGHT = 24;
const WIDTH = 56;

export function SparkLine({
  months,
  partialMonth,
}: {
  /** 12 entries, index 0 = January. */
  months: { month: number; spendCents: number }[];
  partialMonth: number | null;
}) {
  const elapsed = months.filter((m) => partialMonth == null || m.month <= partialMonth);
  if (elapsed.length === 0) return null;
  const max = Math.max(1, ...elapsed.map((m) => m.spendCents));
  const last = elapsed[elapsed.length - 1];

  return (
    <View style={{ width: WIDTH, height: HEIGHT }} className="flex-row items-end gap-0.5">
      {elapsed.map((m) => {
        const isLast = m.month === last.month;
        const h = Math.max(2, Math.round((m.spendCents / max) * HEIGHT));
        return (
          <View key={m.month} className="flex-1 items-center justify-end" style={{ height: HEIGHT }}>
            <View
              className="w-full rounded-t-sm"
              style={{ height: h, backgroundColor: isLast ? GOLD : GOLD_DIM }}
            />
            {isLast ? (
              <View
                className="absolute rounded-pill"
                style={{
                  bottom: h - 3,
                  width: 5,
                  height: 5,
                  backgroundColor: GOLD,
                }}
              />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
