/**
 * "Blended fee rate" chart — pure scale + formatting helpers, split out from
 * `FeeRateBars.tsx` for the same reason `monthBarsGeometry.ts` was split out of
 * `MonthBars.tsx`: the edge cases here are all about ABSENCE, and absence is
 * exactly what a rendered component makes hard to assert on.
 *
 * A rate series is nullable in a way a spend series never is — a month that
 * processed nothing has no rate at all (see
 * `@events-os/shared#effectiveRateBps`). Both functions below therefore have to
 * say what they do with `null`, and the tests pin it.
 */

/**
 * The chart's 0-100% scale, in basis points: the largest rate with ~15%
 * headroom so the tallest bar never touches the top edge — the same headroom
 * `chartScaleMaxCents` uses, so the two charts stacked in the same column read
 * as one family.
 *
 * `null` months are SKIPPED, not treated as zero. They contribute no height, so
 * they must contribute no scale either; a series of one 3% month and eleven
 * gaps scales to that 3% month.
 *
 * Floored at 100bps (1%) so a series that is entirely gaps still has a real
 * axis to draw a baseline against instead of dividing by zero.
 */
export function rateScaleMaxBps(rates: (number | null)[]): number {
  const maxRate = rates.reduce<number>((m, r) => (r == null ? m : Math.max(m, r)), 0);
  return Math.max(100, Math.round(maxRate * 1.15));
}

/**
 * `294` → `"2.94%"`. Two decimals, always — a blended rate moves in hundredths
 * of a percent and the whole point of the monitor is noticing 2.90% become
 * 3.05%. Rounding to `3%` would erase the signal it exists to show.
 */
export function formatRateBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}
