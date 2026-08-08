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
import type { Doc } from "../_generated/dataModel";
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
  // SENT BACK OUTRANKS EVERYTHING ELSE THIS ROW OWES.
  //
  // A reviewer wrote this person a specific note, and that note is the only
  // instruction that tells them what to actually do — "needs coding and a
  // receipt" describes the same row correctly and helps nobody. It also has
  // to come first for a plainer reason: the member's own screen
  // (`chargeTodo`) ranks a sent-back charge above everything, so ordering the
  // combined case ahead of it here made the email and the screen name the
  // same charge differently in the single most common send-back case (a row
  // sent back precisely BECAUSE its receipt was wrong, i.e. still
  // undocumented). The two must agree — that agreement is the whole reason
  // this function is shared.
  if (needsCoding && args.codingState === "changes_requested") {
    return "sent back — needs your edit";
  }
  if (needsCoding && !args.hasDocumentation) return "needs coding and a receipt";
  if (needsCoding) return "needs coding";
  if (!args.hasDocumentation) return "needs a receipt";
  return null;
}

/** True iff the row can prove itself with a document: a receipt, or the
 *  approved exception that stands in for one. The same pair
 *  `finances.isUndocumented` reads — kept here so the chase and the
 *  publishing backlog agree on what "documented" means. */
export function isDocumented(tr: Doc<"transactions">): boolean {
  return tr.receiptStorageId != null || tr.approvedReceiptExceptionId != null;
}

/**
 * The rows a cardholder can be chased on at all: their own open SPEND.
 *
 * CHASE semantics, like `finances.needsDocumentation` — a closed row
 * (`excluded`/`reconciled`) has nobody left to chase, and a personal charge is
 * money being repaid rather than an expense awaiting substantiation. Both are
 * the same carve-outs `cards.isMissingReceiptCharge` has always made; this
 * predicate is the coding-era superset of it.
 */
function chaseEligible(tr: Doc<"transactions">): boolean {
  return (
    tr.flow === "outflow" &&
    tr.status !== "excluded" &&
    tr.status !== "reconciled" &&
    tr.isPersonal !== true
  );
}

/**
 * What a cardholder still owes on ONE of their charges, or `null` when there
 * is nothing left to ask them for.
 *
 * THE chase predicate: the digest email, the `receiptReminderStage` timeline
 * and the manual FM nudge all read this one function, so "you have 3 charges
 * to code" can never disagree with the three rows the sweep transitioned.
 * `sinceMs` is the coding policy date (`lib/transactionCoding.ts#codingPolicy`)
 * — pre-policy history owes a receipt and nothing more, which is what keeps
 * September 1 from turning years of ledger into an overnight backlog.
 */
export function chargeOutstanding(
  tr: Doc<"transactions">,
  sinceMs: number,
): string | null {
  if (!chaseEligible(tr)) return null;
  return outstandingLabel({
    hasDocumentation: isDocumented(tr),
    codingState: tr.codingState,
    requiresCoding: tr.postedAt >= sinceMs,
  });
}

/**
 * True iff a row the coding policy covers is STILL waiting on its author —
 * the state the 60-day accountable-plan clock runs against.
 *
 * MIRRORS `finances.isUncoded` (and the `requiresCoding` it builds on) rather
 * than importing it: `finances.ts` already imports helpers FROM `cards.ts`,
 * this module's only consumer, and importing back would close that cycle —
 * the same reason `cards.ts` keeps its own copies of `txnMatchesMode` et al.
 * The two must be kept in sync by hand.
 */
export function isUncodedCharge(
  tr: Doc<"transactions">,
  sinceMs: number,
): boolean {
  if (!chaseEligible(tr)) return false;
  if (tr.postedAt < sinceMs) return false;
  return tr.codingState == null || tr.codingState === "changes_requested";
}
