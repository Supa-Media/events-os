/**
 * RECEIPTS TAB — pure helpers shared by the inbox / library / detail pieces.
 *
 * Kept JSX-free (types + small pure functions) so the shapes stay anchored to
 * the real `api.receipts.*` / `api.receiptInbox.*` return validators via
 * `FunctionReturnType` — never hand-typed, so a backend field rename shows up
 * here as a compile error instead of a silent drift (house convention, see
 * `reconcile/helpers.ts`).
 */
import type { FunctionReturnType } from "convex/server";
import { formatCents, type InboundReceiptStatus, type ReceiptSenderClass } from "@events-os/shared";
import { api } from "@events-os/convex/_generated/api";
import type { BadgeTone } from "../../ui";

export { formatCents };

// ── Shapes (anchored to the real backend validators) ─────────────────────────
export type ReceiptRow = FunctionReturnType<typeof api.receipts.listReceipts>[number];
export type ReceiptDetail = NonNullable<FunctionReturnType<typeof api.receipts.getReceipt>>;
export type InboundQueueRow = FunctionReturnType<typeof api.receipts.listInboundQueue>[number];
export type SuggestedCandidate = FunctionReturnType<typeof api.receipts.suggestMatches>[number];

// ── Library filter (matches `receipts.listReceipts`'s `filter` arg) ──────────
export type LibraryFilterKey = "all" | "unlinked" | "linked";
export const LIBRARY_FILTERS: { key: LibraryFilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "unlinked", label: "Unmatched" },
  { key: "linked", label: "Matched" },
];

// ── Inbox status chips ─────────────────────────────────────────────────────
/** `undefined` = "All" (the default queue: needs_review/no_match/error). */
export type InboxStatusFilter = InboundReceiptStatus | "all";
export const INBOX_STATUS_FILTERS: { key: InboxStatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "needs_review", label: "Needs review" },
  { key: "no_match", label: "No match" },
  { key: "error", label: "Error" },
];

/** Chip/label tone for an inbound row's own status (shown per-row alongside
 *  the active filter). */
export function inboundStatusTone(status: InboundReceiptStatus): BadgeTone {
  switch (status) {
    case "matched":
      return "success";
    case "needs_review":
      return "warn";
    case "no_match":
      return "neutral";
    case "error":
      return "danger";
    case "ignored":
      return "neutral";
    case "pending":
      return "info";
    default:
      return "neutral";
  }
}

export function inboundStatusLabel(status: InboundReceiptStatus): string {
  switch (status) {
    case "needs_review":
      return "Needs review";
    case "no_match":
      return "No match";
    case "matched":
      return "Matched";
    case "error":
      return "Error";
    case "ignored":
      return "Ignored";
    case "pending":
      return "Pending";
    default:
      return status;
  }
}

// ── Sender-class badge (team=success, roster=info, internal=accent, external=warn) ──
export function senderClassTone(cls: ReceiptSenderClass | null): BadgeTone {
  switch (cls) {
    case "team":
      return "success";
    case "roster":
      return "info";
    case "internal":
      return "accent";
    case "external":
      return "warn";
    default:
      return "neutral";
  }
}

export function senderClassLabel(cls: ReceiptSenderClass | null): string {
  switch (cls) {
    case "team":
      return "Team";
    case "roster":
      return "Roster";
    case "internal":
      return "Internal";
    case "external":
      return "External";
    default:
      return "Unknown sender";
  }
}

// ── Money input (dollars string ↔ integer cents) ──────────────────────────
/** Parse a dollars-string input into integer cents, or `null` if unparsable /
 *  non-positive (mirrors `ticketing/helpers.ts#parseDollars` but rejects 0 —
 *  `updateReceiptFields` requires a POSITIVE amount when one is sent). */
export function parseDollarsToCents(input: string): number | null {
  const trimmed = input.trim().replace(/^\$/, "");
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (Number.isNaN(n) || n <= 0) return null;
  return Math.round(n * 100);
}

export function centsToDollarsInput(cents: number | null): string {
  if (cents == null) return "";
  return (cents / 100).toFixed(2);
}
