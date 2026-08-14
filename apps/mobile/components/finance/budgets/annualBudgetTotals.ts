/**
 * WHAT THE WHOLE YEAR COMES TO — the Budgets tab's headline, across every
 * budget on the page, one-time and standing alike. Pure, so the arithmetic
 * behind the biggest number on the screen is testable without a
 * `react-native` import (same split as `recurringPeriodSummary`, next door).
 *
 * Founder, 2026-08-14: "the numbers do not add up… Love Thy Neighbor 5,000,
 * Field Day 2,000, that's 7,000 already. The operating expenses alone is 500 a
 * month, so this year that's 6,000 dollars. We're not adding up all the
 * budgeted items, and same thing for how much we spent. The top is just false."
 *
 * They were right, and the previous reasoning is worth recording because it
 * was WRONG IN AN INTERESTING WAY. The strip used to cover one-time budgets
 * only, on the grounds that a lifetime event cap and a per-month bucket cap
 * are different units and adding them produces a figure describing nothing.
 * The units observation is true. The conclusion — drop the standing buckets —
 * is not: it answers a units problem by amputation, and leaves a headline that
 * silently means "some of your budgets" while looking like "your budgets".
 *
 * ── THE COMMON UNIT IS THE YEAR ─────────────────────────────────────────────
 * The page is already scoped to one year; the year picker is the whole frame.
 * So convert instead of dropping. A $500-a-month bucket is a $6,000 commitment
 * for 2026, exactly as a $5,000 event budget is a $5,000 commitment for 2026.
 * Once every cap is annualised they are the same kind of number and the sum is
 * the real answer to "what did we commit this year, and how much of it is
 * gone".
 *
 * ── WHAT GETS ANNUALISED, AND WHAT MUST NOT ─────────────────────────────────
 * CAPS are annualised: a cadence cap times the year's window count
 * (`windowsPerYear`). SPEND IS NEVER ANNUALISED — it is money that actually
 * left the account, summed over the windows that have already happened. The
 * server pads a recurring row's `periods` with PROJECTED windows (an average
 * of the completed ones) to draw the faded forecast bars; those are excluded
 * here, via the same `recurringPeriodSummary` the cards use. A projection
 * reaching this strip would tell a chapter it had spent money it hasn't —
 * which is the exact failure `recurringPeriodSummary`'s own doc was written to
 * prevent, and the reason this file reuses it rather than re-summing
 * `periods`.
 *
 * A recurring row's own `capCents`/`spentCents` are CURRENT-WINDOW figures
 * (August's $500 and August's $244.21), which is right for the card header and
 * wrong for a year total — so they are used only for a cadence with no
 * `periods` array, where the window already IS the year. See `yearlyFor`.
 */

import { recurringPeriodSummary, type PeriodState } from "./recurringPeriodSummary";

/** A `budgetsGlance` row, narrowed to what the year total needs. `periods` is
 *  present only for a repeating cadence the server charts (monthly/quarterly);
 *  a one-time budget and a yearly bucket both arrive without one. */
export type AnnualRowLike = {
  cadence: string;
  capCents: number;
  spentCents: number;
  periods?: { spentCents: number; state: PeriodState }[] | null;
};

export type AnnualTotals = {
  /** Every cap on the page, expressed as dollars committed for this year. */
  capCents: number;
  /** Money that has actually moved. Never includes a projected window. */
  spentCents: number;
  /** `capCents - spentCents`; negative means over. */
  remainingCents: number;
  /** How many budgets are behind the figure, so the headline can say what it
   *  counted rather than leaving the reader to trust it. */
  count: number;
};

/**
 * One budget's contribution to the year, as `{ capCents, spentCents }`.
 *
 * A row WITHOUT `periods` contributes its own two figures unchanged. That
 * covers both cases where nothing needs converting: a one-time budget (whose
 * cap is a whole plan and whose spend the server already sums lifetime), and a
 * `yearly` bucket (whose single window IS the year). Guarding on the presence
 * of `periods` rather than on `cadence === "yearly"` also means an unexpected
 * cadence degrades to its own numbers instead of being silently multiplied by
 * a window count that doesn't apply to it.
 */
function yearlyFor(row: AnnualRowLike): { capCents: number; spentCents: number } {
  const periods = row.periods;
  if (!periods || periods.length === 0) {
    return { capCents: row.capCents, spentCents: row.spentCents };
  }
  const { yearCapCents, spentToDateCents } = recurringPeriodSummary(
    periods,
    row.capCents,
    row.cadence,
  );
  return { capCents: yearCapCents, spentCents: spentToDateCents };
}

/**
 * The year's totals across every budget handed in.
 *
 * Callers pass the rows the page is actually RENDERING (post-filter,
 * post-search), so the headline stays the visible sum of the cards beneath it
 * — the same contract the strip has always had, now over both sections
 * instead of one.
 */
export function annualBudgetTotals(rows: AnnualRowLike[]): AnnualTotals {
  let capCents = 0;
  let spentCents = 0;
  for (const row of rows) {
    const year = yearlyFor(row);
    capCents += year.capCents;
    spentCents += year.spentCents;
  }
  return {
    capCents,
    spentCents,
    remainingCents: capCents - spentCents,
    count: rows.length,
  };
}
