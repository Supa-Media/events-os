/**
 * "Blended fee rate" — what the payment rails actually cost, month by month,
 * as a percentage of what went through them
 * (`dashboardCharts.feeRateByMonth`).
 *
 * Built as a sibling to `MonthBars`: the same plain-`View` bars (this app has
 * no `react-native-svg` dependency), the same gold hue, the same 12-slot
 * layout and month strip, so the two charts stacked in the central dashboard's
 * left column read as one family — spend, and then what the rails took to
 * collect it.
 *
 * ── A GAP IS NOT A ZERO, AND THE DIFFERENCE IS VISIBLE ──────────────────────
 * A month that processed nothing has NO rate (the query returns
 * `effectiveRateBps: null`; see `@events-os/shared#effectiveRateBps` for why
 * that is `null` and not `0`). Bars alone cannot carry that distinction — a
 * 0%-height bar and a missing bar look identical — so a gap month renders an
 * explicit muted dash on the baseline where its bar would be, and the legend
 * names it. A reader must never be able to mistake "we processed nothing in
 * February" for "our fees went to zero in February", because the second one
 * would send somebody hunting for a change that never happened.
 *
 * ── DELIBERATELY NOT PRESSABLE ──────────────────────────────────────────────
 * `MonthBars` doubles as the page's period filter; this chart does not. The
 * period picker drives budgets and spend, and none of the figures here move
 * with it — the rate for March is the rate for March whatever the page's
 * selected period is. Wiring a tap to change the page's period would make the
 * rest of the dashboard jump for a chart that didn't move, and there is no
 * per-month fee drill-in to route to instead: the monthly fee TRANSACTION
 * already carries its own line-by-line evidence
 * (`processorFees.feeRowDetail`, reachable from Reconcile), which is a better
 * answer to "what is this made of" than a filter would be.
 */
import { Text, View } from "react-native";
import { formatCents } from "@events-os/shared";
import { colors } from "../../../lib/theme";
import { GOLD, GOLD_DIM } from "./chartColors";
import { formatRateBps, rateScaleMaxBps } from "./feeRateGeometry";

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const CHART_HEIGHT = 120;

export type FeeRateMonth = {
  month: number;
  feeCents: number;
  grossCents: number;
  effectiveRateBps: number | null;
};

export function FeeRateBars({
  months,
  partialMonth,
  yearFeeCents,
  yearGrossCents,
  yearEffectiveRateBps,
}: {
  /** 12 entries, index 0 = January (`dashboardCharts.feeRateByMonth`'s own
   *  row shape). `effectiveRateBps: null` means the month processed nothing
   *  and draws a GAP — see the module doc. */
  months: FeeRateMonth[];
  /** The month still accruing — rendered hollow, because a partial month's
   *  blended rate is not yet the rate it will settle at. `null` when the
   *  chart's year isn't the current year. */
  partialMonth: number | null;
  /** The year's totals + its blended rate (fees over volume, NOT the mean of
   *  the months — see the query's doc comment). `null` rate = the whole year
   *  processed nothing. */
  yearFeeCents: number;
  yearGrossCents: number;
  yearEffectiveRateBps: number | null;
}) {
  const scaleMaxBps = rateScaleMaxBps(months.map((m) => m.effectiveRateBps));
  const hasGap = months.some((m) => m.effectiveRateBps == null);

  return (
    <View>
      {/* The headline: the year as one number, with the two figures it is a
          ratio of right beside it — a rate nobody can decompose is a rate
          nobody acts on. */}
      <View className="mb-3 flex-row items-baseline gap-2">
        <Text
          className="font-display text-2xl text-ink"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {yearEffectiveRateBps == null ? "—" : formatRateBps(yearEffectiveRateBps)}
        </Text>
        <Text className="flex-shrink text-xs text-muted">
          {yearGrossCents > 0
            ? `blended · ${formatCents(yearFeeCents)} of fees on ${formatCents(yearGrossCents)} processed`
            : "nothing processed this year"}
        </Text>
      </View>

      <View style={{ height: CHART_HEIGHT }}>
        <View className="h-full flex-row items-end justify-between gap-1.5">
          {months.map((m) => {
            const isPartial = m.month === partialMonth;
            const rate = m.effectiveRateBps;
            const label =
              rate == null
                ? `${MONTH_ABBR[m.month - 1]}: no volume processed, so no rate`
                : `${MONTH_ABBR[m.month - 1]}: ${formatRateBps(rate)} — ${formatCents(m.feeCents)} of fees on ${formatCents(m.grossCents)} processed`;
            return (
              <View
                key={m.month}
                accessible
                accessibilityLabel={label}
                className="flex-1 items-center justify-end"
                style={{ height: "100%" }}
              >
                {rate == null ? (
                  // THE GAP. Not a zero-height bar (indistinguishable from a
                  // real 0%) and not nothing at all (indistinguishable from a
                  // rendering bug) — a deliberate dash on the baseline that
                  // says "there is no number here", matching the "—" the
                  // headline uses for the same condition.
                  <View
                    style={{
                      width: "60%",
                      height: 2,
                      backgroundColor: colors.faint,
                      marginBottom: 1,
                    }}
                  />
                ) : (
                  <View
                    className="w-full rounded-t-sm"
                    style={{
                      // A floor of 2px so a genuinely tiny (or zero) rate on
                      // real volume still draws SOMETHING — its bar being
                      // invisible is how a 0% month gets mistaken for a gap.
                      height: Math.max(2, Math.round((rate / scaleMaxBps) * CHART_HEIGHT)),
                      backgroundColor: isPartial ? "transparent" : GOLD,
                      borderWidth: isPartial ? 1.5 : 0,
                      borderColor: GOLD,
                      borderStyle: isPartial ? "dashed" : "solid",
                    }}
                  />
                )}
              </View>
            );
          })}
        </View>
      </View>

      <View className="mt-1.5 flex-row items-center justify-between gap-1.5">
        {months.map((m) => (
          <Text
            key={m.month}
            className={`flex-1 text-center text-2xs ${m.effectiveRateBps == null ? "text-faint" : "text-muted"}`}
          >
            {MONTH_ABBR[m.month - 1]}
          </Text>
        ))}
      </View>

      {hasGap ? (
        <View className="mt-2 flex-row items-center gap-1.5">
          <View style={{ width: 12, height: 2, backgroundColor: colors.faint }} />
          <Text className="text-2xs text-muted">
            No volume processed — no rate, not a rate of zero
          </Text>
        </View>
      ) : null}

      {partialMonth != null ? (
        <View className="mt-1 flex-row items-center gap-1.5">
          <View
            style={{
              width: 12,
              height: 6,
              borderWidth: 1.5,
              borderStyle: "dashed",
              borderColor: GOLD,
              backgroundColor: GOLD_DIM,
            }}
          />
          <Text className="text-2xs text-muted">
            {MONTH_ABBR[partialMonth - 1]} is still accruing
          </Text>
        </View>
      ) : null}
    </View>
  );
}
