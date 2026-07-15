/**
 * Pure helpers for the Reconcile grid — the server-side filter pills + their
 * counts, status select options, and signed-money / date formatting.
 *
 * Kept JSX-free so the derivations are trivially testable and the components
 * stay presentational. Everything money-shaped runs through `formatCents`.
 *
 * DATA NOTE: the grid's data source is `listReconcile` (its `reconcileRow`
 * projection), which resolves `hasReceipt`, `cardLast4`, and a `cardholder` on
 * top of the txn summary and filters SERVER-SIDE across all rows. The receipt
 * line + reminder timeline are still derived from `status` + `postedAt` until
 * real reminder scheduling lands (finance Phase 3).
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

