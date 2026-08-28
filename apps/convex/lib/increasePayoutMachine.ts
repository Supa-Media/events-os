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
import {
  deriveContractorTxnFields,
  deriveContractorCodingMaterialization,
} from "./contractorTxnFields";
import {
  loadSchedule,
  installmentForPayout,
  describeInstallment,
} from "./contractorSchedule";
import { contractorScheduleIsComplete } from "@events-os/shared";

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

  // WHICH RAIL IS THIS? A payout carries exactly one subject — a reimbursement
  // or a contractor payment (`beginPayout`/`beginContractorPayout` enforce it).
  // Everything below dispatches on that, and a payout with NEITHER (impossible
  // through the mutation layer, but reachable by a hand-edited row) advances
  // the payout itself and touches no subject, rather than throwing inside a
  // webhook handler.
  if (payout.contractorPaymentId) {
    await applyContractorPayoutOutcome(ctx, payout, target, failureReason);
    return;
  }

  const req = payout.reimbursementId
    ? await ctx.db.get(payout.reimbursementId)
    : null;

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

// ── The contractor rail ─────────────────────────────────────────────────────
/**
 * The single transaction recording a CONTRACTOR payout leaving the account.
 * IDEMPOTENT: at most one per payment, keyed via `transactions.by_contractor_payment`.
 *
 * `flow:"outflow"` — this row IS the expense, for the same reason the
 * reimbursement twin is: nothing else ever books contract labour into the
 * ledger, so if this row didn't count as spend the work would be invisible to
 * every budget and category rollup.
 *
 * Descriptive fields come from `deriveContractorTxnFields`, which is where the
 * public-ledger redaction is enforced — read that module's header before
 * changing anything here about `merchantName` or `description`.
 *
 * NO RECEIPT IS MATERIALIZED, deliberately. The reimbursement twin turns each
 * filed receipt into a real `receipts` row; a contractor payment has no
 * receipt, because the AGREEMENT is the substantiation. The tax document is
 * emphatically NOT a receipt and must never be linked here — a W-9 in the
 * receipt library would be an SSN reachable from Reconcile.
 */
export async function postContractorSpend(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  row: Doc<"contractorPayments">,
  payout: Doc<"payouts">,
): Promise<Id<"transactions">> {
  // A SCHEDULED AGREEMENT POSTS ONE ROW PER TRANCHE, so "have we booked this
  // already?" is asked of the tranche. Asked of the agreement instead, the
  // first tranche's row would answer for every later one and the ledger would
  // record a $10,000 engagement as the $5,000 deposit — for the rest of time,
  // silently, with the budget under-spent by half.
  const installment = await installmentForPayout(ctx, payout);
  const existing = installment
    ? await ctx.db
        .query("transactions")
        .withIndex("by_contractor_installment", (q) =>
          q.eq("contractorInstallmentId", installment._id),
        )
        .first()
    : await ctx.db
        .query("transactions")
        .withIndex("by_contractor_payment", (q) =>
          q.eq("contractorPaymentId", row._id),
        )
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
  const ported = deriveContractorTxnFields(row);
  if (installment) {
    // Name the tranche in the INTERNAL description only. `merchantName` is
    // untouched and still the constant, so this cannot reach the public ledger
    // — read `contractorTxnFields.ts`'s header before changing that. What it
    // buys is a Reconcile queue where three ACHs to the same person on the same
    // agreement are told apart by the deal's own words rather than by amount.
    const total = (await loadSchedule(ctx, row._id)).length;
    ported.description = `${ported.description} — ${describeInstallment(installment, total)}`;
  }
  const txnId = await ctx.db.insert("transactions", {
    chapterId,
    source: "contractor_payment",
    flow: "outflow", // the expense itself — counts toward category/budget spend
    amountCents: payout.amountCents,
    currency: "usd",
    postedAt: now,
    // NOTE: `personId` is deliberately NOT set from `row.personId`. On the
    // reimbursement rail that field names the member being made whole; here it
    // would attach a contractor's roster identity to a ledger row, and identity
    // on this rail lives on the payment record instead.
    contractorPaymentId: row._id,
    ...(installment ? { contractorInstallmentId: installment._id } : {}),
    status: "reconciled",
    createdAt: now,
    ...ported,
  });
  await ctx.db.patch(payout._id, { transactionId: txnId, updatedAt: now });

  // Port the approved coding so nobody re-types testimony a reviewer already
  // approved — and so the published `purpose` column says what the work was.
  const { namesMaxHeadcount } = await codingPolicy(ctx);
  const materialization = await deriveContractorCodingMaterialization(ctx, row);
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
      portedFromContractorPaymentId: row._id,
    });
  }

  return txnId;
}

/** Settle a contractor payout: mark the payment `paid`, post the `outflow` row,
 *  and tell the contractor their money went out. THE ONE PLACE A CONTRACTOR
 *  PAYMENT BECOMES PAID, which is why the notice hangs here rather than at
 *  either call site — same argument as `settleReimbursementPaid`.
 *
 *  ON A SCHEDULED AGREEMENT this settles a TRANCHE, and the difference is the
 *  whole point: `paid` is terminal, so stamping it when the deposit lands would
 *  close an agreement that still owes somebody the other half — and close it
 *  where nothing would ever reopen it. A tranche settling mid-schedule walks
 *  the agreement back to `approved` instead, which is both true (it is approved
 *  and not yet fully paid) and the state the next tranche can be released
 *  from. */
export async function settleContractorPaid(
  ctx: MutationCtx,
  row: Doc<"contractorPayments">,
  payout: Doc<"payouts">,
): Promise<void> {
  const now = Date.now();
  const installment = await installmentForPayout(ctx, payout);

  if (installment) {
    if (installment.status !== "paid") {
      await ctx.db.patch(installment._id, {
        status: "paid",
        paidAt: installment.paidAt ?? now,
        payoutId: payout._id,
        updatedAt: now,
      });
    }
    // Re-read: `contractorScheduleIsComplete` has to see the patch above, and
    // the answer decides whether this was the last payment of the engagement or
    // one of several.
    const schedule = await loadSchedule(ctx, row._id);
    const finished = contractorScheduleIsComplete(schedule);

    if (finished && row.status !== "paid") {
      await ctx.db.patch(row._id, {
        status: "paid",
        paidAt: row.paidAt ?? now,
        payoutId: payout._id,
        updatedAt: now,
      });
    } else if (!finished && row.status === "paying") {
      // Back to the state the next tranche is released from. Note this is a
      // walk BACK from `paying`, not a failure: the ACH succeeded, and the
      // agreement simply is not finished.
      await ctx.db.patch(row._id, {
        status: "approved",
        payoutId: payout._id,
        updatedAt: now,
      });
    }
    // ALWAYS the tranche notice on a scheduled agreement, the last one
    // included. `sendPaidNotice` states the agreement's FULL agreed amount as
    // the sum just sent, which is true only when the agreement pays in one go —
    // on the final tranche of a schedule it would tell somebody who has just
    // received $500 that $1,000 is on its way. The tranche notice names the
    // payment that actually moved and says what remains, which on the last one
    // is nothing.
    await ctx.scheduler.runAfter(
      0,
      internal.contractorPayments.sendInstallmentPaidNotice,
      { installmentId: installment._id },
    );
    // Money has actually moved, so the payee is a returning contractor and
    // their tax document moves onto the four-year clock — on the FIRST tranche,
    // not the last. Waiting for the schedule to finish would leave a real paid
    // contractor off the roster for months. Idempotent by design, so calling it
    // once per tranche is safe.
    await ctx.scheduler.runAfter(
      0,
      internal.contractorProfiles.rememberPaidContractor,
      { contractorPaymentId: row._id },
    );
  } else if (row.status !== "paid") {
    await ctx.db.patch(row._id, {
      status: "paid",
      paidAt: row.paidAt ?? now,
      payoutId: payout._id,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.contractorPayments.sendPaidNotice,
      { contractorPaymentId: row._id },
    );
    // A payee becomes a RETURNING CONTRACTOR the moment money actually moves,
    // and not before — a profile minted at compose time would fill the roster
    // with people whose payments were never approved. This is also what hands
    // their tax document from the short unpaid window to the four-year rule.
    await ctx.scheduler.runAfter(
      0,
      internal.contractorProfiles.rememberPaidContractor,
      { contractorPaymentId: row._id },
    );
  }
  await postContractorSpend(ctx, row.chapterId, row, payout);
}

/**
 * Reverse an already-`paid` contractor payout whose ACH bounced days later.
 *
 * Mirrors `reverseSettledPayout` exactly, including the part that looks
 * destructive: the ledger transaction is DELETED, not flagged. The money never
 * left, so its spend has to come back out of the budget it now contributes to —
 * and `postContractorSpend` looks up `by_contractor_payment` unconditionally, so
 * a row left in place would make a retried payout mistake it for "already
 * posted" and silently skip booking the real one.
 *
 * The bounce history survives on the `payouts` row (`status:"returned"` +
 * `failureReason`).
 */
async function reverseSettledContractorPayout(
  ctx: MutationCtx,
  row: Doc<"contractorPayments"> | null,
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
  // The TRANCHE goes back to `scheduled` — payable again, by the same person,
  // once the bank details are fixed. Its release stamp is deliberately LEFT
  // ALONE: somebody did judge the milestone met on that day, and the ACH
  // bouncing days later does not unmake that judgement.
  const installment = await installmentForPayout(ctx, payout);
  if (installment && installment.status === "paid") {
    await ctx.db.patch(installment._id, {
      status: "scheduled",
      paidAt: undefined,
      payoutId: undefined,
      // Give back this tranche's notice, for the reason the agreement-level one
      // is given back below: they were told this payment was sent, and it came
      // back out.
      paidNoticeSentAt: undefined,
      updatedAt: now,
    });
  }
  if (row && row.status === "paid") {
    await ctx.db.patch(row._id, {
      status: "approved",
      paidAt: undefined,
      // Give back the paid notice: we told them the money was sent and it came
      // back out, so a later successful retry is a real payment on a later date
      // that they have never been told about. Contrast `approvedNoticeSentAt`,
      // left alone — the approval never stopped being true.
      paidNoticeSentAt: undefined,
      updatedAt: now,
    });
  }
  if (transactionId) {
    const txn = await ctx.db.get(transactionId);
    if (txn && row && txn.contractorPaymentId === row._id) {
      await ctx.db.delete(transactionId);
    }
  }
}

/** The contractor-rail half of `applyPayoutOutcome`, split out so each rail's
 *  transitions read as one piece rather than as a thicket of conditionals. */
async function applyContractorPayoutOutcome(
  ctx: MutationCtx,
  payout: Doc<"payouts">,
  target: PayoutTarget,
  failureReason?: string,
): Promise<void> {
  const now = Date.now();
  const row = payout.contractorPaymentId
    ? await ctx.db.get(payout.contractorPaymentId)
    : null;

  if (payout.status === "paid") {
    if (target !== "returned") return; // otherwise paid is terminal
    await reverseSettledContractorPayout(ctx, row, payout, failureReason);
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
      if (row) await settleContractorPaid(ctx, row, payout);
      return;
    case "failed":
    case "returned":
      await ctx.db.patch(payout._id, {
        status: target,
        failureReason,
        updatedAt: now,
      });
      // Walk the payment back so a manager can retry or fix the bank details.
      if (row && row.status === "paying") {
        await ctx.db.patch(row._id, { status: "approved", updatedAt: now });
      }
      // And the tranche with it, or the retry would be refused as "already on
      // its way" by a payout that is no longer going anywhere.
      const failedInstallment = await installmentForPayout(ctx, payout);
      if (failedInstallment && failedInstallment.status === "paying") {
        await ctx.db.patch(failedInstallment._id, {
          status: "scheduled",
          payoutId: undefined,
          updatedAt: now,
        });
      }
      return;
  }
}
