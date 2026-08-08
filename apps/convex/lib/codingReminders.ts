/**
 * Coding reminders — the chase for SUBSTANTIATION, not for receipts.
 *
 * The reminder unit is the CODING (owner decision, 2026-08-08): a receipt is
 * one field of a coding, not its own nag stream, so a charge with a receipt
 * but no business purpose is chased exactly as hard as one with neither. This
 * module owns the shared predicates + copy that the cardholder digest, the
 * escalation stages, and the overdue sweep all read, so the three can't drift
 * on what "still owes something" means.
 *
 * See `docs/plans/transaction-coding.md` (phase 2).
 */
import {
  DEFAULT_CODING_OVERDUE_DAYS,
  type TransactionCodingStatus,
} from "@events-os/shared";
import type { QueryCtx } from "../_generated/server";

/** The org's substantiation deadline in ms, falling back to the IRS safe
 *  harbor (`DEFAULT_CODING_OVERDUE_DAYS`, 60 days). */
export async function codingOverdueMs(ctx: QueryCtx): Promise<number> {
  const settings = await ctx.db.query("financeSettings").first();
  const days = settings?.codingOverdueDays ?? DEFAULT_CODING_OVERDUE_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

/** What a cardholder still owes on one charge, as the digest phrases it.
 *  `null` when the row is settled from the cardholder's point of view. */
export function outstandingLabel(args: {
  hasDocumentation: boolean;
  codingState: TransactionCodingStatus | undefined;
  requiresCoding: boolean;
}): string | null {
  const needsCoding =
    args.requiresCoding &&
    (args.codingState == null || args.codingState === "changes_requested");
  if (needsCoding && !args.hasDocumentation) return "needs coding and a receipt";
  if (needsCoding) {
    return args.codingState === "changes_requested"
      ? "sent back — needs your edit"
      : "needs coding";
  }
  if (!args.hasDocumentation) return "needs a receipt";
  return null;
}
