/**
 * BUDGETS · a recurring bucket's YEAR, window by window.
 *
 * Founder, 2026-08-14: "for the recurring budgets, I want to see smaller
 * chunks with all the past budgets — since we are in Q3, show me Q1 and Q2 and
 * Q3 for the quarterly; if we are in the 7th month, show me all past months;
 * maybe even show all and predict how much we will spend based on previous
 * spending (maybe highlight a different color). For the yearly budgets it's
 * fine because obviously each page is a year."
 *
 * Then, on seeing it: "surface some sort of amount for the other months
 * without expanding, and when expanding make the graph interactive."
 *
 * So it comes in two sizes, from one set of bars:
 *
 *  - COMPACT lives on the COLLAPSED card, under the meter. No header, no
 *    summary, no press targets — just the year's shape and a one-line total,
 *    so "is $222 a normal month" is answerable without opening anything.
 *    It sits inside the card's own header `Pressable`, which is why nothing in
 *    it is pressable: a tap anywhere on it still opens the card.
 *  - FULL lives in the drawer, and every bar is a button. Selecting one asks
 *    the server for THAT window's charges (`budgetGlance.expenses`'s `month`
 *    arg) — the drawer below re-reads, so tapping March produces March's
 *    charges rather than a client-side filter of this month's.
 *
 * ── WHY PROJECTED BARS LOOK DIFFERENT, NOT JUST LIGHTER ──────────────────────
 * The dim bars past the current window are NOT spend. They're the average of
 * the COMPLETED windows carried forward, and if they read as the same kind of
 * mark as the solid ones, this chart quietly asserts that money was spent in
 * November. So they get their own fill (`GOLD_DIM`), a dashed cap line above
 * the group, their own wording in the summary — "on track for", never "spent"
 * — and they are not selectable, because there are no charges behind a
 * forecast. Four separate tells, because color alone is not one for a reader
 * who can't distinguish these two hues.
 *
 * The server sends no projected windows at all when it has nothing to average
 * from (see `recurringPeriodRows`), so an empty January can't project a year
 * of zeroes.
 */
import { Pressable, Text, View } from "react-native";
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
export type RecurringPeriod = NonNullable<GlanceRow["periods"]>[number];

/** A real window's fill follows the SAME meter tone the card's own bar uses,
 *  so a window that ran over is red here and red there. */
const TONE_COLOR: Record<string, string> = {
  gold: GOLD,
  amber: colors.warn,
  red: colors.danger,
};

/**
 * The bars themselves, at either size. Shared so the collapsed card and the
 * drawer can never disagree about the shape of the year.
 */
function PeriodBars({
  periods,
  capCents,
  height,
  selectedKey,
  onSelect,
}: {
  periods: RecurringPeriod[];
  capCents: number;
  height: number;
  /** Interactive only when both of these are given. */
  selectedKey?: string | null;
  onSelect?: (period: RecurringPeriod | null) => void;
}) {
  // The cap line shares the bars' scale, so "over the line" means over cap.
  const scaleMax = chartScaleMaxCents(
    periods.map((p) => p.spentCents),
    capCents,
  );
  const capPct = heightPct(capCents, scaleMax);

  return (
    <>
      <View className="flex-row items-end gap-1" style={{ height }}>
        {periods.map((p) => (
          <PeriodBar
            key={p.key}
            period={p}
            scaleMax={scaleMax}
            capPct={capPct}
            selected={selectedKey === p.key}
            onSelect={onSelect}
          />
        ))}
      </View>
      <View className="flex-row gap-1">
        {periods.map((p) => (
          <Text
            key={p.key}
            className={`flex-1 text-center text-2xs ${
              selectedKey === p.key
                ? "font-bold text-accent"
                : p.state === "current"
                  ? "font-bold text-ink"
                  : "text-faint"
            }`}
            numberOfLines={1}
          >
            {p.label}
          </Text>
        ))}
      </View>
    </>
  );
}

/**
 * The COMPACT strip for a collapsed card — the year's shape plus one number,
 * and nothing to press.
 */
export function CompactPeriodStrip({
  periods,
  cadence,
  capCents,
}: {
  periods: RecurringPeriod[];
  cadence: string;
  capCents: number;
}) {
  if (periods.length < 2) return null;
  const { spentToDateCents, elapsedCount } = recurringPeriodSummary(
    periods,
    capCents,
    cadence,
  );
  const unit = cadence === "quarterly" ? "quarter" : "month";
  return (
    <View className="mt-2.5 gap-1">
      <PeriodBars periods={periods} capCents={capCents} height={22} />
      <Text className="text-2xs text-muted">
        {formatCents(spentToDateCents)} across {elapsedCount}{" "}
        {elapsedCount === 1 ? unit : `${unit}s`} this year
      </Text>
    </View>
  );
}

/**
 * The FULL strip for the drawer — selectable bars plus what they add up to.
 */
export function RecurringPeriodStrip({
  periods,
  cadence,
  capCents,
  selected,
  onSelect,
}: {
  periods: RecurringPeriod[];
  cadence: string;
  capCents: number;
  selected: RecurringPeriod | null;
  onSelect: (period: RecurringPeriod | null) => void;
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

  return (
    <View className="gap-2 border-t border-border px-3 py-3">
      <View className="flex-row items-baseline justify-between gap-2">
        <Text className="text-2xs font-bold uppercase tracking-wider text-muted">
          {cadence === "quarterly" ? "By quarter" : "By month"}
        </Text>
        <Text className="text-2xs text-muted">{formatCents(capCents)} each</Text>
      </View>

      <PeriodBars
        periods={periods}
        capCents={capCents}
        height={56}
        selectedKey={selected?.key ?? null}
        onSelect={onSelect}
      />

      {/* ── What the bars add up to, or what one of them says ────────────── */}
      <View className="gap-0.5 pt-1">
        {selected ? (
          // A selected window speaks for itself, and says so loudly enough
          // that the charges below can't be mistaken for the whole year's.
          <View className="flex-row flex-wrap items-baseline gap-x-2 gap-y-1">
            <Text className="text-xs text-muted">
              <Text className="font-semibold text-ink">{selected.label}</Text>{" "}
              <Text className="font-semibold text-ink">
                {formatCents(selected.spentCents)}
              </Text>{" "}
              of {formatCents(selected.capCents)}
              {selected.spentCents > selected.capCents ? (
                <Text className="font-semibold text-danger">
                  {" "}
                  · {formatCents(selected.spentCents - selected.capCents)} over
                </Text>
              ) : (
                <Text className="text-success">
                  {" "}
                  · {formatCents(selected.capCents - selected.spentCents)} left
                </Text>
              )}
            </Text>
            <Pressable
              onPress={() => onSelect(null)}
              accessibilityRole="button"
              accessibilityLabel="Show the current window again"
              className="active:opacity-70"
            >
              <Text className="text-xs font-semibold text-accent">Clear</Text>
            </Pressable>
          </View>
        ) : (
          <Text className="text-xs text-muted">
            <Text className="font-semibold text-ink">
              {formatCents(spentToDateCents)}
            </Text>{" "}
            spent across {elapsedCount} {elapsedCount === 1 ? unit : units}
            {periods.length > 1 ? " · tap a bar for its charges" : ""}
          </Text>
        )}
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
  selected,
  onSelect,
}: {
  period: RecurringPeriod;
  scaleMax: number;
  capPct: number;
  selected: boolean;
  onSelect?: (period: RecurringPeriod | null) => void;
}) {
  const isProjected = period.state === "projected";
  const barPct = heightPct(period.spentCents, scaleMax);
  const fill = isProjected ? GOLD_DIM : TONE_COLOR[meterTone(period.pct)] ?? GOLD;
  // A forecast has no charges behind it, so there is nothing to select.
  const pressable = onSelect != null && !isProjected;
  const label = isProjected
    ? `${period.label}, projected ${formatCents(period.spentCents)} of ${formatCents(period.capCents)}`
    : `${period.label}, ${formatCents(period.spentCents)} of ${formatCents(period.capCents)} spent`;

  const body = (
    <>
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
          height: `${barPct}%`,
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
    </>
  );

  if (!pressable) {
    return (
      <View
        className="flex-1 justify-end"
        style={{ height: "100%" }}
        accessibilityRole="text"
        accessibilityLabel={label}
      >
        {body}
      </View>
    );
  }

  return (
    <Pressable
      onPress={() => onSelect?.(selected ? null : period)}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${label}. Tap for its charges.`}
      className={`flex-1 justify-end rounded-pill active:opacity-70 ${
        selected ? "bg-sunken" : ""
      }`}
      style={{ height: "100%" }}
    >
      {body}
    </Pressable>
  );
}
