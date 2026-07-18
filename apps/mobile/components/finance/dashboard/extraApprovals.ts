/**
 * DASH-2 attention rail — the period-AGNOSTIC "N more awaiting approval"
 * count (fixed after adversarial review; approvals visibility is this
 * screen's headline job and must never regress with the period filter).
 *
 * `chapterAttentionQueue`'s `budget_approvals` item (`finances.ts`, queried
 * via `by_chapter_and_approval_status`) counts every `approvalStatus ===
 * "submitted"` budget chapter-WIDE, with no year/month filter at all. The
 * rail's `pendingApprovals` list (the pinned/inline in-table rows) is
 * derived from `oneTimeBudgets`/`recurringBudgets`, which ARE period-scoped
 * — `dashboardChapter`'s query is `eq("year", year)`, and one-time cards are
 * further month-gated by `oneTimeCardAppliesToDash`. So a budget submitted
 * for a future month, or for a different YEAR entirely, is invisible to
 * `pendingApprovals` in the default month view while still being counted by
 * the chapter-wide attention item — this is exactly that gap, surfaced as a
 * count rather than silently dropped. Never negative (a stale/inconsistent
 * read should render nothing extra, not a negative count).
 */
export function extraApprovalsCount(
  attention: { kind: string; badgeCount: number }[],
  inPeriodPendingCount: number,
): number {
  const chapterWide = attention.find((a) => a.kind === "budget_approvals")?.badgeCount ?? 0;
  return Math.max(0, chapterWide - inPeriodPendingCount);
}
