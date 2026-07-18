/**
 * DASH-2 dense "Events & projects" / "Recurring buckets" table ordering:
 * awaiting-approval rows (`approvalStatus === "submitted"`) are PINNED to
 * the top unconditionally (they're the thing that needs a decision — never
 * folded away), then up to `foldAfter` of the rest, then a "Show N more ▾"
 * fold for anything beyond that.
 *
 * Dependency-free so it's unit-testable under this package's jest config
 * (mirrors `awaitingApproval.ts`).
 */
export function orderRows<T extends { approvalStatus: string }>(
  rows: T[],
  expanded: boolean,
  foldAfter = 5,
): { pinned: T[]; visible: T[]; hidden: T[] } {
  const pinned = rows.filter((r) => r.approvalStatus === "submitted");
  const rest = rows.filter((r) => r.approvalStatus !== "submitted");
  const visible = expanded ? rest : rest.slice(0, foldAfter);
  const hidden = expanded ? [] : rest.slice(foldAfter);
  return { pinned, visible, hidden };
}
