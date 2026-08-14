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
  RECEIPT_ESCALATE_DAYS,
  isNonDiscretionaryFee,
  type TransactionCodingStatus,
} from "@events-os/shared";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

// Mirrors the same local constant every other file in `apps/convex` defines
// for itself (`cards.ts`, `finances.ts`, ...) rather than importing — one
// number, not worth a cross-module dependency.
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The reminder stage a charge's AGE alone implies as of `now` — day-1
 * "flagged", day-`RECEIPT_ESCALATE_DAYS` "escalated", the same two
 * thresholds `cards.ts#advanceReceiptReminders` transitions on (and now
 * reads THIS function for, rather than each keeping its own copy of the cutoffs).
 *
 * Pure and age-only: it doesn't know or care whether the charge is currently
 * chase-eligible (`chargeOutstanding`) — that's the caller's job. Exists so a
 * caller that needs to RE-STAMP a stage without sending an email (e.g.
 * `unflagPersonalCharge` undoing a mistaken personal flag) can ask "what
 * would the sweep have set this to" without duplicating its day-threshold
 * arithmetic — which is exactly how a flag→unflag round-trip used to produce
 * a duplicate escalation email: clearing the stage on flag left the sweep
 * unable to tell "already escalated, about to be re-flagged" apart from
 * "brand new," so it re-transitioned (and re-emailed) on the very next run.
 */
export function stageForAge(
  postedAt: number,
  now: number,
): "none" | "flagged" | "escalated" {
  const ageMs = now - postedAt;
  if (ageMs > RECEIPT_ESCALATE_DAYS * DAY_MS) return "escalated";
  if (ageMs > DAY_MS) return "flagged";
  return "none";
}

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
 *
 * A PROCESSOR FEE IS NOT CHASEABLE AT ALL — the carve-out this predicate was
 * missing. `finances.needsDocumentation`, `isUndocumented` and `requiresCoding`
 * all exempt `feeOrigin` rows; this one did not, so a Stripe/Givebutter fee row
 * (written `flow:"outflow"`, `status:"categorized"`, receipt-less by nature —
 * `processorFees.ts`) came back from `chargeOutstanding` as "needs a receipt"
 * (pre-policy) or "needs coding and a receipt" (post-policy) and entered
 * `receiptChase`, `chaseCount`, `manualNudgeTargets` and the digest. The
 * documentation predicate said the row owed nothing while the chase demanded
 * two things from it. It owes neither: nobody chose the fee, and the
 * processor's own itemized ledger (`processorFeeEntries`) IS its record —
 * there is no receipt to send, ever (founder, 2026-08-12: "I literally dont
 * have receipts").
 *
 * BY ORIGIN, NOT BY CATEGORY: a Givebutter paid subscription the org CHOSE to
 * buy lands in the same "Bank & Fees" category and is still budgeted, coded and
 * chased. `isNonDiscretionaryFee` (`@events-os/shared`) is the one place that
 * distinction is drawn — shared rather than re-copied here precisely because
 * copying it is how these three predicates drifted apart.
 */
function chaseEligible(tr: Doc<"transactions">): boolean {
  if (isNonDiscretionaryFee(tr)) return false;
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
    // The POLICY DATE only. The other half of `finances.requiresCoding` — the
    // spend test and the processor-fee exemption — is `chaseEligible` above,
    // which has already run. Keep it that way: a fee exemption written HERE
    // would still leave a fee row answering "needs a receipt", because the
    // receipt half of the label doesn't consult this flag at all.
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
 *
 * The processor-fee exemption is NOT hand-kept: it comes from `chaseEligible`,
 * which reads the shared `isNonDiscretionaryFee`. Hand-keeping that one is
 * exactly what failed — it was mirrored into `finances.requiresCoding` and into
 * `transactionCodings.getForTransaction` and missed here, so the coding chase
 * nagged for fees the coding editor said needed no coding.
 */
export function isUncodedCharge(
  tr: Doc<"transactions">,
  sinceMs: number,
): boolean {
  if (!chaseEligible(tr)) return false;
  if (tr.postedAt < sinceMs) return false;
  return tr.codingState == null || tr.codingState === "changes_requested";
}
