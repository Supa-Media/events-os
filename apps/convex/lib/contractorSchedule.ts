/**
 * Reading a contractor agreement's payment SCHEDULE — the tranches of "half
 * now, half on delivery".
 *
 * Everything here is about answering three questions the same way everywhere
 * they are asked: does this agreement pay in parts, how much of it has actually
 * gone out, and is it finished? The schedule is the only place in the contractor
 * rail where the agreed total and the amount paid are allowed to differ, so the
 * arithmetic lives in ONE module rather than being re-derived by the payout
 * rail, the detail screen, the contractor's own page and the ledger.
 *
 * PURE + READ-ONLY HELPERS ONLY — nothing in `lib/` registers Convex functions,
 * and nothing here writes. The transitions themselves live in
 * `contractorInstallments.ts` (compose/cancel) and `lib/increasePayoutMachine.ts`
 * (the settle path), which is where the money is.
 */
import {
  contractorScheduleIsComplete,
  summarizeContractorSchedule,
} from "@events-os/shared";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export type ContractorInstallmentDoc = Doc<"contractorPaymentInstallments">;

/**
 * An agreement's tranches in agreed order.
 *
 * `MAX_CONTRACTOR_INSTALLMENTS` bounds this to twelve rows, so a `collect()`
 * here is bounded by a rule the writer enforces rather than by hope — but the
 * index is ordered by `seq` regardless, because the ORDER is part of the deal
 * being read back (a schedule rendered out of order is a different deal).
 */
export async function loadSchedule(
  ctx: QueryCtx,
  contractorPaymentId: Id<"contractorPayments">,
): Promise<ContractorInstallmentDoc[]> {
  return await ctx.db
    .query("contractorPaymentInstallments")
    .withIndex("by_payment", (q) =>
      q.eq("contractorPaymentId", contractorPaymentId),
    )
    .collect();
}

/** Does this agreement pay in parts at all? The question every payout path asks
 *  first, because the answer decides whether the subject of the next ACH is the
 *  agreement or one of its tranches. */
export async function hasSchedule(
  ctx: QueryCtx,
  contractorPaymentId: Id<"contractorPayments">,
): Promise<boolean> {
  const first = await ctx.db
    .query("contractorPaymentInstallments")
    .withIndex("by_payment", (q) =>
      q.eq("contractorPaymentId", contractorPaymentId),
    )
    .first();
  return first != null;
}

/**
 * The schedule and its totals in one read — what a screen renders and what the
 * settle path decides on.
 *
 * `complete` is deliberately false for an agreement with NO schedule: an
 * unscheduled agreement is not an empty finished schedule, it is a payment that
 * this concept does not apply to, and conflating the two would let the settle
 * path close an agreement it never opened.
 */
export async function readSchedule(
  ctx: QueryCtx,
  contractorPaymentId: Id<"contractorPayments">,
): Promise<{
  rows: ContractorInstallmentDoc[];
  summary: ReturnType<typeof summarizeContractorSchedule>;
  scheduled: boolean;
  complete: boolean;
}> {
  const rows = await loadSchedule(ctx, contractorPaymentId);
  return {
    rows,
    summary: summarizeContractorSchedule(rows),
    scheduled: rows.length > 0,
    complete: rows.length > 0 && contractorScheduleIsComplete(rows),
  };
}

/**
 * How much of an agreement has actually left the building, and how much has
 * not — the founder's question ("we know we've paid this halfway"), answered
 * identically for scheduled and unscheduled agreements.
 *
 * An UNSCHEDULED agreement still has an honest answer, and giving it one here
 * rather than making every caller special-case the absence is the point: it has
 * paid its whole approved amount if it is `paid`, and none of it otherwise.
 */
export async function paidProgress(
  ctx: QueryCtx,
  row: Doc<"contractorPayments">,
): Promise<{ paidCents: number; remainingCents: number; scheduled: boolean }> {
  const rows = await loadSchedule(ctx, row._id);
  if (rows.length === 0) {
    const committed = row.approvedCents ?? row.agreedAmountCents;
    const paidCents = row.status === "paid" ? committed : 0;
    return {
      paidCents,
      remainingCents: committed - paidCents,
      scheduled: false,
    };
  }
  const summary = summarizeContractorSchedule(rows);
  return {
    paidCents: summary.paidCents,
    remainingCents: summary.remainingCents,
    scheduled: true,
  };
}

/** The tranche a payout settles, when it settles one. Returns `null` for an
 *  unscheduled payout rather than throwing — "no tranche" is the normal case
 *  on this rail, not an error. */
export async function installmentForPayout(
  ctx: QueryCtx,
  payout: Doc<"payouts">,
): Promise<ContractorInstallmentDoc | null> {
  if (!payout.contractorInstallmentId) return null;
  return await ctx.db.get(payout.contractorInstallmentId);
}

/** "Deposit (1 of 3)" — how a tranche names itself in a ledger description, an
 *  email subject, or an audit note. One helper so the ledger row and the email
 *  the contractor receives never disagree about which payment this was. */
export function describeInstallment(
  inst: Pick<ContractorInstallmentDoc, "label" | "seq">,
  total: number,
): string {
  return `${inst.label} (${inst.seq} of ${total})`;
}
