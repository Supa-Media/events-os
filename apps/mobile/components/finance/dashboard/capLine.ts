/**
 * DASH-2 spend-by-month chart — the dashed "monthly operating cap" reference
 * line's cents figure.
 *
 * There's no single field anywhere the dashboard already queries named
 * "Operating Expenses monthly cap" — this PR's ownership excludes adding a
 * new Convex query (see the DASH-2 brief), so the cap is DERIVED from the
 * same `recurringBudgets` the KPI tiles and dense table already render:
 * every MONTHLY-cadence bucket's cap for the dashboard's CURRENTLY SELECTED
 * period, normalized to a single month (a YTD-mode sum is divided by the
 * through-month — `dashboardChapter`'s `budgetAllocationForDash` sums one
 * month-equivalent cap per elapsed month for an unrestricted monthly budget,
 * so dividing back out recovers the monthly figure).
 *
 * LIMITATION (documented per the brief): this reflects whichever monthly
 * buckets are ACTIVE IN THE SELECTED PERIOD, drawn FLAT across the whole
 * year's chart — not a true reconstruction of what the cap was in past
 * months (a bucket added, removed, or resized mid-year will misrepresent
 * months before/after that change). `null` when there are no monthly-cadence
 * buckets at all, OR when the monthly-cadence buckets that DO exist sum to
 * $0 — either way there's no meaningful cap to draw, so the caller renders
 * no dashed line and no "$0.00/mo" label rather than a misleading zero cap.
 */
export function monthlyOperatingCapCents(
  recurringBudgets: { cadence: string; budgetCents: number }[],
  period: "month" | "ytd",
  throughMonth: number,
): number | null {
  const monthly = recurringBudgets.filter((b) => b.cadence === "monthly");
  if (monthly.length === 0) return null;
  const sumCents = monthly.reduce((s, b) => s + b.budgetCents, 0);
  if (sumCents === 0) return null;
  const divisor = period === "ytd" ? Math.max(1, throughMonth) : 1;
  return Math.round(sumCents / divisor);
}
