/**
 * Refund-pairing GUARDS + WRITES, extracted from `finances.markAsRefund` so
 * the HUMAN mutation and the Increase AUTO-PAIRER
 * (`increaseLedger.ts#applyIncreaseCardTransaction`) can never drift on what
 * counts as a valid refund pair. `checkRefundPair` is the exact refusal logic
 * `markAsRefund` used to inline; `writeRefundPair` is the exact pairing
 * writes (the two `ctx.db.patch` calls + the matching `financeAuditLog`
 * pair) it used to inline. Both callers run the SAME code — a change to one
 * changes both, which is the whole point.
 *
 * See `finances.markAsRefund`'s own doc comment for the full "why" (full
 * refunds only, what gets refused, what marking also ends) — that reasoning
 * is not repeated here.
 */
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { logFinanceAudit } from "./financeAuditLog";
import type { FinanceScope } from "./finance";

export type RefundPairRefusalCode =
  | "SAME_TRANSACTION"
  | "CROSS_SCOPE_REFUND"
  | "NOT_A_PAIR"
  | "PARTIAL_REFUND"
  | "CURRENCY_MISMATCH"
  | "ALREADY_REFUND"
  | "IS_TRANSFER"
  | "IS_PAYOUT";

export interface RefundPairRefusal {
  code: RefundPairRefusalCode;
  message: string;
}

/**
 * The exact rules a (charge, refund) pair must pass to be marked — SAME
 * scope, opposite flow, exactly-equal amount (full refunds only, same
 * PARTIAL_REFUND stance as `markAsRefund`), same currency, neither leg
 * already refunded/a transfer leg/payout-marked. Returns `null` when the
 * pair is valid; a refusal (code + human message) otherwise. Never throws —
 * the auto-pairer needs to just walk away from an ambiguous/invalid pair,
 * not blow up an ingestion webhook over it.
 */
export function checkRefundPair(
  charge: Doc<"transactions">,
  refund: Doc<"transactions">,
): RefundPairRefusal | null {
  if (charge._id === refund._id) {
    return {
      code: "SAME_TRANSACTION",
      message: "A refund needs two different rows — the charge and the credit.",
    };
  }
  if (charge.chapterId !== refund.chapterId) {
    return {
      code: "CROSS_SCOPE_REFUND",
      message:
        "Those rows belong to different books. A refund lands back on the book that paid.",
    };
  }
  if (charge.flow !== "outflow" || refund.flow !== "inflow") {
    return {
      code: "NOT_A_PAIR",
      message:
        "A refund is one charge going out and one credit coming back — pick one of each.",
    };
  }
  if (charge.amountCents !== refund.amountCents) {
    return {
      code: "PARTIAL_REFUND",
      message:
        "Only a full refund can be marked — these amounts differ. Leave a partial refund coded as income against the same budget.",
    };
  }
  if ((charge.currency ?? "usd") !== (refund.currency ?? "usd")) {
    return { code: "CURRENCY_MISMATCH", message: "Those two rows are in different currencies." };
  }
  for (const leg of [charge, refund]) {
    if (leg.refundsTransactionId != null || leg.refundedByTransactionId != null) {
      return {
        code: "ALREADY_REFUND",
        message: "One of those rows is already part of a refund.",
      };
    }
    if (leg.transferGroupId != null) {
      return {
        code: "IS_TRANSFER",
        message:
          "One of those rows is part of a transfer. Un-mark it first if it's really a refund.",
      };
    }
    if (leg.stripePayoutId != null) {
      // Same class as `payoutProcessor` below: an engine-matched payout
      // deposit signs to zero, so pairing against it would leave a refund
      // pair that doesn't net (Opus audit, 2026-08-13).
      return {
        code: "IS_PAYOUT",
        message: "One of those rows was matched to a processor payout by the reconciliation engine.",
      };
    }
    if (leg.payoutProcessor != null) {
      return { code: "IS_PAYOUT", message: "One of those rows is marked as a processor payout." };
    }
  }
  return null;
}

export interface WriteRefundPairOpts {
  note?: string | null;
  /** The caller's roster person id, for `financeAuditLog`'s `actorPersonId`
   *  (both legs log the SAME actor — `markAsRefund` requires same-scope
   *  legs, so both `requireReconcileTxn` calls resolve identically). Omitted
   *  (never resolvable) for the auto-pairer. */
  actorPersonId?: Id<"people"> | null;
  /** True for the Increase auto-pairer: writes `action:"refund_mark_auto"`
   *  instead of `"refund_mark"` and logs with `system:true` (no
   *  authenticated actor to resolve) — see `financeAuditLog`'s `system`
   *  option and the schema doc on `financeAuditLog.actorUserId`. */
  auto?: boolean;
}

/**
 * Perform the pairing writes `markAsRefund` performs: the charge gets
 * `refundedByTransactionId`, the credit gets `refundsTransactionId` (+
 * inherits the charge's category/budget for legibility only — an inflow is
 * never spend, so this moves no total), and BOTH rows log to
 * `financeAuditLog`. Does NOT re-check guards — callers MUST call
 * `checkRefundPair` first and only call this when it returned `null`, so the
 * two can never validate differently.
 */
export async function writeRefundPair(
  ctx: MutationCtx,
  charge: Doc<"transactions">,
  refund: Doc<"transactions">,
  opts: WriteRefundPairOpts = {},
): Promise<void> {
  const trimmedNote = opts.note?.trim() || null;

  await ctx.db.patch(charge._id, {
    refundedByTransactionId: refund._id,
    ...(trimmedNote && !charge.note ? { note: trimmedNote } : {}),
  });
  await ctx.db.patch(refund._id, {
    refundsTransactionId: charge._id,
    // Legibility only — an inflow is never spend, so this moves no total.
    ...(charge.categoryId ? { categoryId: charge.categoryId } : {}),
    ...(charge.budgetId ? { budgetId: charge.budgetId } : {}),
    ...(trimmedNote && !refund.note ? { note: trimmedNote } : {}),
  });

  const action = opts.auto ? "refund_mark_auto" : "refund_mark";
  for (const leg of [charge, refund]) {
    await logFinanceAudit(ctx, {
      chapterId: leg.chapterId as FinanceScope,
      subjectType: "transaction",
      subjectId: leg._id,
      action,
      actorPersonId: opts.actorPersonId ?? null,
      field: "refund",
      before: "none",
      after: opts.auto ? "refunded (auto-paired via Increase card_payment_id)" : "refunded",
      reason: trimmedNote,
      amountCents: leg.amountCents,
      system: opts.auto === true,
    });
  }
}
