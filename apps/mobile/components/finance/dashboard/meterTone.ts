/**
 * DASH-2 "Meter semantics everywhere" — the ONE spent-of-cap color rule the
 * whole command-center dashboard shares (status dots, slim meters, the
 * Events/Recurring row treatment): gold 0-85%, amber 85-100%, red only
 * >100% (paired with an "over" chip in the UI layer). Kills the old
 * per-surface guessing (`finances.ts`'s server-side `statusFor` used an
 * 80% ok/warn split with no distinct "over" tier — this is a DELIBERATELY
 * different, client-only threshold for the new dense rows/meters; the older
 * `BudgetBar` in `parts.tsx` — still used by `CentralView.tsx` and this
 * file's own untouched siblings — keeps its own thresholds unchanged).
 *
 * A standalone, dependency-free (no `react-native` import) module so it can
 * be unit-tested directly under this package's jest config — mirrors
 * `awaitingApproval.ts`'s own precedent for the same reason.
 */
export type MeterTone = "gold" | "amber" | "red";

export function meterTone(pct: number): MeterTone {
  if (pct > 100) return "red";
  if (pct >= 85) return "amber";
  return "gold";
}

/** The meter's fill width — clamped to 0-100 (a >100% pct still fills the
 *  bar fully; the "over" chip carries the real number). */
export function meterFillWidthPct(pct: number): number {
  return Math.max(0, Math.min(100, pct));
}
