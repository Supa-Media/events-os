/**
 * The reimbursement-payout state machine — the pure-DB core `increasePayouts.ts`
 * and the webhook path drive (testable WITHOUT hitting Increase). Covers:
 * settling a paid payout (the `outflow` ledger row that IS the reimbursed
 * expense), mapping fetched ACH-transfer statuses to payout targets, and the
 * guarded transitions including the late-`returned` reversal of an
 * already-`paid` payout.
 *
 * PURE HELPERS ONLY — nothing in `lib/` registers Convex functions. It does
 * SCHEDULE one (the claimant's paid notice, off `settleReimbursementPaid`),
 * which is the established shape for a `lib/` helper that has to fire a
 * side-effect off a transition it owns — see `lib/givingDonors.ts` and
 * `lib/receiptRetry.ts`.
 */
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { Doc, Id } from "../_generated/dataModel";
import { materializeReimbursementReceipts } from "./reimbursementReceipts";
import {
  deriveReimbursementCodingMaterialization,
  deriveReimbursementTxnFields,
} from "./reimbursementTxnFields";
import {
  codingPolicy,
  materializePortedReimbursementCoding,
} from "./transactionCoding";

/**
 * The single transaction recording a reimbursement payout leaving the account.
 * IDEMPOTENT: at most one per reimbursement (keyed via the `by_reimbursement`
 * index). Positive integer cents; direction lives in `flow`. Links the payout
 * to the txn.
 *
 * `flow:"outflow"` — this row IS the expense. A reimbursement is money the
 * chapter owes for a purchase someone made out of pocket; no card charge ever
 * synced for it, so this is the only place that spend can enter the ledger.
 *
 * It used to post as `flow:"transfer"` (excluded from spend by
 * `countsAsSpend`) on the theory that the expense was already booked against
 * its category from the reimbursement's line items. Nothing ever booked it:
 * `reimbursementLineItems` is read by no spend rollup, and its
 * `matchedTransactionId` (the documented link to an already-synced txn) is
 * never written. The result was reimbursed spend that appeared coded to a
 * budget and category in the UI while contributing $0 to both. Migration
 * `0044_reimbursement_payouts_outflow` flips the historical rows.
 */
export async function postReimbursementSpend(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  req: Doc<"reimbursementRequests">,
  payout: Doc<"payouts">,
): Promise<Id<"transactions">> {
  const existing = await ctx.db
    .query("transactions")
    .withIndex("by_reimbursement", (q) => q.eq("reimbursementId", req._id))
    .first();
  if (existing) {
    if (!payout.transactionId) {
      await ctx.db.patch(payout._id, {
        transactionId: existing._id,
        updatedAt: Date.now(),
      });
    }
    return existing._id;
  }
  const now = Date.now();
  // Inherit the reimbursement's own description / merchant / "For" / purpose /
  // category / receipt so the payout row is self-explanatory in Reconcile
  // instead of an "Unlabeled charge / Uncategorized / For: None / missing
  // receipt". Now that the row is `flow:"outflow"`, these are the LIVE
  // attribution the budget/category rollups read — the same fields a
  // bookkeeper would otherwise have to re-key by hand.
  const ported = await deriveReimbursementTxnFields(ctx, req);
  const txnId = await ctx.db.insert("transactions", {
    chapterId,
    source: "reimbursement",
    flow: "outflow", // the expense itself — counts toward category/budget spend
    amountCents: payout.amountCents,
    currency: "usd",
    postedAt: now,
    personId: req.personId,
    reimbursementId: req._id,
    status: "reconciled",
    createdAt: now,
    ...ported,
  });
  await ctx.db.patch(payout._id, { transactionId: txnId, updatedAt: now });

  // The receipts the claimant filed become REAL receipts, linked to this row —
  // which is also what sets the row's `receiptStorageId` cache. Previously the
  // cache was copied on directly and no `receipts` row was ever made, so the
  // charge read "receipt attached" while the Receipts library could not find
  // the document at all. See `lib/reimbursementReceipts.ts`.
  await materializeReimbursementReceipts(ctx, {
    req,
    transactionId: txnId,
    chapterId,
  });

  // MATERIALIZE the coding from the request's own approved testimony, so
  // nobody has to re-type what the claimant already wrote and a reviewer
  // already approved (founder directive, 2026-08-13). Deliberately narrow —
  // see `deriveReimbursementCodingMaterialization`'s own doc for the rule; a
  // multi-line or incomplete request is left for the normal human flow
  // (`reimbursementContext` prefill in `transactionCodings.ts`).
  const { namesMaxHeadcount } = await codingPolicy(ctx);
  const materialization = await deriveReimbursementCodingMaterialization(
    ctx,
    req,
    namesMaxHeadcount,
  );
  if (materialization.eligible) {
    await materializePortedReimbursementCoding(ctx, {
      transactionId: txnId,
      scope: chapterId,
      fields: materialization.fields,
      namesMaxHeadcount,
      codedByPersonId: materialization.codedByPersonId,
      codedByUserId: materialization.codedByUserId,
      decidedByPersonId: materialization.decidedByPersonId,
      decidedByUserId: materialization.decidedByUserId,
      decidedAt: materialization.decidedAt,
      submittedAt: materialization.submittedAt,
      approvalParty: materialization.approvalParty,
      portedFromReimbursementId: req._id,
    });
  }

  return txnId;
}

/** Settle a payout: mark the reimbursement `paid` + post the `outflow` ledger
 *  row for the expense, and tell the CLAIMANT their money went out. Idempotent
 *  via `postReimbursementSpend`.
 *
 *  THE ONE PLACE A REIMBURSEMENT BECOMES PAID, which is why the notice hangs
 *  here rather than at either call site. Both rails end up in this function:
 *  the ACH webhook via `applyPayoutOutcome`, and a treasurer's
 *  `increasePayouts.markPaidManually`. Hooking the two of them separately would
 *  have worked today and quietly failed the first time somebody adds a third
 *  way to pay — the same argument the `postReimbursementSpend` call above is
 *  already making.
 *
 *  Scheduled rather than sent inline for the reason every notice in this
 *  codebase is: a mutation must not do network I/O, and a Resend hiccup must
 *  never fail a payout that has already committed
 *  (`reimbursements.sendReimbursementPaidEmail` carries the send-side half of
 *  that guarantee in its own try/catch). Inside the `status !== "paid"` guard on
 *  purpose: a re-settle of an already-paid row is a no-op here, so it must not
 *  queue a job either — and the claim in `markPaidNoticeSent` would refuse it
 *  anyway. */
export async function settleReimbursementPaid(
  ctx: MutationCtx,
  req: Doc<"reimbursementRequests">,
  payout: Doc<"payouts">,
): Promise<void> {
  const now = Date.now();
  if (req.status !== "paid") {
    await ctx.db.patch(req._id, {
      status: "paid",
      paidAt: req.paidAt ?? now,
      payoutId: payout._id,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.reimbursements.sendReimbursementPaidEmail,
      { reimbursementId: req._id },
    );
  }
  await postReimbursementSpend(ctx, req.chapterId, req, payout);
}

/** The payout status an inbound Increase ACH-transfer maps to (or null = ignore).
 *
 * Increase webhook events carry no inline status — `handleIncreaseWebhook`
 * FETCHES the ACH transfer (GET /ach_transfers/{id}) and passes its real
 * `status` here alongside the event `category` (`ach_transfer.created` /
 * `.updated`). Real Increase ACH-transfer statuses (there is NO post-settlement
 * "settled"/"paid" status — an outbound CREDIT is irrevocably sent at
 * `submitted`, so that IS our terminal "paid"; a `returned` may arrive days
 * later):
 *   - `returned`                                              → returned
 *   - `rejected` / `canceled`                                 → failed
 *   - `submitted`                                             → paid
 *   - `pending_approval` / `pending_submission` /
 *     `pending_reviewing` / `pending_transfer_session_confirmation`
 *                                                             → processing
 *   - `requires_attention` (and anything unrecognized)        → null (no change;
 *     a human investigates — never auto-fail or auto-pay it).
 * `settled`/`paid` stay accepted (harmless) for forward-compat. */
export type PayoutTarget = "processing" | "paid" | "failed" | "returned";
export function payoutTargetFor(
  eventType: string,
  status?: string,
): PayoutTarget | null {
  const s = (status ?? "").toLowerCase();
  const e = eventType.toLowerCase();
  if (s === "returned" || e.includes("returned")) return "returned";
  if (
    ["failed", "rejected", "canceled", "declined"].includes(s) ||
    e.includes("failed") ||
    e.includes("rejected") ||
    e.includes("canceled")
  ) {
    return "failed";
  }
  // `submitted` = the CREDIT has been sent to the network (Increase's terminal
  // success for an ACH credit — there is no later "settled" event).
  if (
    ["submitted", "settled", "complete", "completed", "paid"].includes(s) ||
    e.includes("settled") ||
    e.includes("submitted") ||
    e.includes("paid")
  ) {
    return "paid";
  }
  // `requires_attention` means a human must act in the Increase dashboard — do
  // NOT auto-advance the payout (leave it where it is), even though the carrier
  // event is `ach_transfer.updated`.
  if (s === "requires_attention") return null;
  if (s.startsWith("pending") || ["created", "processing"].includes(s)) {
    return "processing";
  }
  // No fetched status (or an `ach_transfer.created`/`.updated` we can't classify
  // yet): treat a bare lifecycle event as still in-flight.
  if (e.includes("created") || e.includes("updated")) return "processing";
  return null;
}

/**
 * Reverse an already-`paid` payout whose ACH credit bounced (`returned`) DAYS
 * after Increase reported `submitted` (there is no post-settlement "settled"
 * event for an ACH credit — `submitted` IS our terminal `paid`, so a return is
 * the only signal that can still arrive after the fact). Re-opens the
 * reimbursement to `approved` so a manager can retry or investigate, and
 * REMOVES the ledger row this payout posted.
 *
 * Deleting (rather than merely re-flagging) the transaction is deliberate:
 * the money never left the account, so its spend must come back OUT of the
 * budget/category totals it now (`flow:"outflow"`) contributes to — the
 * chapter re-books it when the retried payout posts a fresh row. It also MUST
 * be removed — `postReimbursementSpend` finds an existing row for this
 * reimbursement via `by_reimbursement` UNCONDITIONALLY (no status filter), so
 * leaving the bounced row in place would make a future successful re-payout
 * mistake it for "already posted" and silently skip booking the real
 * payout. The full bounce history survives on the `payouts` row itself
 * (`status:"returned"` + `failureReason`) — this repo has no existing
 * transaction-level void/reversal convention to mirror, so the payout doc is
 * the audit trail here, same as the pre-paid `failed`/`returned` branch below
 * (which also doesn't touch `approvals`).
 */
async function reverseSettledPayout(
  ctx: MutationCtx,
  req: Doc<"reimbursementRequests"> | null,
  payout: Doc<"payouts">,
  failureReason?: string,
): Promise<void> {
  const now = Date.now();
  const transactionId = payout.transactionId;
  await ctx.db.patch(payout._id, {
    status: "returned",
    failureReason,
    transactionId: undefined,
    updatedAt: now,
  });
  // Only walk back a reimbursement THIS payout actually settled — defense
  // against a manager having already reconciled it some other way in between.
  if (req && req.status === "paid") {
    await ctx.db.patch(req._id, {
      status: "approved",
      paidAt: undefined,
      // Give back the claimant's paid notice. We told them their money was
      // sent and then it came back out, so the claim we made is no longer
      // true; when a manager retries and THAT settles, it is a different, real
      // payment on a later date and they have never been told about it.
      // Clearing here is what lets `markPaidNoticeSent` hand out a second
      // notice for exactly this case and no other — see
      // `lib/reimbursementPaidEmail.ts`'s header. Note the contrast with
      // `approvedNoticeSentAt`, deliberately left alone: the approval never
      // stopped being true.
      paidNoticeSentAt: undefined,
      updatedAt: now,
    });
  }
  if (transactionId) {
    const txn = await ctx.db.get(transactionId);
    if (txn && req && txn.reimbursementId === req._id) {
      await ctx.db.delete(transactionId);
    }
  }
}

/**
 * Advance a payout toward `target`, guarding illegal transitions.
 *
 * `canceled` is fully terminal. `failed`/`returned` are terminal too EXCEPT
 * they idempotently no-op a REPEATED delivery of the same signal (a retried
 * webhook must not re-run the reversal below twice). A `paid` payout is
 * otherwise terminal — it ignores a later `processing`/`failed` — but a late
 * `returned` still reverses it (see `reverseSettledPayout`): a bounced ACH
 * credit can arrive days after Increase reports `submitted`.
 */
export async function applyPayoutOutcome(
  ctx: MutationCtx,
  payout: Doc<"payouts">,
  target: PayoutTarget,
  failureReason?: string,
): Promise<void> {
  const now = Date.now();
  if (payout.status === "canceled") return;
  // Already resolved terminal — a repeated `failed`/`returned` webhook delivery
  // is an idempotent no-op (this ALSO catches a returned payout post-reversal).
  if (payout.status === "returned" || payout.status === "failed") return;

  const req = await ctx.db.get(payout.reimbursementId);

  if (payout.status === "paid") {
    if (target !== "returned") return; // otherwise paid is terminal
    await reverseSettledPayout(ctx, req, payout, failureReason);
    return;
  }

  switch (target) {
    case "processing":
      if (payout.status === "pending") {
        await ctx.db.patch(payout._id, { status: "processing", updatedAt: now });
      }
      return;
    case "paid":
      await ctx.db.patch(payout._id, { status: "paid", updatedAt: now });
      if (req) await settleReimbursementPaid(ctx, req, payout);
      return;
    case "failed":
    case "returned":
      await ctx.db.patch(payout._id, {
        status: target,
        failureReason,
        updatedAt: now,
      });
      // Walk the reimbursement back so a manager can retry / mark it paid.
      if (req && req.status === "paying") {
        await ctx.db.patch(req._id, { status: "approved", updatedAt: now });
      }
      return;
  }
}
