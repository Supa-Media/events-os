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
// "duplicates" is the ONLY filter that surfaces a receipt with
// `duplicateOfReceiptId` set (derived exact-file OR human-confirmed via
// `markAsDuplicate`) — the other three EXCLUDE them by default (hiding, never
// deleting; see `receipts.ts#listReceipts`'s doc).
export type LibraryFilterKey = "all" | "unlinked" | "linked" | "duplicates";
export const LIBRARY_FILTERS: { key: LibraryFilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "unlinked", label: "Unmatched" },
  { key: "linked", label: "Matched" },
  { key: "duplicates", label: "Duplicates" },
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

// ── Receipt-detail form re-seed logic (BUG 1: retry/re-extract results only
//    showing after closing & reopening the modal) ─────────────────────────
/** The local, editable fields of the receipt-detail form. */
export type ReceiptFormFields = {
  amountText: string;
  date: number | null;
  merchant: string;
  note: string;
};

/** A snapshot of the SERVER's canonical values the form was last seeded
 *  from, tagged with which receipt it came from — the source of truth
 *  `shouldReseedReceiptForm` compares the live form against. */
export type ReceiptFormSnapshot = ReceiptFormFields & { receiptId: string };

/** Build a snapshot from a live `getReceipt` result (or any object with these
 *  same canonical fields). */
export function snapshotReceiptForm(receipt: {
  _id: string;
  amountCents: number | null;
  receiptDate: number | null;
  merchant: string | null;
  note: string | null;
}): ReceiptFormSnapshot {
  return {
    receiptId: receipt._id,
    amountText: centsToDollarsInput(receipt.amountCents),
    date: receipt.receiptDate,
    merchant: receipt.merchant ?? "",
    note: receipt.note ?? "",
  };
}

function receiptFormFieldsEqual(a: ReceiptFormFields, b: ReceiptFormFields): boolean {
  return (
    a.amountText === b.amountText &&
    a.date === b.date &&
    a.merchant === b.merchant &&
    a.note === b.note
  );
}

/**
 * Decide whether `ReceiptDetailModal`'s open form should re-seed from a fresh
 * server snapshot. Pure (no RN/React) so it's directly unit-testable — this
 * is the exact decision that used to live behind a `seededFor !== receipt._id`
 * gate, which only ever seeded ONCE per receipt id: a retry that filled in a
 * blank field while the modal stayed open on the SAME receipt never re-seeded,
 * so the fix stayed invisible until the modal was closed and reopened.
 *
 *  - A DIFFERENT receipt (no prior snapshot, or its `receiptId` doesn't match
 *    the new one) ALWAYS reseeds — opening/switching receipts always shows
 *    that receipt's current values.
 *  - The SAME receipt only reseeds when the form still equals the snapshot it
 *    was LAST seeded from — i.e. the human hasn't typed anything since. This
 *    lets a background update (e.g. a retry filling in a blank amount) show
 *    up live in an open modal without ever clobbering an in-progress edit —
 *    the dirty check is whole-form, not per-field: any edited field holds the
 *    rest back too, matching the fix's spec.
 */
export function shouldReseedReceiptForm(
  current: ReceiptFormFields,
  lastSeeded: ReceiptFormSnapshot | null,
  server: ReceiptFormSnapshot,
): boolean {
  if (!lastSeeded || lastSeeded.receiptId !== server.receiptId) return true;
  return receiptFormFieldsEqual(current, lastSeeded);
}
