/**
 * Pure helpers for the FINANCES · PAYMENTS screens (contractor payments) —
 * status → badge, the filter chips, the money conversion, and the small
 * derivations the three routes share.
 *
 * Kept JSX-free (the sibling `reimbursements/helpers.ts` is the precedent) so
 * the derivations are trivially testable and the components stay
 * presentational. Row/detail types are derived from the LIVE
 * `api.contractorPayments` return shapes, so a backend projection change shows
 * up here as a type error rather than as a screen that quietly renders
 * `undefined`.
 *
 * Every label, status and rule comes from `@events-os/shared`
 * (`packages/shared/src/contractorPayments.ts`) — this file never re-words a
 * status or re-derives a money bound, because a second copy of "what does
 * `submitted` mean" is exactly how a screen and a server come to disagree.
 */
import type { FunctionReturnType } from "convex/server";
import { api } from "@events-os/convex/_generated/api";
import {
  CONTRACTOR_PAYMENT_REVIEW_STATUSES,
  CONTRACTOR_PAYMENT_TERMINAL_STATUSES,
  type ContractorPaymentStatus,
} from "@events-os/shared";
import type { BadgeTone, IconName } from "../../ui";

// ── Backend shapes ───────────────────────────────────────────────────────────
/** One row of the payments queue — the exact `list` return shape. */
export type ContractorPaymentRow = FunctionReturnType<
  typeof api.contractorPayments.list
>["payments"][number];

/** One payment in full — the exact `get` return shape. */
export type ContractorPaymentDetail = FunctionReturnType<
  typeof api.contractorPayments.get
>;

/** The tax document METADATA the detail query returns (never the file, never
 *  the storage id — see `contractorPayments.get`'s doc). */
export type ContractorTaxDocument = NonNullable<
  ContractorPaymentDetail["taxDocument"]
>;

// ── Status → badge tone + icon ───────────────────────────────────────────────
/**
 * The one place a contractor-payment status becomes a colour.
 *
 * `submitted` is deliberately the loudest thing on the screen (`warn`, not the
 * `accent` its reimbursement twin wears): this queue's entire job is to make
 * "a person is waiting on money" impossible to miss, and the moment a review
 * state reads as decoration it stops being read at all.
 */
export const STATUS_BADGE: Record<
  ContractorPaymentStatus,
  { tone: BadgeTone; icon: IconName }
> = {
  draft: { tone: "neutral", icon: "edit-2" },
  sent: { tone: "info", icon: "send" },
  submitted: { tone: "warn", icon: "clock" },
  // Sent back for a fix — a nudge, not a refusal (which `rejected` owns).
  changes_requested: { tone: "warn", icon: "corner-up-left" },
  approved: { tone: "success", icon: "check" },
  paying: { tone: "info", icon: "refresh-cw" },
  paid: { tone: "info", icon: "check-circle" },
  rejected: { tone: "danger", icon: "x-circle" },
  failed: { tone: "danger", icon: "alert-triangle" },
  canceled: { tone: "neutral", icon: "slash" },
};

/** Where the record came from, as a chip. The two origins carry genuinely
 *  different trust (`staff_prefilled` terms are the ORG's testimony;
 *  `self_serve` is a stranger's claim that arrives uncoded), so they get
 *  different tones rather than one neutral "origin" pill. */
export const ORIGIN_BADGE: Record<
  ContractorPaymentRow["origin"],
  { tone: BadgeTone; icon: IconName }
> = {
  staff_prefilled: { tone: "neutral", icon: "file-text" },
  self_serve: { tone: "lavender", icon: "inbox" },
};

// ── Filter chips (drive the `list({status})` arg) ────────────────────────────
export type FilterKey =
  | "all"
  | "submitted"
  | "draft"
  | "sent"
  | "changes_requested"
  | "approved"
  | "paying"
  | "paid";

export const FILTERS: {
  key: FilterKey;
  label: string;
  /** The `status` arg passed to `list` (undefined = All). */
  status?: ContractorPaymentStatus;
}[] = [
  { key: "all", label: "All" },
  // First after All, and named for the JOB rather than the state: this is the
  // only chip that ever means "somebody is blocked on you".
  { key: "submitted", label: "Needs review", status: "submitted" },
  { key: "draft", label: "Draft", status: "draft" },
  { key: "sent", label: "Awaiting contractor", status: "sent" },
  { key: "changes_requested", label: "Sent back", status: "changes_requested" },
  { key: "approved", label: "Approved", status: "approved" },
  { key: "paying", label: "Paying", status: "paying" },
  { key: "paid", label: "Paid", status: "paid" },
];

// ── Status predicates (mirror the backend's own transition guards) ───────────
const REVIEW = new Set<ContractorPaymentStatus>(
  CONTRACTOR_PAYMENT_REVIEW_STATUSES,
);
const TERMINAL = new Set<ContractorPaymentStatus>(
  CONTRACTOR_PAYMENT_TERMINAL_STATUSES,
);

/** Owes a reviewer a decision — the shared `CONTRACTOR_PAYMENT_REVIEW_STATUSES`,
 *  which is also what the reminder cron nags about. */
export function needsReview(status: ContractorPaymentStatus): boolean {
  return REVIEW.has(status);
}

/** Nothing more happens without a human starting something new. */
export function isTerminal(status: ContractorPaymentStatus): boolean {
  return TERMINAL.has(status);
}

/** Terms may still be edited — mirrors `TERMS_EDITABLE_STATUSES` in
 *  `apps/convex/contractorPayments.ts#updateTerms`. Editing past `approved`
 *  would change what was approved, so it stops there. */
export function canEditTerms(status: ContractorPaymentStatus): boolean {
  return (
    status === "draft" ||
    status === "sent" ||
    status === "submitted" ||
    status === "changes_requested"
  );
}

/** The link may still be (re-)sent — mirrors `send`'s own guard. */
export function canSendLink(status: ContractorPaymentStatus): boolean {
  return status === "draft" || status === "sent";
}

/** Cancelling is legal until money is in motion — mirrors
 *  `CANCELABLE_STATUSES`. */
export function canCancel(status: ContractorPaymentStatus): boolean {
  return canEditTerms(status) || status === "approved";
}

/** Approved and waiting for the money to actually leave — the state where the
 *  payout controls (`payContractorPayment` / `markPaidManually`) apply. */
export function canPayOut(status: ContractorPaymentStatus): boolean {
  return status === "approved";
}

/** The contractor still holds the ball: they have a link they can act on and
 *  nobody in the org is blocked. */
export function isWithContractor(status: ContractorPaymentStatus): boolean {
  return status === "sent" || status === "changes_requested";
}

// ── Money ────────────────────────────────────────────────────────────────────
/**
 * Integer cents → the dollars string an editable field starts life with
 * ("1200.5" would be a bug in a money field, so cents are always shown).
 * The other direction is `parseDollars` from
 * `components/event/ticketing/helpers.ts` — the app's ONE dollars→cents
 * parser (`Math.round(n * 100)`), reused here rather than copied so the UI
 * can't round differently from every other money field in the app.
 */
export function centsToAmountText(cents: number): string {
  return (cents / 100).toFixed(2);
}
