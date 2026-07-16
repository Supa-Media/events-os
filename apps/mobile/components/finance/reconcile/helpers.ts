/**
 * Pure helpers for the Reconcile grid — the server-side filter pills + their
 * counts, status select options, and signed-money / date formatting.
 *
 * Kept JSX-free so the derivations are trivially testable and the components
 * stay presentational. Everything money-shaped runs through `formatCents`.
 *
 * DATA NOTE: the grid's data source is `listReconcile` (its `reconcileRow`
 * projection), which resolves `hasReceipt`, `cardLast4`, `reminderStage`, and a
 * `cardholder` on top of the txn summary and filters SERVER-SIDE across all
 * rows. `reminderStage` ("none" | "flagged" | "escalated") reflects the real
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
  | "needs_budget"
  | "missing_receipt"
  | "uncategorized"
  | "ready";

/** Per-filter counts returned by `listReconcile` (drives each pill's badge). */
export type FilterCounts = FunctionReturnType<
  typeof api.finances.listReconcile
>["counts"];

export const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "needs_budget", label: "Needs budget" },
  { key: "missing_receipt", label: "Missing receipt" },
  { key: "uncategorized", label: "Uncategorized" },
  { key: "ready", label: "Ready" },
];

// ── Status select options (the inline Status▾ cell + bulk "mark reconciled") ──
export const STATUS_OPTIONS: SelectOption<TransactionStatus>[] = [
  { value: "unreviewed", label: "Unreviewed", color: "gray" },
  { value: "categorized", label: "Categorized", color: "amber" },
  { value: "reconciled", label: "Reconciled", color: "green" },
  { value: "excluded", label: "Excluded", color: "red" },
];

// ── Money + dates ────────────────────────────────────────────────────────────
/** U+2212 true minus (matches the prototype), not an ASCII hyphen. */
const MINUS = "−";

/** Signed money: outflow renders `−$64.20`, inflow/transfer stays positive. */
export function signedMoney(amountCents: number, flow: string): string {
  const money = formatCents(amountCents);
  return flow === "outflow" ? `${MINUS}${money}` : money;
}

const TZ = "America/New_York";

/** `Jul 10` — the compact list/timeline date. */
export function shortDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
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

