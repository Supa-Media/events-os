/**
 * DASH-2 "Spend by month" bar chart — pure geometry helpers (bar/cap-line
 * heights as percentages of the chart's own scale), split out from
 * `MonthBars.tsx` so the edge cases (an all-zero year, a cap bigger than
 * every bar, a zero cap) are unit-testable without a `react-native` import.
 */

/** The chart's 0-100% scale: the largest bar OR the cap line, with ~15%
 *  headroom so the tallest element never touches the top edge. Floored at 1
 *  cent so a totally empty year never divides by zero. */
export function chartScaleMaxCents(
  spendCents: number[],
  capCentsPerMonth: number | null,
): number {
  const maxSpend = spendCents.reduce((m, c) => Math.max(m, c), 0);
  const maxWithCap = Math.max(maxSpend, capCentsPerMonth ?? 0);
  return Math.max(1, Math.round(maxWithCap * 1.15));
}

/** A value's height as a percentage of the chart's scale, clamped to
 *  [0, 100]. */
export function heightPct(valueCents: number, scaleMaxCents: number): number {
  if (scaleMaxCents <= 0) return 0;
  return Math.max(0, Math.min(100, (valueCents / scaleMaxCents) * 100));
}
