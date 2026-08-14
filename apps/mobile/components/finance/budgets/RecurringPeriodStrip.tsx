/**
 * BUDGETS · a recurring bucket's YEAR, window by window.
 *
 * Founder, 2026-08-14: "for the recurring budgets, I want to see smaller
 * chunks with all the past budgets — for example since we are in Q3, show me
 * Q1 and Q2 and Q3 for the quarterly; if we are in the 7th month, show me all
 * past months; maybe even show all and predict how much we will spend based on
 * previous spending (maybe highlight a different color). For the yearly
 * budgets it's fine because obviously each page is a year."
 *
 * The card's headline answers the swipe-time question — "have I got room right
 * now" — and deliberately still does. What it can't answer is the one this
 * chart exists for: is $222 of $500 a normal month for Operating Expenses, or
 * the cheapest one all year? A single window has no answer; the windows side
 * by side are the answer.
 *
 * ── WHY PROJECTED BARS LOOK DIFFERENT, NOT JUST LIGHTER ──────────────────────
 * The dim bars past the current window are NOT spend. They're the average of
 * the COMPLETED windows carried forward, and if they read as the same kind of
 * mark as the solid ones, this chart quietly asserts that money was spent in
 * November. So they get their own fill (`GOLD_DIM`), a dashed cap line above
 * the group, their own legend, and their own label in the summary line —
 * "on track for", never "spent". Four separate tells, because color alone is
 * not one for a reader who can't distinguish these two hues.
 *
 * The server sends no projected windows at all when it has nothing to average
 * from (see `recurringPeriodRows`), so an empty January can't project a year
 * of zeroes.
 */
import { Text, View } from "react-native";
import { formatCents } from "@events-os/shared";
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import { colors } from "../../../lib/theme";
import { GOLD, GOLD_DIM } from "../dashboard/chartColors";
import { chartScaleMaxCents, heightPct } from "../dashboard/monthBarsGeometry";
import { meterTone } from "../dashboard/meterTone";
import { recurringPeriodSummary } from "./recurringPeriodSummary";

type GlanceRow = FunctionReturnType<
  typeof api.finances.budgetsGlance
>["recurring"][number];
type Period = NonNullable<GlanceRow["periods"]>[number];

const CHART_HEIGHT = 56;

/** A real window's fill follows the SAME meter tone the card's own bar uses,
 *  so a window that ran over is red here and red there. */
const TONE_COLOR: Record<string, string> = {
  gold: GOLD,
  amber: colors.warn,
  red: colors.danger,
};

export function RecurringPeriodStrip({
  periods,
  cadence,
  capCents,
}: {
  periods: Period[];
  cadence: string;
  capCents: number;
}) {
  if (periods.length === 0) return null;

  const {
    spentToDateCents,
    projectedYearCents,
    yearCapCents,
    elapsedCount,
    projectedCount,
    completedCount,
    overYearCents,
  } = recurringPeriodSummary(periods, capCents, cadence);
  const unit = cadence === "quarterly" ? "quarter" : "month";
  const units = `${unit}s`;

  // The cap line shares the bars' scale, so "over the line" means over cap.
  const scaleMax = chartScaleMaxCents(
    periods.map((p) => p.spentCents),
    capCents,
  );
  const capPct = heightPct(capCents, scaleMax);

  return (
    <View className="gap-2 border-t border-border px-3 py-3">
      <View className="flex-row items-baseline justify-between gap-2">
        <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
          {cadence === "quarterly" ? "By quarter" : "By month"}
        </Text>
        <Text className="text-2xs text-muted">
          {formatCents(capCents)} each
        </Text>
      </View>

      {/* ── The bars ────────────────────────────────────────────────────── */}
      <View className="flex-row items-end gap-1" style={{ height: CHART_HEIGHT }}>
        {periods.map((p) => (
          <PeriodBar key={p.key} period={p} scaleMax={scaleMax} capPct={capPct} />
        ))}
      </View>
      <View className="flex-row gap-1">
        {periods.map((p) => (
          <Text
            key={p.key}
            className={`flex-1 text-center text-2xs ${
              p.state === "current" ? "font-bold text-ink" : "text-faint"
            }`}
            numberOfLines={1}
          >
            {p.label}
          </Text>
        ))}
      </View>

      {/* ── What the bars add up to ─────────────────────────────────────── */}
      <View className="gap-0.5 pt-1">
        <Text className="text-xs text-muted">
          <Text className="font-semibold text-ink">
            {formatCents(spentToDateCents)}
          </Text>{" "}
          spent across {elapsedCount} {elapsedCount === 1 ? unit : units}
        </Text>
        {projectedCount > 0 ? (
          <>
            <Text className="text-xs text-muted">
              On track for{" "}
              <Text className="font-semibold text-ink">
                {formatCents(projectedYearCents)}
              </Text>{" "}
              of {formatCents(yearCapCents)} this year
              {overYearCents > 0 ? (
                <Text className="font-semibold text-danger">
                  {" "}
                  · {formatCents(overYearCents)} over
                </Text>
              ) : null}
            </Text>
            <Text className="text-2xs text-faint">
              Faded bars are an estimate from the {completedCount} completed{" "}
              {completedCount === 1 ? unit : units}, not spend.
            </Text>
          </>
        ) : null}
      </View>
    </View>
  );
}

/** One window. A hairline cap reference sits at the cadence cap's height, so a
 *  bar poking above it reads as over budget without needing a number. */
function PeriodBar({
  period,
  scaleMax,
  capPct,
}: {
  period: Period;
  scaleMax: number;
  capPct: number;
}) {
  const isProjected = period.state === "projected";
  const barPct = heightPct(period.spentCents, scaleMax);
  const fill = isProjected ? GOLD_DIM : TONE_COLOR[meterTone(period.pct)] ?? GOLD;

  return (
    <View
      className="flex-1 justify-end"
      style={{ height: "100%" }}
      accessibilityRole="text"
      accessibilityLabel={
        isProjected
          ? `${period.label}, projected ${formatCents(period.spentCents)} of ${formatCents(period.capCents)}`
          : `${period.label}, ${formatCents(period.spentCents)} of ${formatCents(period.capCents)} spent`
      }
    >
      {/* Cap reference — drawn behind the bar, full width of the column. */}
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: `${capPct}%`,
          borderTopWidth: 1,
          borderTopColor: colors.borderStrong,
          borderStyle: "dashed",
        }}
      />
      <View
        className="w-full rounded-pill"
        style={{
          height: `${Math.max(barPct, period.spentCents > 0 ? 2 : 0)}%`,
          backgroundColor: fill,
          minHeight: period.spentCents > 0 ? 2 : 0,
        }}
      />
      {/* An empty window still needs a floor, or the column reads as missing
          rather than as zero. */}
      {period.spentCents === 0 ? (
        <View
          className="w-full rounded-pill"
          style={{ height: 2, backgroundColor: colors.border }}
        />
      ) : null}
    </View>
  );
}
