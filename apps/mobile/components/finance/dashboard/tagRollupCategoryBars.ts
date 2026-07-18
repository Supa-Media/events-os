/**
 * DASH-3 "Where it went" panel, org-wide. `CategoryBars` (DASH-2) renders any
 * named-slice rollup — it has no idea whether a slice is a literal spend
 * CATEGORY or something else. `dashboardCentral` has no org-wide category
 * breakdown at all (only chapter-scoped budget cards carry `categories`, and
 * `dashboardCentral`'s own central-budget cards don't return one either — see
 * `centralBudgetCard`'s validator in `finances.ts`), and adding one is a new
 * Convex query/field, outside this PR's file ownership (CentralView.tsx /
 * ChapterFleet.tsx + their own new helpers only — no convex files touched).
 *
 * DELIBERATE SUBSTITUTION (flagged in the PR description, not silent): this
 * reshapes `dashboardCentral`'s existing org-wide `tagRollups` — already
 * spend>0-filtered and sorted desc server-side — into `CategoryRollupResult`'s
 * shape instead. It's the closest already-available "where did org money go"
 * breakdown, and it's honest about what it is: the caption always reads
 * "... by tag", never "by category", so this never contradicts DASH-2's own
 * chapter-level "Where it went" panel (which really is category-based) sitting
 * one drill-down away.
 */
import type { CategoryRollupResult } from "./categoryRollup";

export type TagRollupSlice = { tagName: string; spentCents: number };

export function tagRollupCategoryBars(
  tagRollups: TagRollupSlice[],
  periodSpendCents: number,
  mode: "month" | "ytd",
  topN = 6,
): CategoryRollupResult {
  const top = tagRollups.slice(0, topN).map((t) => ({ name: t.tagName, spentCents: t.spentCents }));
  const taggedCents = tagRollups.reduce((s, t) => s + t.spentCents, 0);
  const otherCents = Math.max(0, periodSpendCents - taggedCents);
  const maxCents = Math.max(1, ...top.map((c) => c.spentCents), otherCents);
  const caption = mode === "month" ? "Spend by tag" : "Spend by tag · YTD";
  return { top, otherCents, maxCents, caption };
}
