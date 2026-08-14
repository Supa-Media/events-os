/**
 * What a recurring bucket's window strip ADDS UP TO — pure, so the arithmetic
 * that the summary line asserts out loud ("$X spent across N months, on track
 * for $Y of $Z") is testable without a `react-native` import.
 *
 * The split matters more here than in most charts because these are two
 * different KINDS of number sitting in one sentence. `spentToDateCents` is
 * money that left the account. `projectedYearCents` includes windows that
 * haven't happened. Getting the boundary wrong doesn't produce a wrong-looking
 * chart — it produces a confident sentence claiming the chapter has spent
 * money it hasn't.
 */

export type PeriodState = "past" | "current" | "projected";

export type PeriodLike = {
  spentCents: number;
  state: PeriodState;
};

/** How many windows a cadence has in a year. The periods array can't supply
 *  this: it stops at the current window whenever the projection is withheld. */
export function windowsPerYear(cadence: string, fallback: number): number {
  if (cadence === "monthly") return 12;
  if (cadence === "quarterly") return 4;
  return fallback;
}

export function recurringPeriodSummary(
  periods: PeriodLike[],
  capCents: number,
  cadence: string,
): {
  /** Real money, elapsed windows only — never includes a projected window. */
  spentToDateCents: number;
  /** Elapsed spend PLUS the projected windows. Equals `spentToDateCents`
   *  exactly when nothing is projected, which is what makes it safe to render
   *  the "on track for" line only when `projectedCount > 0`. */
  projectedYearCents: number;
  /** The cadence cap times the year's window count — the denominator the
   *  projection is judged against. */
  yearCapCents: number;
  elapsedCount: number;
  projectedCount: number;
  /** Windows that have FINISHED — the projection's own sample. One less than
   *  `elapsedCount` whenever a current window is present, which it always is
   *  for a live year. */
  completedCount: number;
  /** Positive only when the projection lands past the year's cap. */
  overYearCents: number;
} {
  const elapsed = periods.filter((p) => p.state !== "projected");
  const projected = periods.filter((p) => p.state === "projected");
  const spentToDateCents = elapsed.reduce((s, p) => s + p.spentCents, 0);
  const projectedYearCents =
    spentToDateCents + projected.reduce((s, p) => s + p.spentCents, 0);
  const yearCapCents = capCents * windowsPerYear(cadence, periods.length);
  return {
    spentToDateCents,
    projectedYearCents,
    yearCapCents,
    elapsedCount: elapsed.length,
    projectedCount: projected.length,
    completedCount: elapsed.filter((p) => p.state === "past").length,
    overYearCents: Math.max(0, projectedYearCents - yearCapCents),
  };
}
