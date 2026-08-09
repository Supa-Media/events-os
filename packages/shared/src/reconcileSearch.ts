/**
 * RECONCILE SEARCH — the "where is that transaction" lookup, as pure set logic.
 *
 * Lives in `@events-os/shared` for the same reason `reconcileFilters.ts` does:
 * both halves have to agree exactly. `finances.listReconcile` now runs this
 * server-side over the WHOLE scope, and the grid's search box just forwards the
 * string. A second copy of the haystack rules on the client would be a second
 * answer to "does this row match", and the rows and the result count would
 * eventually disagree.
 *
 * ## Why this moved to the server
 *
 * It used to be `filterReconcileRows` in the mobile package, run over whatever
 * rows the server had already narrowed to. That made search a function of the
 * active State filter, which is not what anybody means by search: with the
 * page's old default (`needs_budget`) the box searched **14 of 346
 * transactions**, so typing a vendor that happened to be budgeted returned
 * nothing — and nothing on screen said the filter was the reason. Search is a
 * "find the thing" tool; a filter is a "browse a subset" tool, and quietly
 * intersecting them produced a confident, wrong empty state.
 *
 * The fix is in `listReconcile`: when a query is present the STATE group is
 * dropped for that request and the hidden transfer legs are un-hidden, so
 * search always covers the full book. This module is only the matching rule.
 */

import { formatCents } from "./finance";

/**
 * The searchable projection of one transaction. Deliberately a plain field bag
 * rather than a row or a `Doc<"transactions">`: the server builds it from a
 * transaction document plus a cheaply-resolved cardholder name and its book's
 * name, and a test builds it from a literal. Nothing here needs a database.
 */
export type ReconcileSearchFields = {
  /** The bookkeeper's rename, if any. */
  merchantNameOverride?: string | null;
  /** What the bank/processor called it. */
  merchantName?: string | null;
  description?: string | null;
  /** Whose charge it is, resolved. `null` for an unattributed row. */
  cardholderName?: string | null;
  cardLast4?: string | null;
  /** "Central" or the chapter's name — searchable in the merged all-books queue. */
  bookName?: string | null;
  amountCents: number;
};

/**
 * Split a raw query box string into search terms: trimmed, lowercased, split on
 * whitespace, empties dropped. An empty/blank query yields `[]`, which every
 * caller treats as "not searching" rather than "matches nothing".
 */
export function reconcileSearchTerms(query: string | null | undefined): string[] {
  return (query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * The lowercase haystack a row is searched against: merchant, description,
 * cardholder name, card last-4, book name, and several amount spellings so
 * typing an amount works — raw cents (`129400`), the formatted string
 * (`$1,294.00`), and the bare decimal (`1294.00`). Commas and `$` are stripped
 * in the third spelling so `1294` still finds `$1,294.00`.
 *
 * BOTH merchant names are searchable, deliberately. Typing "Costco" has to find
 * a row renamed to Costco, and typing the bank's own `IC* COSTCO BY IN CAR` has
 * to keep finding it too — someone reconciling against a statement is reading
 * the provider's string, and a rename must never make a row unfindable by what
 * the statement calls it.
 */
export function reconcileHaystack(f: ReconcileSearchFields): string {
  const money = formatCents(f.amountCents); // e.g. "$1,294.00"
  return [
    f.merchantNameOverride ?? "",
    f.merchantName ?? "",
    f.description ?? "",
    f.cardholderName ?? "",
    f.cardLast4 ?? "",
    f.bookName ?? "",
    String(f.amountCents), // raw cents: "129400"
    money, // "$1,294.00"
    money.replace(/[$,]/g, ""), // bare decimal: "1294.00"
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * Does this row match every term? AND across terms, so `seyi deli` finds Seyi's
 * deli charge and not every row mentioning either word. No terms → `true`
 * (an empty query constrains nothing).
 */
export function matchesReconcileSearch(
  f: ReconcileSearchFields,
  terms: readonly string[],
): boolean {
  if (terms.length === 0) return true;
  const hay = reconcileHaystack(f);
  return terms.every((t) => hay.includes(t));
}
