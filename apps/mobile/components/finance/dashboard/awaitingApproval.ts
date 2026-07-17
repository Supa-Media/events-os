/**
 * WP-wave4 (item 6, owner addendum 2026-07-17): a budget AWAITING APPROVAL
 * with a $0 approved cap (a brand-new draft/submitted budget, or a draft
 * increase whose OLD cap was never approved above $0 — see
 * `finances.ts#effectiveCapCents`) reports `budgetCents: 0` — its card's
 * `pct`/`status` (server-computed against that $0 cap) then read "100% spent,
 * danger" purely from the unfunded-overspend rule, which is nonsense next to
 * a real "$925 of $1,500 requested" story. This helper detects exactly that
 * shape and re-derives a sane display (spend vs the REQUESTED amount,
 * ok/warn — never forced to the red $0-over state) — the RAW `pct`/`status`
 * stay correct for every other case (including a genuinely unfunded
 * APPROVED $0 budget with real spend, which must stay loud/red).
 *
 * A standalone, dependency-free (no `react-native` import) module so it can
 * be unit-tested directly under this package's jest config — `parts.tsx`
 * (which pulls in `react-native`) can't be imported from a plain jest test
 * here (see `parts.test.ts`'s sibling `awaitingApproval.test.ts`).
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
