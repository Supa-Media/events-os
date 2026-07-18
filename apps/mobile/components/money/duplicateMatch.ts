/**
 * Client-side mirror of `moneyViews.ts`'s `possibleDuplicate` token-overlap
 * heuristic (`DUPLICATE_STOPWORDS` / `significantTokens` / `tokensOverlap`).
 * Needed because `eventCostGrid` only returns a boolean `possibleDuplicate`
 * flag per row — not WHICH other row it overlaps with. PlanGrid's "Merge into
 * item" affordance needs the SPECIFIC paired `event_item` row (never a
 * `vendor` row — `budgetLines.mergeLineIntoItem` only accepts eventItems) to
 * know what to merge a flagged `budget_line` row into.
 *
 * Keep this algorithm byte-for-byte in sync with `moneyViews.ts`'s copy — a
 * drift here would offer (or hide) a merge target the server's own flag
 * disagrees with.
 */

const DUPLICATE_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "cost", "cents", "fee",
]);

function significantTokens(label: string): Set<string> {
  return new Set(
    label
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4 && !DUPLICATE_STOPWORDS.has(t)),
  );
}

function tokensOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (b.has(t)) return true;
  return false;
}

export type MergeTargetItem = {
  itemId: string;
  label: string;
  plannedCents: number;
};

/**
 * For a flagged `budget_line` row's label, find the single best-match
 * `event_item` row it token-overlaps with — the same signal
 * `moneyViews.eventCostGrid` used to set `possibleDuplicate` on both rows,
 * narrowed to `event_item` candidates only (never `vendor`). Returns `null`
 * when no such item row exists (e.g. the line's only overlap was with a
 * vendor row, which is not a valid merge target).
 */
export function findMergeTargetItem(
  lineLabel: string,
  candidateItemRows: MergeTargetItem[],
): MergeTargetItem | null {
  const lineTokens = significantTokens(lineLabel);
  if (lineTokens.size === 0) return null;
  for (const item of candidateItemRows) {
    if (tokensOverlap(lineTokens, significantTokens(item.label))) return item;
  }
  return null;
}
