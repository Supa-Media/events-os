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
import {
  formatCents,
  TRANSACTION_STATUSES,
  TRANSACTION_STATUS_LABELS,
  type TransactionStatus,
} from "@events-os/shared";
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

// ── Status select options (the inline Status▾ cell + bulk "mark closed") ──
// Labels come from `TRANSACTION_STATUS_LABELS`, never restated here: this list
// used to hard-code them, so renaming the "reconciled" status to "Closed" meant
// finding this copy too. Only the tone is local, since colour is a grid concern.
const STATUS_COLORS: Record<TransactionStatus, SelectOption<TransactionStatus>["color"]> = {
  unreviewed: "gray",
  categorized: "amber",
  reconciled: "green",
  excluded: "red",
};

export const STATUS_OPTIONS: SelectOption<TransactionStatus>[] =
  TRANSACTION_STATUSES.map((value) => ({
    value,
    label: TRANSACTION_STATUS_LABELS[value],
    color: STATUS_COLORS[value],
  }));

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

// ── Search ───────────────────────────────────────────────────────────────────
// There is no client-side search here anymore. `filterReconcileRows`/`rowHaystack`
// ran over the rows `listReconcile` had ALREADY narrowed, which quietly made
// search a function of the active State filter — with the page's old default it
// searched 14 of 346 transactions and returned a confident nothing for a vendor
// that happened to be budgeted.
//
// The matching rule now lives in `@events-os/shared#matchesReconcileSearch` and
// runs SERVER-side over the whole scope (`listReconcile`'s `search` arg), which
// is the only place that can see the rows the filter excluded. Deleted rather
// than left as a re-export: a second entry point into row matching is how the
// two halves drift apart again.

