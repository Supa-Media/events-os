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
