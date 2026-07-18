/**
 * DASH-3 "Chapters at a glance" fleet panel — a compact "$9.1k" money format
 * for the fleet row's cramped budget-health column ("$9.1k/$9.7k"), where the
 * app's normal `formatCents` ("$9,142.50") would overflow a dense row.
 *
 * Dependency-free (no `react-native` import) so it's unit-testable directly
 * under this package's jest config — mirrors `meterTone.ts`/`awaitingApproval.ts`'s
 * own precedent for the same reason. Deliberately local to this dir rather
 * than added to `@events-os/shared#formatCents` (a shared-package change is
 * outside this PR's file ownership — CentralView.tsx / ChapterFleet.tsx +
 * their own new helpers only).
 */
import { formatCents } from "@events-os/shared";

/**
 * Whole dollars under $1,000 print via the normal `formatCents` (no cents,
 * e.g. "$500"); $1,000 and up print as "$N.Nk" (one decimal, e.g. "$9.1k",
 * "$12.0k"). Negative amounts keep the sign in front of the `$` ("-$1.2k") —
 * money in this app is never actually negative (integer cents + a separate
 * `flow`), but this keeps the formatter total rather than asserting on input.
 */
export function compactCents(cents: number): string {
  const dollars = cents / 100;
  const abs = Math.abs(dollars);
  if (abs < 1000) return formatCents(cents, { showCents: false });
  const sign = dollars < 0 ? "-" : "";
  return `${sign}$${(abs / 1000).toFixed(1)}k`;
}
