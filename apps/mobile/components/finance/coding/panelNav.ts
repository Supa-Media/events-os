/**
 * Prev/Next stepping through a row list, as a pure function.
 *
 * The workbench panel (`explain.tsx`, `CodingWorkbenchPanel`) needs the SAME
 * stepping logic in three places: the header's ← / → buttons, the web
 * ArrowUp/ArrowDown (and j/k) keyboard shortcut, and the "3 of 42" position
 * label. Pulling it out here means all three read one implementation instead
 * of three hand-rolled `findIndex` calls that could each get the edge cases
 * (first row, last row, a selected id no longer in the list) slightly
 * differently wrong.
 *
 * Deliberately keyed by `id: string` rather than the row's own type: the
 * panel steps through `finances.monthCodingWorklist`'s rows today, but
 * nothing here should have to change if a second list ever wants the same
 * stepping.
 */

/** `rows[i].id === selectedId`'s index, or -1 if not found (selection cleared,
 *  or the list changed under a stale selection). */
export function indexOfSelected(
  rows: readonly { id: string }[],
  selectedId: string | null,
): number {
  if (selectedId == null) return -1;
  return rows.findIndex((r) => r.id === selectedId);
}

/**
 * The id one step away from `selectedId` in `rows`, or `null` at either end
 * (never wraps — "Next" past the last row does nothing, it doesn't loop back
 * to the first). `null` also comes back when `selectedId` isn't in `rows` at
 * all, since there is no well-defined "next" from a row that isn't there.
 */
export function stepSelection(
  rows: readonly { id: string }[],
  selectedId: string | null,
  delta: 1 | -1,
): string | null {
  const i = indexOfSelected(rows, selectedId);
  if (i === -1) return null;
  const next = i + delta;
  if (next < 0 || next >= rows.length) return null;
  return rows[next].id;
}

/** "3 of 42" position, 1-based — `null` when the selection isn't in the list
 *  (nothing to report a position for). */
export function panelPosition(
  rows: readonly { id: string }[],
  selectedId: string | null,
): { index: number; total: number } | null {
  const i = indexOfSelected(rows, selectedId);
  if (i === -1) return null;
  return { index: i + 1, total: rows.length };
}

/**
 * What the selection becomes when the selected row DISAPPEARS from `rows`
 * entirely — not "moved," gone. On the workbench panel this happens when
 * approving a coding removes the row from `monthCodingWorklist`'s pending
 * population out from under an open panel (submitting one does NOT — the
 * row just changes state and stays put, which needs no reconciliation at
 * all: the caller only reaches for this once it already knows the selected
 * id is no longer anywhere in `rows`).
 *
 * The rule: land on whichever row now occupies the vanished row's OLD
 * position — the natural "next" item for someone working biggest-first and
 * clearing rows one at a time, not a jump to the top or the bottom.
 * `lastKnownIndex` is that old position; the caller has to track it across
 * renders (see `explain.tsx`), because once the row is gone there is no way
 * to ask the NEW `rows` where it used to be.
 *
 * `null` means "close the panel": either the list is now empty, or the
 * caller never had a known position to fall back to.
 */
export function selectionAfterRowsShrink(
  rows: readonly { id: string }[],
  lastKnownIndex: number | null,
): string | null {
  if (rows.length === 0) return null;
  if (lastKnownIndex == null) return rows[0].id;
  const clamped = Math.min(Math.max(lastKnownIndex, 0), rows.length - 1);
  return rows[clamped].id;
}
