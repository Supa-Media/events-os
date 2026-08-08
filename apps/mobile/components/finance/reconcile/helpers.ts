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

// ── Filters ──────────────────────────────────────────────────────────────────
// The filter keys, their grouping, the OR-within/AND-across set semantics, the
// labels, and the URL round-trip ALL live in `@events-os/shared`
// (`reconcileFilters.ts`) now — because `finances.listReconcile` has to apply
// exactly the same rules server-side. A local copy of any of it would be a
// second source of truth for "which rows does this selection mean", and the
// counts and the rows would eventually disagree.
//
// What used to live here (`FILTERS`, `FILTER_GROUPS`, `parseFilterParam`,
// `FilterKey`, `FilterCounts`) is deleted rather than re-exported: nothing but
// its own test still referenced it once the grid moved to the shared module.

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

/**
 * Signed money: outflow renders `−$64.20`, inflow stays positive.
 *
 * `preMarkFlow` matters for a MARKED transfer. `markAsTransfer` rewrites `flow`
 * to "transfer" on both legs and preserves each one's original direction in
 * `preMarkFlow` — so reading `flow` alone renders a pair as two POSITIVE rows,
 * which is how a $2,873.21 Central→New York movement came to look like $5,746.42
 * of arrivals (owner report, 2026-08-07). Book value was never affected —
 * `signedBookCents` reads `preMarkFlow` first — but the grid said something
 * untrue. Fall back to `flow` when there's no marking.
 */
export function signedMoney(
  amountCents: number,
  flow: string,
  preMarkFlow?: "inflow" | "outflow" | null,
): string {
  const money = formatCents(amountCents);
  const direction = flow === "transfer" && preMarkFlow ? preMarkFlow : flow;
  return direction === "outflow" ? `${MINUS}${money}` : money;
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
 *
 * BOTH merchant names are searchable, deliberately. Typing "Costco" has to
 * find a row renamed to Costco, and typing the bank's own `IC* COSTCO BY IN
 * CAR` has to keep finding it too — someone reconciling against a statement is
 * reading the provider's string, and a rename must never make a row
 * unfindable by what the statement calls it.
 */
function rowHaystack(row: TxnRow): string {
  const money = formatCents(row.amountCents); // e.g. "$1,294.00"
  const parts = [
    row.merchantNameOverride ?? "",
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

