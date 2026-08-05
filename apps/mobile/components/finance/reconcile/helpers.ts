/**
 * Pure helpers for the Reconcile grid — the server-side filter pills + their
 * counts, status select options, and signed-money / date formatting.
 *
 * Kept JSX-free so the derivations are trivially testable and the components
 * stay presentational. Everything money-shaped runs through `formatCents`.
 *
 * DATA NOTE: the grid's data source is `listReconcile` (its `reconcileRow`
 * projection), which resolves `hasReceipt`, `cardLast4`, `reminderStage`,
 * `isPersonal` + the linked repayment's `repaymentStatus`, and a `cardholder`
 * on top of the txn summary and filters SERVER-SIDE across all rows. `reminderStage` ("none" | "flagged" | "escalated") reflects the real
 * day-1/day-3 receipt-reminder timeline advanced by
 * `cards.advanceReceiptReminders` (Phase 3) — the day-7 terminal auto-lock is
 * a card-level state shown in the Cards tab, not this grid.
 */
import type { FunctionReturnType } from "convex/server";
import { formatCents, type TransactionStatus } from "@events-os/shared";
import { api } from "@events-os/convex/_generated/api";
import type { SelectOption } from "../../ui";

export { formatCents };

/** One reconcile-grid row — the exact `listReconcile` row shape (cardholder + receipt). */
export type TxnRow =
  FunctionReturnType<typeof api.finances.listReconcile>["rows"][number];

// ── Server-side filter pills ─────────────────────────────────────────────────
/** Matches the backend `listReconcile` filter arg. */
export type FilterKey =
  | "all"
  | "spend"
  | "needs_budget"
  | "missing_receipt"
  | "to_review"
  | "reconciled"
  | "personal_unpaid"
  | "transfers"
  | "payouts";

/** Per-filter counts returned by `listReconcile` (drives each pill's badge). */
export type FilterCounts = FunctionReturnType<
  typeof api.finances.listReconcile
>["counts"];

export const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  // no-dead-numbers: the dashboards' "Spent" KPI tile drills in here
  // (`?filter=spend`) — shown as a real pill (not just a hidden deep-link
  // target) so a treasurer landing on it can see which filter they're in
  // and switch away cleanly.
  { key: "spend", label: "Spend" },
  { key: "needs_budget", label: "Needs budget" },
  { key: "missing_receipt", label: "Missing receipt" },
  // The dashboards' "To review N" tile drills in HERE — same words, same
  // predicate (`status === "unreviewed"`). This pill was labelled
  // "Uncategorized", which described a different thing entirely, and the tile
  // linked to `needs_budget` instead; between them the tile's number appeared
  // nowhere on the screen it opened (the founder report). See
  // `finances.ts#reconcileFilterValidator`'s NAMING note.
  { key: "to_review", label: "To review" },
  // Rows already CLEARED — the complement of the header's "N to clear", not
  // (as "Ready" read) the backlog waiting to be worked.
  { key: "reconciled", label: "Reconciled" },
  // Founder ask: an unpaid personal expense is exactly the worklist a
  // treasurer needs — surfaced as its own pill rather than buried in "All".
  { key: "personal_unpaid", label: "Personal (unpaid)" },
  // The worklists for the two marking flows. Without these there's no way to
  // review what's been marked — a marked transfer leaves "Needs budget" and a
  // marked payout was never in any pill, so both would otherwise be visible
  // only by scrolling "All".
  { key: "transfers", label: "Transfers" },
  { key: "payouts", label: "Payouts" },
];

/**
 * The filters, grouped for the Reconcile filter dropdown.
 *
 * Presenting all nine as a flat row of equal chips was the real defect behind
 * "these chips are terrible UX" — not just the layout. They aren't nine peers;
 * they answer three different questions, and flattening them made the reader
 * do that sorting every time:
 *
 *  - a LENS on which rows count at all (All / Spend);
 *  - a WORKLIST — what's still missing before a charge can be cleared;
 *  - a state or row KIND that isn't outstanding work at all (already cleared,
 *    or not spend in the first place).
 *
 * The group headings carry that structure, so the menu reads as "where is the
 * work" rather than a wall of options. `null` title = no heading (the lens
 * pair sits at the top unlabelled, where a default belongs).
 *
 * Every key in `FILTERS` must appear exactly once here — asserted by
 * `helpers.test.ts` so adding a filter without placing it can't silently drop
 * it from the only control that reaches it.
 */
export const FILTER_GROUPS: { title: string | null; keys: FilterKey[] }[] = [
  { title: null, keys: ["all", "spend"] },
  {
    title: "Needs work",
    keys: ["to_review", "needs_budget", "missing_receipt", "personal_unpaid"],
  },
  { title: "Cleared", keys: ["reconciled"] },
  { title: "Not spend", keys: ["transfers", "payouts"] },
];

/**
 * Deep links written before the `uncategorized`→`to_review` /
 * `ready`→`reconciled` rename (see `finances.ts#reconcileFilterValidator`'s
 * NAMING note). A stale bookmark, a pasted URL, or a back-navigation into an
 * old history entry still lands on the pill it meant instead of silently
 * falling back to the default filter — which is the exact failure mode this
 * whole change set exists to remove.
 */
const LEGACY_FILTER_ALIASES: Record<string, FilterKey> = {
  uncategorized: "to_review",
  ready: "reconciled",
};

/** Resolve a `?filter=` param to a real `FilterKey`, or `null` if unknown. */
export function parseFilterParam(raw: string | undefined): FilterKey | null {
  if (!raw) return null;
  const aliased = LEGACY_FILTER_ALIASES[raw];
  if (aliased) return aliased;
  return FILTERS.some((f) => f.key === raw) ? (raw as FilterKey) : null;
}

// ── Status select options (the inline Status▾ cell + bulk "mark reconciled") ──
export const STATUS_OPTIONS: SelectOption<TransactionStatus>[] = [
  { value: "unreviewed", label: "Unreviewed", color: "gray" },
  { value: "categorized", label: "Categorized", color: "amber" },
  { value: "reconciled", label: "Reconciled", color: "green" },
  { value: "excluded", label: "Excluded", color: "red" },
];

// ── AI-suggestion eligibility ────────────────────────────────────────────────
/**
 * True iff `row` is a candidate for the "Suggest" button (PR
 * fix-suggest-broaden — the owner-reported bug: a "Categorized" row that
 * still shows "Needs budget" got no button, just a bare "—"). Mirrors the
 * server's `finances.isSuggestible` predicate EXACTLY (single source of
 * truth: this same rule also gates the on-demand `suggestCoding` action and
 * the on-ingest/hourly sweep) — a row qualifies either:
 *  - it's still `unreviewed` (never reviewed at all — the original rule), OR
 *  - it's `categorized` but STILL `needsBudget` (a human coded the category
 *    but the row never got a budget attached).
 * `reconciled` (treasurer-closed) and `excluded`/personal/non-spend rows are
 * never suggestible — `needsBudget` is already `false` for the latter, and
 * `reconciled` falls outside both branches by construction. The caller ALSO
 * checks `!row.aiSuggestion` separately (a pending suggestion shows the
 * Accept UI instead — see `ReconcileList.tsx`).
 */
export function isSuggestible(row: TxnRow): boolean {
  if (row.status === "unreviewed") return true;
  return row.status === "categorized" && row.needsBudget;
}

// ── Money + dates ────────────────────────────────────────────────────────────
/** U+2212 true minus (matches the prototype), not an ASCII hyphen. */
const MINUS = "−";

/** Signed money: outflow renders `−$64.20`, inflow/transfer stays positive. */
export function signedMoney(amountCents: number, flow: string): string {
  const money = formatCents(amountCents);
  return flow === "outflow" ? `${MINUS}${money}` : money;
}

const TZ = "America/New_York";

/** `Jul 10, 2025` — the compact list/timeline date. Year included because the
 *  reconcile inbox now spans multiple years (historical/genesis imports). */
export function shortDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    timeZone: TZ,
  });
}

// ── Client-side search (narrows the active pill's already-loaded rows) ────────
/**
 * The lowercase haystack a row is searched against: merchant, description,
 * cardholder name, card last-4, and several amount spellings so typing an
 * amount works — raw cents (`1294`), the formatted string (`$12.94`), and the
 * bare decimal (`12.94`). Commas are stripped so `1294` still finds `$1,294.00`.
 */
function rowHaystack(row: TxnRow): string {
  const money = formatCents(row.amountCents); // e.g. "$1,294.00"
  const parts = [
    row.merchantName ?? "",
    row.description ?? "",
    row.cardholder?.name ?? "",
    row.cardLast4 ?? "",
    // Searchable in the merged all-books queue: typing "central" or a chapter
    // name narrows to that book without leaving the merged view.
    row.book.name,
    String(row.amountCents), // raw cents: "129400"
    money, // "$1,294.00"
    money.replace(/[$,]/g, ""), // bare decimal: "1294.00"
  ];
  return parts.join(" ").toLowerCase();
}

/**
 * Narrow `rows` to those matching `query`, case-insensitively. The query is
 * trimmed and split on whitespace into terms; a row matches only if EVERY term
 * appears somewhere in its haystack (AND), so `seyi deli` finds Seyi's deli
 * charge. An empty query returns `rows` unchanged.
 */
export function filterReconcileRows(rows: TxnRow[], query: string): TxnRow[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return rows;
  return rows.filter((row) => {
    const hay = rowHaystack(row);
    return terms.every((t) => hay.includes(t));
  });
}

