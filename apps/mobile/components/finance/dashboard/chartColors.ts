/**
 * Chart-only accent colors for the DASH-2 "command center" chapter dashboard
 * (spend-by-month bars, sparklines, "Where it went" category bars).
 *
 * The mockup calls for "one gold hue" distinct from BOTH the brand accent
 * (`colors.accent`, which is also `colors.danger` — the same red — see
 * `lib/theme.ts`) and the amber used for the cap reference line / meter warn
 * band (`colors.warn`). `lib/theme.ts` has no such token today, and adding
 * one is a shared-design-token decision outside this PR's file ownership
 * (`ChapterView.tsx` + new files under `dashboard/` only) — so it lives here,
 * scoped to the new chart components, with a flag to fold it into
 * `lib/theme.ts` if the command-center look sticks.
 */
export const GOLD = "#C08A2E";
/** ~22% alpha of `GOLD` — dimmed/unselected bar fill. */
export const GOLD_DIM = "#C08A2E38";
