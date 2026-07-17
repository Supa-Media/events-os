/**
 * WP-wave4 (item 6, owner addendum 2026-07-17) — NIT fix (opus review): the
 * exact trigger is `approvedCents === 0` (a budget whose OLD, still-in-force
 * approved cap was $0) WITH `status` `"submitted"` or `"draft"` — NOT "any
 * brand-new draft". A brand-new draft (created with a real starting amount —
 * see `finances.ts#createEventBudget`/`createProjectBudget`'s
 * `autoCreatedBudgetApprovalStatus`, or a hand-created one via
 * `finances.createBudget`) has `approvedCents: null` (it's never been
 * through a decision at all) and does NOT trigger this helper — its `pct`
 * against the real requested amount is already sane, nothing to fix. This
 * helper's real targets are: (a) a budget genuinely APPROVED at $0 that gets
 * raised (the literal-approved retrigger, `setBudgetAmount`), and (b) a
 * grandfathered OR auto-summoned $0 budget (`ensureBudgetForRef`'s
 * get-or-create — `approvedCents` absent, `approvalStatus` unset) that gets
 * its FIRST real amount entered (I1's grandfathered-first-increase rule) —
 * BOTH stamp `approvedCents` at the OLD $0 amount and flip to `"draft"` (a
 * draft increase), which is exactly when a card's `budgetCents` reports 0
 * while `spentCents`/`requestedCents` are real. Its `pct`/`status`
 * (server-computed against that $0 cap) then read "100% spent, danger"
 * purely from the unfunded-overspend rule — nonsense next to a real "$925 of
 * $1,500 requested" story. This helper detects exactly that shape and
 * re-derives a sane display (spend vs the REQUESTED amount, ok/warn — never
 * forced to the red $0-over state) — the RAW `pct`/`status` stay correct for
 * every other case (including a genuinely unfunded APPROVED $0 budget with
 * real spend, which must stay loud/red).
 *
 * A standalone, dependency-free (no `react-native` import) module so it can
 * be unit-tested directly under this package's jest config — `parts.tsx`
 * (which pulls in `react-native`) can't be imported from a plain jest test
 * here (see this file's sibling `awaitingApproval.test.ts`).
 */
export function awaitingApprovalZeroCapDisplay(b: {
  approvalStatus: string;
  approvedCents: number | null;
  requestedCents: number;
  spentCents: number;
  budgetCents: number;
  pct: number;
  status: "ok" | "warn";
}): { budgetCents: number; pct: number; status: "ok" | "warn"; isAwaitingApproval: boolean } {
  const isAwaitingApproval =
    (b.approvalStatus === "submitted" || b.approvalStatus === "draft") &&
    b.approvedCents === 0 &&
    b.requestedCents > 0;
  if (!isAwaitingApproval) {
    return { budgetCents: b.budgetCents, pct: b.pct, status: b.status, isAwaitingApproval: false };
  }
  const pct = Math.round((b.spentCents / b.requestedCents) * 100);
  return {
    budgetCents: b.requestedCents,
    pct,
    status: pct >= 80 ? "warn" : "ok",
    isAwaitingApproval: true,
  };
}
