/**
 * Pure helpers for the Reimbursements approval queue — filter pills, status →
 * badge tone/icon, receipts-state → badge, and the compact queue date.
 *
 * Kept JSX-free so the derivations are trivially testable and the queue
 * components stay presentational. Row/detail types are derived from the live
 * `api.reimbursements` return shapes so the UI can't drift from the backend.
 */
import type { FunctionReturnType } from "convex/server";
import {
  REIMBURSEMENT_TERMINAL_STATUSES,
  type ReimbursementStatus,
} from "@events-os/shared";
import { api } from "@events-os/convex/_generated/api";
import type { BadgeTone, IconName } from "../../ui";

/** One row of the approval queue — the exact `list` return shape. */
export type ReimbursementRow =
  FunctionReturnType<typeof api.reimbursements.list>[number];

/** A single request + its lines — the exact `get` return shape. */
export type ReimbursementDetail = FunctionReturnType<
  typeof api.reimbursements.get
>;

/** One line item within a request. */
export type ReimbursementLine = ReimbursementDetail["lines"][number];

// ── Filter pills (drive the `list({status})` arg) ────────────────────────────
export type FilterKey = "all" | "preapproval" | "submitted" | "paying";

export const FILTERS: {
  key: FilterKey;
  label: string;
  /** The `status` arg passed to `list` (undefined = All). */
  status?: ReimbursementStatus;
}[] = [
  { key: "all", label: "All" },
  { key: "preapproval", label: "Pre-approval", status: "pending_preapproval" },
  { key: "submitted", label: "Submitted", status: "submitted" },
  { key: "paying", label: "Paying", status: "paying" },
];

// ── Status → badge tone + icon ───────────────────────────────────────────────
export const STATUS_BADGE: Record<
  ReimbursementStatus,
  { tone: BadgeTone; icon: IconName }
> = {
  pending_preapproval: { tone: "warn", icon: "clock" },
  preapproved: { tone: "success", icon: "check" },
  submitted: { tone: "accent", icon: "clock" },
  approved: { tone: "success", icon: "check" },
  paying: { tone: "info", icon: "refresh-cw" },
  paid: { tone: "info", icon: "check-circle" },
  rejected: { tone: "danger", icon: "x-circle" },
  failed: { tone: "danger", icon: "alert-triangle" },
  canceled: { tone: "neutral", icon: "slash" },
};

// ── Receipts coverage → badge ────────────────────────────────────────────────
export const RECEIPTS_BADGE: Record<
  ReimbursementRow["receiptsState"],
  { label: string; tone: BadgeTone; icon: IconName }
> = {
  complete: { label: "Receipts attached", tone: "success", icon: "check" },
  partial: { label: "Some receipts", tone: "warn", icon: "alert-triangle" },
  none: { label: "No receipts", tone: "neutral", icon: "file" },
};

// ── Action gating (mirrors the backend transition guards) ────────────────────
const TERMINAL = new Set<ReimbursementStatus>(REIMBURSEMENT_TERMINAL_STATUSES);

/** Statuses where a manager can approve (full or partial) — matches `approve`. */
export function canApprove(status: ReimbursementStatus): boolean {
  return status === "submitted" || status === "preapproved";
}

/** The single state that offers pre-approval — matches `preApprove`. */
export function canPreApprove(status: ReimbursementStatus): boolean {
  return status === "pending_preapproval";
}

/** Whether the request still awaits a manager decision (Reject/Decline shown). */
export function isActionable(status: ReimbursementStatus): boolean {
  return canApprove(status) || canPreApprove(status);
}

export function isTerminal(status: ReimbursementStatus): boolean {
  return TERMINAL.has(status);
}

/** Non-terminal requests count toward the header's "N open · $X". */
export function isOpen(status: ReimbursementStatus): boolean {
  return !TERMINAL.has(status);
}

// ── Date ─────────────────────────────────────────────────────────────────────
const TZ = "America/New_York";

/** `Jul 12` — the compact queue date. */
export function shortDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    timeZone: TZ,
  });
}
