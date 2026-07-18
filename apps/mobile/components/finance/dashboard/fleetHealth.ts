/**
 * DASH-3 "Chapters at a glance" fleet panel — the health-chip VERDICT for a
 * `dashboardCharts.chapterHealth` row, derived CLIENT-side from the raw
 * signals the query returns (mirrors `meterTone.ts`'s precedent: the server
 * sends numbers, the client picks the verdict/tone).
 *
 * Precedence (owner brief): a chapter genuinely under water on affordability
 * outranks a plain "something needs coding" nudge — `underWaterCents > 0`
 * wins over unattributed/over-budget. Central's own row never has an
 * affordability figure (`underWaterCents` is always `null` there — see
 * `chapterHealth`'s doc comment), so it can only ever land on "needs
 * attention" or "healthy".
 *
 * Dependency-free (no `react-native` import) so it's unit-testable directly
 * under this package's jest config — mirrors `meterTone.ts`/`awaitingApproval.ts`.
 */
export type FleetHealthKind = "under_water" | "needs_attention" | "healthy";
export type FleetHealthTone = "danger" | "warn" | "success";

export const FLEET_HEALTH_TONE: Record<FleetHealthKind, FleetHealthTone> = {
  under_water: "danger",
  needs_attention: "warn",
  healthy: "success",
};

export function fleetHealthKind(row: {
  underWaterCents: number | null;
  unattributedCount: number;
  spendYtdCents: number;
  budgetYtdCents: number;
}): FleetHealthKind {
  if ((row.underWaterCents ?? 0) > 0) return "under_water";
  const overBudget = row.budgetYtdCents > 0 && row.spendYtdCents > row.budgetYtdCents;
  if (row.unattributedCount > 0 || overBudget) return "needs_attention";
  return "healthy";
}

/**
 * A row's spend-of-budget percentage for its `Meter` — mirrors
 * `finances.ts`'s own (unexported) `pctOf`: a $0 budget with real spend
 * reports 100% (unfunded-and-overspent, loud), a $0 budget with no spend
 * reports 0%. Uncapped (a `Meter` clamps its own fill width; `meterTone`
 * treats anything over 100 as red).
 */
export function fleetBudgetPct(spendYtdCents: number, budgetYtdCents: number): number {
  if (budgetYtdCents <= 0) return spendYtdCents > 0 ? 100 : 0;
  return Math.round((spendYtdCents / budgetYtdCents) * 100);
}
