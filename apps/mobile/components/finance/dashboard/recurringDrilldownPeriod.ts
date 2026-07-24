/**
 * DASH-2.1 UI fix (review finding #1 — "drill must sum to the tapped bar"):
 * a recurring budget's own category mini-bars widen to the budget's effective
 * period in month mode (`finances.ts#budgetEffectivePeriod`, via
 * `txnCountsTowardBudgetDash`) — monthly cadence stays scoped to one month,
 * but quarterly widens to the whole quarter and yearly to the whole year,
 * regardless of which single month the dashboard is showing. A transactions
 * drill-down that only ever requested one month under-summed vs. that wider
 * bar. This returns the SAME widened period for `dashboardCharts.
 * budgetTransactions` to request (mirrors `budgetEffectivePeriod`'s own
 * switch, not re-deriving it — a budget with a FIXED `quarter` narrower than
 * `contextMonth`'s own quarter would only be VISIBLE on this dashboard when
 * they already agree — see that function's doc comment for why
 * `quarterOfMonth(month)` is always correct here). YTD mode already reads the
 * whole year for every cadence (the group-level `drilldownPeriod` omits
 * `month` entirely there), so this only changes month-mode behavior.
 *
 * Extracted from `ChapterView` (projects-category-breakdown) so `CentralView`'s
 * recurring central-budget rows get the identical widening — the central
 * cards' `spentCents`/mini-bars use the same `txnCountsTowardBudgetDash` rule.
 */
import { quarterOfMonth } from "@events-os/shared";
import type { DashPeriodMode } from "./parts";
import type { DrilldownPeriod } from "./BudgetTable";

export function recurringDrilldownPeriod(
  cadence: "monthly" | "quarterly" | "yearly",
  year: number,
  month: number,
  mode: DashPeriodMode,
): DrilldownPeriod {
  if (mode !== "month") return { year };
  switch (cadence) {
    case "quarterly":
      return { year, quarter: quarterOfMonth(month), rangeNote: "this quarter" };
    case "yearly":
      return { year, rangeNote: "this year" };
    case "monthly":
    default:
      return { year, month };
  }
}
