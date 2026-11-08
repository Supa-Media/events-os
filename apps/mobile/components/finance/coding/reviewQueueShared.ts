/**
 * Types and small display helpers shared by the review queue's list
 * (`ReviewQueue`) and its decision pane (`ReviewDecisionPane`). Split out so
 * neither file imports the other for a type.
 */
import { colors } from "../../../lib/theme";

export interface ReviewQueueRow {
  transactionId: string;
  book: { id: string; name: string };
  merchantName: string | null;
  amountCents: number;
  postedAt: number;
  documentation: "receipt" | "exception_approved" | "exception_pending" | "none";
  canReview: boolean;
  /** This charge owes a budget and hasn't got one — `approve` refuses it
   *  (founder, 2026-09-02: "we shouldn't be letting things go through without
   *  a budget"). The pane says so next to a disabled Approve, and the record
   *  opens its edit panel so the reviewer can set it themselves. */
  budgetRequired: boolean;
  /** Who SHOULD decide it — the chapter's Treasurer / Central's Financial
   *  Manager by default, the Chapter Director / ED when the Treasurer / FM
   *  coded it (two-party control). `canReview` is wider: any approval seat may
   *  step in as backup. `null` when no seat is assignable. */
  reviewer: {
    seatTitle: string;
    scopeName: string;
    names: string[];
    why: "default" | "coded_by_bookkeeper" | "chapter_has_no_reviewer";
  } | null;
  /** The caller is the assigned reviewer. */
  assignedToMe: boolean;
  coding: {
    expenseType: string;
    expenseTypeLabel: string;
    businessPurpose: string;
    travelFrom: string | null;
    travelTo: string | null;
    headcount: number | null;
    attendees: { name: string; affiliation: string }[] | null;
    affiliationBreakdown: Record<string, number>;
    groupDescription: string | null;
    publicPurpose: string | null;
    publicPurposeByName: string | null;
    publicPurposeAt: number | null;
    codedByName: string | null;
    submittedAt: number;
  };
}

/** The screen's `useActionRunner().run` — it owns the error toast, so a
 *  refused decision surfaces the server's own message rather than a generic
 *  one invented here. */
export type RunAction = (
  action: () => Promise<unknown>,
  options?: { errorTitle?: string },
) => Promise<unknown>;

export function money(cents: number): string {
  return `$${(Math.abs(cents) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export const DOCUMENTATION_DISPLAY: Record<
  ReviewQueueRow["documentation"],
  { label: string; icon: "paperclip" | "file-text" | "clock" | "alert-triangle"; color: string }
> = {
  receipt: { label: "Receipt", icon: "paperclip", color: colors.success },
  exception_approved: {
    label: "Exception approved",
    icon: "file-text",
    color: colors.success,
  },
  exception_pending: {
    label: "Exception pending",
    icon: "clock",
    color: colors.warn,
  },
  // Unreachable on a submitted coding — the documentation gate refuses one.
  // Rendered loudly rather than silently, because if it ever appears it means
  // a rule stopped holding, not that a row is untidy.
  none: { label: "No proof", icon: "alert-triangle", color: colors.danger },
};
