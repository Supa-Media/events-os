/**
 * DASH-2 "Where it went" panel — top categories by actual spend, derived
 * CLIENT-SIDE from data `dashboardChapter` already returns (this PR's
 * ownership excludes adding a new Convex query — see the brief). There's no
 * chapter-wide "spend by category, this period" rollup anywhere in the
 * backend today; the closest available data is each budget CARD's own
 * `categories` breakdown (`oneTimeBudgets[].categories` /
 * `recurringBudgets[].categories`, already returned per-card for the
 * always-open category mini-bars this PR folds behind a row-expand chevron
 * instead) — so this sums those breakdowns by category NAME.
 *
 * MODE-AWARE (fixed after adversarial review — this panel must never
 * contradict the "Spent" KPI tile rendered right above it):
 *  - a ONE-TIME (event/project) budget's `categories` breakdown is
 *    CUMULATIVE / all-time, not sliced to the dashboard's selected period —
 *    see `finances.ts`'s `oneTimeCardBreakdown` doc comment ("Bug 1b: the
 *    card's OWN bar stays CUMULATIVE ... even though its VISIBILITY is
 *    month-gated").
 *  - a RECURRING budget's `categories` breakdown IS period-scoped.
 * In `"month"` mode, mixing the two would total many multiples of the
 * single-month "Spent" KPI with no user-facing qualifier — so month mode
 * sums ONLY recurring (period-scoped) categories and the caller renders the
 * "recurring spend by category — event budgets excluded" caption. In
 * `"ytd"` mode, one-time budgets' cumulative-to-date categories are a
 * reasonable approximation of their year-to-date contribution, so both
 * sources are included and the caller renders the "· YTD" caption.
 */
export type CategorySlice = { name: string; spentCents: number };
export type CategoryRollupMode = "month" | "ytd";
export type CategoryRollupResult = {
  /** Top `topN` categories, sorted by spend descending. */
  top: CategorySlice[];
  /** `max(0, periodSpendCents - sum(every categorized dollar this rollup found))` —
   *  rendered as the "Other + uncoded" muted-fill row. This clamp is ONLY
   *  for the residual-rounding/uncategorized-spend case (both sides are now
   *  computed from the same mode's data, so they should already roughly
   *  agree) — it must never be relied on to paper over a period mismatch;
   *  that's handled by scoping `cards` to `mode` above instead. */
  otherCents: number;
  /** The largest single value across `top` + `otherCents` — the bar chart's
   *  100%-width reference (never 0, so a single-category chapter still
   *  renders a sane bar). */
  maxCents: number;
  /** User-facing qualifier for the panel — MUST be rendered next to the
   *  title so the figures below never look silently mismatched with the
   *  "Spent" KPI. */
  caption: string;
};

export function categoryRollup(
  oneTimeCards: { categories?: CategorySlice[] | null }[],
  recurringCards: { categories?: CategorySlice[] | null }[],
  periodSpendCents: number,
  mode: CategoryRollupMode,
  topN = 6,
): CategoryRollupResult {
  const cards = mode === "month" ? recurringCards : [...oneTimeCards, ...recurringCards];
  const byName = new Map<string, number>();
  for (const card of cards) {
    for (const c of card.categories ?? []) {
      byName.set(c.name, (byName.get(c.name) ?? 0) + c.spentCents);
    }
  }
  const sorted = [...byName.entries()]
    .map(([name, spentCents]) => ({ name, spentCents }))
    .sort((a, b) => b.spentCents - a.spentCents);
  const top = sorted.slice(0, topN);
  const categorizedCents = sorted.reduce((s, c) => s + c.spentCents, 0);
  const otherCents = Math.max(0, periodSpendCents - categorizedCents);
  const maxCents = Math.max(1, ...top.map((c) => c.spentCents), otherCents);
  const caption =
    mode === "month"
      ? "Recurring spend by category — event budgets excluded"
      : "Spend by category · YTD";
  return { top, otherCents, maxCents, caption };
}
