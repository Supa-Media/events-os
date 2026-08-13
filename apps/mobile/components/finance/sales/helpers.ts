/**
 * Pure helpers for the Sales grid — the filter sets, their facet counts, and
 * the client-side search. JSX-free so the derivations stay trivially testable
 * and the components stay presentational (the `reconcile/helpers.ts` pattern).
 *
 * ── WHY THESE FILTERS RUN CLIENT-SIDE, UNLIKE RECONCILE'S ───────────────────
 * Reconcile pushed filtering to the server because a chapter has thousands of
 * transactions and a pill has to be truthful about all of them, not just the
 * page in hand. Sales are different by an order of magnitude — 186 rows, and
 * the table is bounded by how many times a card reader was tapped at three
 * events — so `listSales` already hands over every row. Filtering them again on
 * the server would be a round trip to re-answer a question the client can
 * already answer exactly, and it would make the counts harder to keep honest,
 * not easier. If sales ever grow a rail that produces thousands of rows a month
 * this should move server-side, and `SALES_SCAN_LIMIT`'s `truncated` flag is
 * the tripwire that will say so.
 *
 * The counts are FACET counts, the same as Reconcile's: an option's number is
 * how many rows you would see if you added it to the current selection, so it
 * moves as other groups narrow. A count that ignored the rest of the selection
 * would routinely promise rows the click then doesn't deliver.
 */
import type { FunctionReturnType } from "convex/server";
import { formatCents } from "@events-os/shared";
import { api } from "@events-os/convex/_generated/api";

export { formatCents };

/** One sales-grid row — the exact `listSales` row shape. */
export type SaleRow = FunctionReturnType<typeof api.sales.listSales>["sales"][number];
/** One selectable event for the Event cell + filter. */
export type SaleEventOption = FunctionReturnType<typeof api.sales.listSales>["events"][number];
/** One basket a row's amount could be. */
export type BasketOption = SaleRow["itemOptions"][number];

/** The sentinel for "no event" — a real filter value, not a null. */
export const UNATTRIBUTED = "__unattributed__";

// ── Breakdown filter ─────────────────────────────────────────────────────────
/**
 * The four honest states of a sale's item breakdown, ordered by what a
 * bookkeeper is likely to want first.
 *
 * `needs_choice` is the point of this whole screen. It is not "unresolved" —
 * it's the subset of unresolved rows where the amount DOES match baskets from
 * that day's price list, just more than one of them, so a person who was at the
 * table can settle it in a click. `no_reading` is the rest: an amount no
 * combination of that day's prices reaches (a $10 tap at Eden, where only $30
 * tees were sold), which no amount of clicking will fix and which therefore
 * shouldn't sit in the worklist pretending it can be.
 */
export const BREAKDOWN_KEYS = [
  "needs_choice",
  "no_reading",
  "itemised",
  "manual",
] as const;
export type BreakdownKey = (typeof BREAKDOWN_KEYS)[number];

export const BREAKDOWN_LABELS: Record<BreakdownKey, string> = {
  needs_choice: "Needs a choice",
  no_reading: "No reading fits",
  itemised: "Itemised",
  manual: "Set by hand",
};

export function matchesBreakdown(row: SaleRow, key: BreakdownKey): boolean {
  const unresolved = row.itemSource === "unresolved";
  switch (key) {
    case "needs_choice":
      return unresolved && row.itemOptions.length > 0;
    case "no_reading":
      return unresolved && row.itemOptions.length === 0;
    case "itemised":
      return !unresolved;
    case "manual":
      return row.itemSource === "manual";
  }
}

// ── The selection ────────────────────────────────────────────────────────────
/** OR within a group, AND across groups — Reconcile's semantics exactly. A sale
 *  is routinely both unattributed AND unresolved, and one bucket at a time could
 *  never express "the rows that still owe me something". */
export type SalesFilters = {
  breakdown: BreakdownKey[];
  /** `eventId`s, plus `UNATTRIBUTED`. */
  events: string[];
  /** Item labels, as they appear in `row.items[].label`. */
  items: string[];
};

export const EMPTY_FILTERS: SalesFilters = { breakdown: [], events: [], items: [] };

export function hasAnyFilter(f: SalesFilters): boolean {
  return f.breakdown.length > 0 || f.events.length > 0 || f.items.length > 0;
}

function matchesEvents(row: SaleRow, keys: string[]): boolean {
  if (keys.length === 0) return true;
  return keys.includes(row.eventId ?? UNATTRIBUTED);
}

function matchesItems(row: SaleRow, labels: string[]): boolean {
  if (labels.length === 0) return true;
  return row.items.some((i) => labels.includes(i.label));
}

function matchesBreakdowns(row: SaleRow, keys: BreakdownKey[]): boolean {
  if (keys.length === 0) return true;
  return keys.some((k) => matchesBreakdown(row, k));
}

export function matchesFilters(row: SaleRow, f: SalesFilters): boolean {
  return (
    matchesBreakdowns(row, f.breakdown) &&
    matchesEvents(row, f.events) &&
    matchesItems(row, f.items)
  );
}

// ── Search ───────────────────────────────────────────────────────────────────
/**
 * The lowercase haystack a row is searched against. Amounts get several
 * spellings so typing `12`, `12.00` or `$12` all find the same tap — the same
 * accommodation Reconcile's search makes, and for the same reason: nobody
 * remembers which one a grid wanted.
 */
export function searchHaystack(row: SaleRow): string {
  const dollars = (row.grossCents / 100).toFixed(2);
  return [
    row.items.map((i) => i.label).join(" "),
    row.items.flatMap((i) => i.candidates).join(" "),
    row.eventName ?? "unattributed",
    row.paymentRef,
    row.itemOptions.map((o) => o.label).join(" "),
    formatCents(row.grossCents),
    dollars,
    dollars.replace(/\.00$/, ""),
  ]
    .join(" ")
    .toLowerCase();
}

export function matchesQuery(row: SaleRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  return searchHaystack(row).includes(q);
}

/** The rows actually on screen. */
export function applySelection(
  rows: SaleRow[],
  f: SalesFilters,
  query: string,
): SaleRow[] {
  return rows.filter((r) => matchesFilters(r, f) && matchesQuery(r, query));
}

// ── Facet counts ─────────────────────────────────────────────────────────────
export type SalesFacets = {
  breakdown: Record<BreakdownKey, number>;
  /** Keyed by `eventId` / `UNATTRIBUTED`. */
  events: Map<string, number>;
  /**
   * Keyed by item label, valued in UNITS SOLD — not rows.
   *
   * This is the "What sold" card the page used to carry, folded into a control.
   * Units is the number that card reported and the number a treasurer actually
   * wants ("we sold 34 tees"), and it differs from a row count whenever one tap
   * bought two of something. The filter bar's tooltip says so on screen, because
   * a number that means something different from its neighbours has to admit it.
   */
  items: Map<string, number>;
};

/** Every distinct item label present in these rows, most units first. */
export function itemLabels(rows: SaleRow[]): string[] {
  const units = new Map<string, number>();
  for (const r of rows) {
    for (const i of r.items) units.set(i.label, (units.get(i.label) ?? 0) + i.quantity);
  }
  return [...units.entries()].sort((a, b) => b[1] - a[1]).map(([label]) => label);
}

/**
 * Counts for every option in every group, each computed against the OTHER
 * groups' selections (plus the search) but ignoring its own — so ticking a
 * second option in the same group always adds rows rather than mysteriously
 * subtracting them.
 */
export function facetCounts(
  rows: SaleRow[],
  f: SalesFilters,
  query: string,
): SalesFacets {
  const searched = rows.filter((r) => matchesQuery(r, query));

  const forBreakdown = searched.filter(
    (r) => matchesEvents(r, f.events) && matchesItems(r, f.items),
  );
  const forEvents = searched.filter(
    (r) => matchesBreakdowns(r, f.breakdown) && matchesItems(r, f.items),
  );
  const forItems = searched.filter(
    (r) => matchesBreakdowns(r, f.breakdown) && matchesEvents(r, f.events),
  );

  const breakdown = {} as Record<BreakdownKey, number>;
  for (const key of BREAKDOWN_KEYS) {
    breakdown[key] = forBreakdown.filter((r) => matchesBreakdown(r, key)).length;
  }

  const events = new Map<string, number>();
  for (const r of forEvents) {
    const key = r.eventId ?? UNATTRIBUTED;
    events.set(key, (events.get(key) ?? 0) + 1);
  }

  const items = new Map<string, number>();
  for (const r of forItems) {
    for (const i of r.items) {
      items.set(i.label, (items.get(i.label) ?? 0) + i.quantity);
    }
  }

  return { breakdown, events, items };
}

// ── Bulk eligibility ─────────────────────────────────────────────────────────
/**
 * The baskets a WHOLE selection could be set to, or `null` when there is no
 * such thing.
 *
 * Setting items in bulk is the single biggest time-saver here — Pop The Balloon
 * has dozens of identical $3 taps — but it is only ever meaningful when every
 * selected row is offered the same readings, which happens exactly when they
 * share an amount and a day's price list. Rather than compare days, compare the
 * OPTION KEYS the server already computed for each row: identical key sets mean
 * identical choices, whatever produced them. Anything else returns null and the
 * bar says why instead of offering a picker that would half-apply.
 */
export function sharedBasketOptions(rows: SaleRow[]): BasketOption[] | null {
  if (rows.length === 0) return null;
  const signature = (r: SaleRow) =>
    r.itemOptions.map((o) => o.key).sort().join("|");
  const first = signature(rows[0]);
  if (first.length === 0) return null;
  if (rows.some((r) => signature(r) !== first)) return null;
  return rows[0].itemOptions;
}

// ── Dates ────────────────────────────────────────────────────────────────────
/** The chapter's wall clock. Sales happened at a table in New York, and a UTC
 *  rendering would put a 9pm Saturday tap on Sunday. */
const TZ = "America/New_York";

export function shortDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    timeZone: TZ,
  });
}

/** Date AND time — the detail view's precision, where "which tap was this"
 *  matters and two $3 sales a minute apart have to be tellable apart. */
export function longDateTime(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: TZ,
  });
}

/** How a stored breakdown reads in a cell. Mirrors the server's own
 *  `basketLabel` — the two must agree or a row would change wording the moment
 *  someone edited it. */
export function itemsLabel(row: SaleRow): string {
  if (row.items.length === 0) return "Unresolved";
  return row.items
    .map((i) => (i.quantity > 1 ? `${i.quantity} × ${i.label}` : i.label))
    .join(" + ");
}

/** Plain-language provenance for a row's breakdown, strongest evidence first —
 *  the same ladder `lib/salesItems.ts` ranks, said in words a treasurer can act
 *  on. The distinction that matters on screen is fact versus inference: the top
 *  three are somebody stating what was sold, the fourth is arithmetic. */
export const ITEM_SOURCE_LABELS: Record<string, string> = {
  manual: "Set by hand, from the readings this amount allows",
  stripe_line_items: "Stripe named the products and the prices add up exactly",
  charge_description: "The point of sale wrote down what it rang up",
  amount_decomposition: "Reconstructed — only one basket makes this amount",
  unresolved: "The amount is all the card reader recorded",
  ticket_order: "Sold as tickets — the order recorded exactly what it sold",
};
