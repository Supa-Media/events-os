/**
 * PURE client-side sort helpers for the giving desk's database-grid screens
 * (Donors / Backers / Gifts, WP-giving-grids). Kept dependency-free (no
 * `react-native`) so it's unit-testable directly under this package's jest
 * config, mirroring the finance dashboard's colocated pure-helper precedent
 * (`components/finance/dashboard/rowOrdering.ts`) and the Donors CRM's own
 * `dashboard/donorFilters.ts`.
 *
 * Sorting is CLIENT-SIDE over already-loaded rows only (Donors' "sortable
 * headers where cheap" — name / lifetime / last gift — over the scope's
 * already-fetched `listDonors` page), never a new query. `null`/`undefined`
 * values always sort last regardless of direction, so an ascending sort by
 * "Last gift" still reads newest-first-among-those-who-have-one with donors
 * who've never given trailing off the bottom rather than jumping to the top.
 */

export type SortDirection = "asc" | "desc";

/** A sortable field's raw value: a string (localeCompare), a number, or
 *  absent (`null`/`undefined` — always sorts last). */
export type SortValue = string | number | null | undefined;

/** Compare two sort values with nulls-last semantics, independent of
 *  direction (direction is applied by the caller via a final reverse — see
 *  `sortRows`). Equal-typed values compare naturally; string/number are
 *  never mixed by any real caller, but a defensive coercion keeps this total. */
export function compareSortValues(a: SortValue, b: SortValue): number {
  const aMissing = a === null || a === undefined;
  const bMissing = b === null || b === undefined;
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  if (typeof a === "string" && typeof b === "string") {
    return a.localeCompare(b);
  }
  const an = typeof a === "number" ? a : Number(a);
  const bn = typeof b === "number" ? b : Number(b);
  return an - bn;
}

/**
 * Sort `rows` by `getValue(row)`, nulls always last, direction applied on
 * top of that (so `"desc"` never resurfaces a null/missing value to the top
 * — it only reverses the ordering among rows that actually have a value).
 * Returns a new array; never mutates `rows`.
 */
export function sortRows<T>(
  rows: T[],
  getValue: (row: T) => SortValue,
  direction: SortDirection,
): T[] {
  const withValue: T[] = [];
  const missing: T[] = [];
  for (const row of rows) {
    const v = getValue(row);
    if (v === null || v === undefined) missing.push(row);
    else withValue.push(row);
  }
  withValue.sort((a, b) => compareSortValues(getValue(a), getValue(b)));
  if (direction === "desc") withValue.reverse();
  return [...withValue, ...missing];
}

/** Toggle a header's sort state: a fresh column starts ascending; pressing
 *  the ACTIVE column again flips direction; the column and direction are
 *  returned together so a single `setState` call covers both. */
export function nextSortState<K extends string>(
  key: K,
  current: { key: K; direction: SortDirection } | null,
): { key: K; direction: SortDirection } {
  if (current?.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: "asc" };
}
