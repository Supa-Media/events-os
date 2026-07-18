/**
 * DASH-2 "Where it went" panel — top categories by actual spend, derived
 * CLIENT-SIDE from data `dashboardChapter` already returns (this PR's
 * ownership excludes adding a new Convex query — see the brief). There's no
 * chapter-wide "spend by category, this period" rollup anywhere in the
 * backend today; the closest available data is each budget CARD's own
 * `categories` breakdown (`oneTimeBudgets[].categories` /
 * `recurringBudgets[].categories`, already returned per-card for the
 * always-open category mini-bars this PR folds behind a row-expand chevron
 * instead) — so this sums those breakdowns by category NAME across every
 * card on the dashboard.
 *
 * DOCUMENTED LIMITATION: a ONE-TIME (event/project) budget's `categories`
 * breakdown is CUMULATIVE / all-time, not sliced to the dashboard's selected
 * period — see `finances.ts`'s `oneTimeCardBreakdown` doc comment ("Bug 1b:
 * the card's OWN bar stays CUMULATIVE ... even though its VISIBILITY is
 * month-gated"). A RECURRING budget's `categories` breakdown IS period-
 * scoped. So this rollup mixes a period-accurate figure (recurring) with an
 * all-time one (one-time) — the best available without a new query. Because
 * of that mismatch, `otherCents` (the period spend this rollup can't explain
 * with a per-budget category) is clamped at 0 rather than ever going
 * negative when the one-time cumulative total exceeds the period total.
 */
export type CategorySlice = { name: string; spentCents: number };
export type CategoryRollupResult = {
  /** Top `topN` categories, sorted by spend descending. */
  top: CategorySlice[];
  /** `max(0, periodSpendCents - sum(every categorized dollar this rollup found))` —
   *  rendered as the "Other + uncoded" muted-fill row. */
  otherCents: number;
  /** The largest single value across `top` + `otherCents` — the bar chart's
   *  100%-width reference (never 0, so a single-category chapter still
   *  renders a sane bar). */
  maxCents: number;
};

export function categoryRollup(
  cardsWithCategories: { categories?: CategorySlice[] | null }[],
  periodSpendCents: number,
  topN = 6,
): CategoryRollupResult {
  const byName = new Map<string, number>();
  for (const card of cardsWithCategories) {
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
  return { top, otherCents, maxCents };
}
