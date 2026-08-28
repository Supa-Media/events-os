/**
 * Paying an approved contractor payment over ACH — the contractor-rail twin of
 * `increasePayouts.ts#payReimbursement`.
 *
 * Its own file rather than more branches inside `increasePayouts.ts`, for the
 * reason that file's own functions are already long: the reimbursement payout
 * path carries a decade of hard-won guards (the dead-replay detector, the
 * env-from-object-id selection, the manual-clobber refusal), and threading a
 * second subject type through every one of them would make both rails harder to
 * read and much easier to break. The SHARED machinery — `payouts`, the status
 * ladder, `applyPayoutOutcome`, the webhook mapping — is genuinely shared and
 * lives where it always did (`lib/increasePayoutMachine.ts`).
 *
 * WHAT IS DELIBERATELY IDENTICAL, because diverging would be a bug:
 *  - Idempotency-Key is the SUBJECT id (`contractorPaymentId`), never the payout
 *    id, so a network-timeout retry replays the same transfer instead of
 *    originating a second one. See `payReimbursement`'s note for the full
 *    argument and the dead-replay trade-off it accepts.
 *  - At most one LIVE payout per subject, checked before minting.
 *  - Separation of duties is re-checked HERE, at disbursement, not just at
 *    approval — the second of the two layers.
 *  - A missing/unwired Increase account degrades to a `manual` payout the
 *    treasurer completes by hand, rather than failing the payment.
 */
import {
  action,
  mutation,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  payoutSummaryValidator,
  toPayoutSummary,
  assertPositivePayout,
  LIVE_PAYOUT_STATUSES,
  TERMINAL_TRANSFER_STATUSES,
  type PayoutSummary,
} from "./lib/increaseShapes";
import { requireChapterId, requireInChapter } from "./lib/context";
import { resolveCallerPersonId, assertSeparationOfDuties } from "./lib/finance";
import { normalizeEmail, getUserEmail } from "./lib/access";
import { requireContractorPaymentsApprove } from "./lib/contractorPaymentsAccess";
import { increaseEnvForObjectId, increasePost } from "./lib/increaseApi";
import { getChapterAccountForMode } from "./lib/finance";
import { readSandbox } from "./financeSettings";
import { settleContractorPaid } from "./lib/increasePayoutMachine";
import { loadSchedule, describeInstallment } from "./lib/contractorSchedule";
import { CONTRACTOR_MILESTONE_NOTE_MAX } from "@events-os/shared";

/**
 * Disbursement separation of duties for the contractor rail.
 *
 * THE SECOND LAYER. `assertContractorApprovalSoD` runs at approval; this runs
 * at the moment money actually moves, and they are not redundant — approval and
 * disbursement can be different acts by different people minutes apart, and the
 * control only holds if the person pressing "pay" is also checked.
 *
 * Compares the roster link AND the normalized email, because an accountless
 * payee (the normal case for a contractor) has no roster link to compare.
 */
function assertContractorDisbursementSoD(
  callerPersonId: Id<"people">,
  callerEmail: string | null,
  row: { personId?: Id<"people">; payeeEmail?: string },
): void {
  assertSeparationOfDuties(callerPersonId, row.personId);
  const payer = normalizeEmail(callerEmail);
  const payee = normalizeEmail(row.payeeEmail);
  if (payer && payee && payer === payee) {
    throw new ConvexError({
      code: "SOD_VIOLATION",
      message:
        "The person releasing a payout must be different from the payee.",
    });
  }
}

/** Append to the shared approval trail. Mirrors
 *  `contractorPayments.ts#recordApproval` — duplicated rather than exported
 *  across the module boundary because that one is private to its file and the
 *  two rails already share the table, not the function. */
async function recordContractorApproval(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  contractorPaymentId: Id<"contractorPayments">,
  action: "approve" | "reject" | "cancel" | "edit" | "pay",
  actorPersonId: Id<"people">,
  note?: string,
): Promise<void> {
  await ctx.db.insert("approvals", {
    chapterId,
    subjectType: "contractor_payment",
    subjectId: String(contractorPaymentId),
    action,
    actorPersonId,
    ...(note ? { note } : {}),
    createdAt: Date.now(),
  });
}

/**
 * WHAT IS BEING PAID — the agreement, or one tranche of it?
 *
 * The single decision both pay paths (ACH and mark-paid-by-hand) route through,
 * so neither can be talked into the other's answer. Three refusals, and each
 * exists because of a specific way money could otherwise move wrongly:
 *
 *  - A SCHEDULED agreement paid WITHOUT naming a tranche would send the whole
 *    agreed total in one ACH, ignoring the plan the contractor signed and the
 *    milestones nobody has judged met yet. This is the important one: it is the
 *    shape a pre-schedule "Pay" button still has, so it must fail loudly rather
 *    than quietly pay everything.
 *  - An UNSCHEDULED agreement paid WITH one is asking to release a tranche of a
 *    plan that does not exist.
 *  - A tranche that is not `scheduled` is already moving, already gone, or
 *    called off.
 */
async function resolvePayoutSubject(
  ctx: MutationCtx,
  payment: Doc<"contractorPayments">,
  installmentId: Id<"contractorPaymentInstallments"> | undefined,
): Promise<{
  amountCents: number;
  installment: Doc<"contractorPaymentInstallments"> | null;
}> {
  const schedule = await loadSchedule(ctx, payment._id);

  if (!installmentId) {
    if (schedule.length > 0) {
      throw new ConvexError({
        code: "SCHEDULE_REQUIRED",
        message:
          "This agreement pays in parts. Release one of its scheduled payments instead of paying the whole amount.",
      });
    }
    return {
      amountCents: payment.approvedCents ?? payment.agreedAmountCents,
      installment: null,
    };
  }

  const inst = schedule.find((i) => i._id === installmentId);
  if (!inst) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "That scheduled payment isn't part of this agreement.",
    });
  }
  if (inst.status !== "scheduled") {
    throw new ConvexError({
      code: "ILLEGAL_TRANSITION",
      message:
        inst.status === "paid"
          ? "That payment has already been sent."
          : inst.status === "paying"
            ? "That payment is already on its way."
            : "That payment was canceled.",
    });
  }
  return { amountCents: inst.amountCents, installment: inst };
}

/**
 * The SETTLED payout for a subject, or null — "was this already sent?"
 *
 * Distinct from `liveContractorPayout` because `paid` is not a live status: a
 * settled payout is the answer to "don't send this again", and on the manual
 * path that question has to be asked before the transition guard rather than
 * after. A scheduled agreement drops back to `approved` each time a tranche
 * settles, so the guard alone would wave a repeat call straight through into a
 * second payout for money that has already gone.
 */
async function settledContractorPayout(
  ctx: MutationCtx,
  contractorPaymentId: Id<"contractorPayments">,
  installmentId: Id<"contractorPaymentInstallments"> | undefined,
): Promise<Doc<"payouts"> | null> {
  if (installmentId) {
    const rows = await ctx.db
      .query("payouts")
      .withIndex("by_contractor_installment", (q) =>
        q.eq("contractorInstallmentId", installmentId),
      )
      .take(50);
    return rows.find((p) => p.status === "paid") ?? null;
  }
  const payment = await ctx.db.get(contractorPaymentId);
  if (!payment || payment.status !== "paid") return null;
  const rows = await ctx.db
    .query("payouts")
    .withIndex("by_contractor_payment", (q) =>
      q.eq("contractorPaymentId", contractorPaymentId),
    )
    .take(50);
  return rows.find((p) => p.status === "paid") ?? null;
}

/**
 * The live payout for a subject, or null — "has this already been sent?"
 *
 * Scoped to the TRANCHE when there is one. On the agreement-wide index every
 * tranche of a schedule is a hit, so asking there would make tranche two look
 * already-paid the moment tranche one was.
 */
async function liveContractorPayout(
  ctx: MutationCtx,
  contractorPaymentId: Id<"contractorPayments">,
  installment: Doc<"contractorPaymentInstallments"> | null,
): Promise<Doc<"payouts"> | null> {
  const rows = installment
    ? await ctx.db
        .query("payouts")
        .withIndex("by_contractor_installment", (q) =>
          q.eq("contractorInstallmentId", installment._id),
        )
        .take(50)
    : await ctx.db
        .query("payouts")
        .withIndex("by_contractor_payment", (q) =>
          q.eq("contractorPaymentId", contractorPaymentId),
        )
        .take(50);
  return rows.find((p) => LIVE_PAYOUT_STATUSES.includes(p.status)) ?? null;
}

/**
 * Record WHO judged this tranche payable and when.
 *
 * The agreement's own `approvedAt` says it was legal to pay; this says a named
 * person decided that this particular milestone had been met on this particular
 * day — the fact a schedule exists to make answerable, and the one the parent
 * row has nowhere to put once there is more than one tranche. Set once and
 * never overwritten, so a retry after a bounce does not rewrite the date the
 * milestone was actually judged met.
 */
async function stampRelease(
  ctx: MutationCtx,
  installment: Doc<"contractorPaymentInstallments"> | null,
  releasedByPersonId: Id<"people">,
  releaseNote: string | undefined,
): Promise<void> {
  if (!installment || installment.releasedAt != null) return;
  const note = releaseNote?.trim();
  const now = Date.now();
  await ctx.db.patch(installment._id, {
    releasedByPersonId,
    releasedAt: now,
    ...(note ? { releaseNote: note.slice(0, CONTRACTOR_MILESTONE_NOTE_MAX) } : {}),
    updatedAt: now,
  });
}

type BeginContractorPayoutResult =
  | { kind: "existing"; payout: PayoutSummary }
  | { kind: "manual"; payout: PayoutSummary }
  | {
      kind: "increase";
      payoutId: Id<"payouts">;
      increaseAccountId: string;
      amountCents: number;
      contractorPaymentId: Id<"contractorPayments">;
      externalAccountId: string;
      payeeName: string;
      // The Idempotency-Key to hand Increase — THE SUBJECT'S id, which on a
      // scheduled agreement is the TRANCHE and not the agreement. Computed here
      // rather than in the action because this is where "what is being paid"
      // was decided, and the action re-deriving it is exactly how the two would
      // drift. Getting this wrong is not a small bug: Increase would answer the
      // second tranche's request with the first tranche's transfer, the dead-
      // replay guard would fire, and a contractor would be told their money
      // can't be sent over ACH for a reason that has nothing to do with them.
      idempotencyKey: string;
      // What the ACH is FOR, for the audit note. Absent when the agreement pays
      // in one go.
      installmentLabel?: string;
    };

/** Gate + load the payment + find-or-create its payout (idempotency-keyed on
 *  `contractorPaymentId`). Returns an existing LIVE payout as-is — never
 *  double-pays — else decides ACH-vs-manual and mints the payout row. */
export const beginContractorPayout = internalMutation({
  args: {
    contractorPaymentId: v.id("contractorPayments"),
    // Which tranche is being released, on an agreement that pays in parts.
    // Required for those (see `resolvePayoutSubject`) and refused for those
    // that don't.
    installmentId: v.optional(v.id("contractorPaymentInstallments")),
    // Optional "why now" for a milestone tranche — "final cut delivered 8/27".
    releaseNote: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { contractorPaymentId, installmentId, releaseNote },
  ): Promise<BeginContractorPayoutResult> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const row = await ctx.db.get(contractorPaymentId);
    await requireInChapter(ctx, chapterId, row, "Contractor payment");
    await requireContractorPaymentsApprove(ctx, chapterId);
    const payment = row!;

    if (payment.status !== "approved") {
      throw new ConvexError({
        code: "ILLEGAL_TRANSITION",
        message: "Only an approved contractor payment can be paid.",
      });
    }

    const callerPersonId = await resolveCallerPersonId(ctx, chapterId);
    const callerEmail = await getUserEmail(ctx);
    assertContractorDisbursementSoD(callerPersonId, callerEmail, payment);

    const subject = await resolvePayoutSubject(ctx, payment, installmentId);
    const amountCents = subject.amountCents;
    assertPositivePayout(amountCents);

    // IDEMPOTENT: at most one live payout per SUBJECT — the tranche when the
    // agreement pays in parts, the agreement itself when it doesn't. Keyed on
    // the agreement in both cases, tranche two would find tranche one's payout
    // and be handed back "already paid".
    const live = await liveContractorPayout(ctx, contractorPaymentId, subject.installment);
    if (live) return { kind: "existing", payout: toPayoutSummary(live) };

    await stampRelease(ctx, subject.installment, callerPersonId, releaseNote);

    const now = Date.now();
    const hasFullDestination = !!payment.externalAccountId;
    const sandboxMode = await readSandbox(ctx);
    const account = await getChapterAccountForMode(ctx, chapterId, sandboxMode);
    // The key that will ACTUALLY originate the transfer comes from the
    // ACCOUNT's own id prefix, not the deployment's plain key — a
    // sandbox-provisioned account must be paid with the sandbox key even in
    // production mode. Same reasoning as `beginPayout`; getting this wrong
    // silently degrades every sandbox payout to manual.
    const accountEnvKey = account?.increaseAccountId
      ? increaseEnvForObjectId(account.increaseAccountId).key
      : undefined;
    const canAch =
      !!accountEnvKey &&
      !!account &&
      account.onboardingStatus === "active" &&
      !!account.increaseAccountId &&
      hasFullDestination;

    if (canAch) {
      const payoutId = await ctx.db.insert("payouts", {
        chapterId,
        contractorPaymentId,
        ...(subject.installment
          ? { contractorInstallmentId: subject.installment._id }
          : {}),
        ...(payment.personId ? { payeePersonId: payment.personId } : {}),
        amountCents,
        provider: "increase",
        status: "pending",
        ...(payment.bankAccountLast4
          ? { bankAccountLast4: payment.bankAccountLast4 }
          : {}),
        createdAt: now,
        updatedAt: now,
      });
      return {
        kind: "increase",
        payoutId,
        increaseAccountId: account!.increaseAccountId!,
        amountCents,
        contractorPaymentId,
        externalAccountId: payment.externalAccountId!,
        payeeName: payment.payeeName,
        idempotencyKey: String(subject.installment?._id ?? contractorPaymentId),
        ...(subject.installment ? { installmentLabel: subject.installment.label } : {}),
      };
    }

    // Degrade: a manual payout the treasurer completes via `markPaidManually`.
    const payoutId = await ctx.db.insert("payouts", {
      chapterId,
      contractorPaymentId,
      ...(subject.installment
        ? { contractorInstallmentId: subject.installment._id }
        : {}),
      ...(payment.personId ? { payeePersonId: payment.personId } : {}),
      amountCents,
      provider: "manual",
      status: "pending",
      ...(payment.bankAccountLast4
        ? { bankAccountLast4: payment.bankAccountLast4 }
        : {}),
      createdAt: now,
      updatedAt: now,
    });
    const payout = await ctx.db.get(payoutId);
    return { kind: "manual", payout: toPayoutSummary(payout!) };
  },
});

/** Mark a contractor payout `processing` + stamp the transfer id, and move the
 *  payment to `paying`. Carries the SAME dead-replay guard as the reimbursement
 *  rail — see `increasePayouts.ts#applyAchTransfer` for the full reasoning;
 *  without it, a re-pay after a bounce wedges the payment in `paying` forever. */
export const applyContractorAchTransfer = internalMutation({
  args: {
    payoutId: v.id("payouts"),
    increaseTransferId: v.string(),
    transferStatus: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ kind: "applied" } | { kind: "replay" }> => {
    const now = Date.now();
    const status = (args.transferStatus ?? "").toLowerCase();

    // (1) The replayed transfer is itself terminal, or (2) another payout
    // already carries this transfer id — either means Increase handed back a
    // DEAD transfer for this payment's forever-lived idempotency key.
    const alreadyStamped = await ctx.db
      .query("payouts")
      .withIndex("by_increase_transfer", (q) =>
        q.eq("increaseTransferId", args.increaseTransferId),
      )
      .first();
    const deadReplay =
      TERMINAL_TRANSFER_STATUSES.includes(status) ||
      (alreadyStamped != null && alreadyStamped._id !== args.payoutId);
    if (deadReplay) {
      await ctx.db.patch(args.payoutId, {
        status: "failed",
        failureReason: "idempotent_replay",
        updatedAt: now,
      });
      return { kind: "replay" };
    }

    await ctx.db.patch(args.payoutId, {
      provider: "increase",
      status: "processing",
      increaseTransferId: args.increaseTransferId,
      updatedAt: now,
    });
    const payout = await ctx.db.get(args.payoutId);
    if (payout?.contractorPaymentId) {
      const row = await ctx.db.get(payout.contractorPaymentId);
      if (row && row.status === "approved") {
        await ctx.db.patch(row._id, {
          status: "paying",
          payoutId: payout._id,
          updatedAt: now,
        });
      }
      // The TRANCHE carries its own in-flight state. The parent's `paying` says
      // "an ACH is out on this agreement"; this says which one, and is what
      // stops the same tranche being released twice while the first attempt is
      // still in the air.
      if (payout.contractorInstallmentId) {
        const inst = await ctx.db.get(payout.contractorInstallmentId);
        if (inst && inst.status === "scheduled") {
          await ctx.db.patch(inst._id, {
            status: "paying",
            payoutId: payout._id,
            updatedAt: now,
          });
        }
      }
    }
    return { kind: "applied" };
  },
});

/** Fail a contractor payout after the ACH create call itself failed, leaving the
 *  payment `approved` so a treasurer can retry or pay it by hand. */
export const failContractorPayout = internalMutation({
  args: { payoutId: v.id("payouts"), reason: v.string() },
  handler: async (ctx, { payoutId, reason }) => {
    await ctx.db.patch(payoutId, {
      status: "failed",
      failureReason: reason,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Pay an approved contractor payment over ACH from the chapter's Increase
 * account.
 *
 * The statement descriptor is "Contractor" (Increase caps it at 10 characters)
 * and `individual_name` carries who it is for, exactly as the reimbursement rail
 * learned to do — without it, every contractor payment reads identically in the
 * bank's own record with no way to tell them apart.
 *
 * NOTE the asymmetry with our own ledger row, and that it is intentional: the
 * bank's record names the payee (it has to — it is addressing a human's
 * account), while the ledger row published to the public does not. The name is
 * withheld from the PUBLIC, not from the bank.
 */
export const payContractorPayment = action({
  args: {
    contractorPaymentId: v.id("contractorPayments"),
    // Which scheduled payment to release. Required when the agreement pays in
    // parts — `beginContractorPayout` refuses to send the whole total behind a
    // schedule's back.
    installmentId: v.optional(v.id("contractorPaymentInstallments")),
    releaseNote: v.optional(v.string()),
  },
  returns: payoutSummaryValidator,
  handler: async (
    ctx,
    { contractorPaymentId, installmentId, releaseNote },
  ): Promise<PayoutSummary> => {
    const result: BeginContractorPayoutResult = await ctx.runMutation(
      internal.contractorPayouts.beginContractorPayout,
      {
        contractorPaymentId,
        ...(installmentId ? { installmentId } : {}),
        ...(releaseNote ? { releaseNote } : {}),
      },
    );
    if (result.kind === "existing" || result.kind === "manual") {
      return result.payout;
    }

    const { key, base } = increaseEnvForObjectId(result.increaseAccountId);
    if (!key) {
      await ctx.runMutation(internal.contractorPayouts.failContractorPayout, {
        payoutId: result.payoutId,
        reason: "increase_key_unset",
      });
      throw new ConvexError({
        code: "INCREASE_ERROR",
        message: "Couldn't start the ACH payout. Please try again.",
      });
    }

    try {
      const transfer = await increasePost(
        key,
        base,
        "/ach_transfers",
        {
          account_id: result.increaseAccountId,
          // POSITIVE cents originates a CREDIT that pushes funds to the payee.
          amount: result.amountCents,
          statement_descriptor: "Contractor",
          // NACHA receiver name, max 22 characters.
          individual_name: result.payeeName.slice(0, 22),
          external_account_id: result.externalAccountId,
        },
        // Idempotency-Key = the SUBJECT id, never the payout id. See this
        // module's header — and note the subject is the TRANCHE on an agreement
        // that pays in parts, which is why the key is computed by
        // `beginContractorPayout` rather than assumed to be the agreement here.
        result.idempotencyKey,
      );
      const applied = await ctx.runMutation(
        internal.contractorPayouts.applyContractorAchTransfer,
        {
          payoutId: result.payoutId,
          increaseTransferId: String(transfer.id),
          transferStatus:
            typeof transfer.status === "string" ? transfer.status : undefined,
        },
      );
      if (applied.kind === "replay") {
        throw new ConvexError({
          code: "IDEMPOTENT_REPLAY",
          message:
            "This payment's earlier bank transfer was returned and can't be re-sent over ACH. Mark it paid manually or set up a new bank destination.",
        });
      }
    } catch (err) {
      if (err instanceof ConvexError) throw err;
      await ctx.runMutation(internal.contractorPayouts.failContractorPayout, {
        payoutId: result.payoutId,
        reason: "increase_error",
      });
      throw new ConvexError({
        code: "INCREASE_ERROR",
        message: "Couldn't start the ACH payout. Please try again.",
      });
    }

    const payout = await ctx.runQuery(
      internal.contractorPayouts.readPayout,
      { payoutId: result.payoutId },
    );
    return payout!;
  },
});

/** Read a payout summary back after the transfer call — actions have no db. */
export const readPayout = internalQuery({
  args: { payoutId: v.id("payouts") },
  handler: async (ctx, { payoutId }): Promise<PayoutSummary | null> => {
    const payout = await ctx.db.get(payoutId);
    return payout ? toPayoutSummary(payout) : null;
  },
});

/**
 * Mark a contractor payment paid by hand — the fallback when Increase isn't
 * wired, or when the treasurer paid by check or Zelle outside the app.
 *
 * REFUSES to clobber an in-flight real ACH payout, exactly as
 * `markPaidManually` does on the reimbursement rail: a `provider:"increase"`
 * payout carrying a transfer id is (or may be) moving money right now, and
 * marking it paid by hand would double-pay when the ACH also settles.
 */
export const markPaidManually = mutation({
  args: {
    contractorPaymentId: v.id("contractorPayments"),
    // Which scheduled payment was paid by hand. Required when the agreement
    // pays in parts, for the same reason the ACH path requires it.
    installmentId: v.optional(v.id("contractorPaymentInstallments")),
    releaseNote: v.optional(v.string()),
  },
  returns: payoutSummaryValidator,
  handler: async (
    ctx,
    { contractorPaymentId, installmentId, releaseNote },
  ): Promise<PayoutSummary> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const row = await ctx.db.get(contractorPaymentId);
    await requireInChapter(ctx, chapterId, row, "Contractor payment");
    await requireContractorPaymentsApprove(ctx, chapterId);
    const payment = row!;

    const callerPersonId = await resolveCallerPersonId(ctx, chapterId);
    const callerEmail = await getUserEmail(ctx);
    assertContractorDisbursementSoD(callerPersonId, callerEmail, payment);

    // IDEMPOTENT: an already-settled subject returns its payout as-is. Asked
    // BEFORE the transition guard because a scheduled agreement whose tranche
    // just settled sits back in `approved`, so a repeated call would otherwise
    // fall through and mint a SECOND payout for a tranche already paid.
    const settledAlready = await settledContractorPayout(
      ctx,
      contractorPaymentId,
      installmentId,
    );
    if (settledAlready) return toPayoutSummary(settledAlready);

    const subject = await resolvePayoutSubject(ctx, payment, installmentId);
    let payout = await liveContractorPayout(
      ctx,
      contractorPaymentId,
      subject.installment,
    );

    if (payout && payout.provider === "increase" && payout.increaseTransferId) {
      throw new ConvexError({
        code: "PAYOUT_IN_FLIGHT",
        message:
          "This payment has an ACH payout in progress — it can't be marked paid manually.",
      });
    }

    if (payment.status !== "approved" && payment.status !== "paying") {
      throw new ConvexError({
        code: "ILLEGAL_TRANSITION",
        message: "Only an approved contractor payment can be marked paid.",
      });
    }

    const amountCents = subject.amountCents;
    assertPositivePayout(amountCents);
    await stampRelease(ctx, subject.installment, callerPersonId, releaseNote);

    const now = Date.now();
    if (!payout) {
      const payoutId = await ctx.db.insert("payouts", {
        chapterId,
        contractorPaymentId,
        ...(subject.installment
          ? { contractorInstallmentId: subject.installment._id }
          : {}),
        ...(payment.personId ? { payeePersonId: payment.personId } : {}),
        amountCents,
        provider: "manual",
        status: "pending",
        ...(payment.bankAccountLast4
          ? { bankAccountLast4: payment.bankAccountLast4 }
          : {}),
        createdAt: now,
        updatedAt: now,
      });
      payout = await ctx.db.get(payoutId);
    }
    // Re-stamp `provider: "manual"` alongside the status. A payout minted for
    // an ACH attempt that never got a transfer id (Increase unwired, or the
    // create call failed) is still `provider:"increase"`; marking it paid by
    // hand without correcting that leaves a row claiming Increase moved money
    // it never touched — which is exactly the row a future reconciliation would
    // try to match against a transfer that does not exist. The guard above
    // already refuses any payout that HAS a transfer id, so nothing in flight
    // is being relabelled here.
    await ctx.db.patch(payout!._id, {
      status: "paid",
      provider: "manual",
      updatedAt: now,
    });
    const settled = (await ctx.db.get(payout!._id))!;
    // Routed through the SHARED settle function so a hand-marked payment posts
    // the identical ledger row, coding, and notice an ACH one does. Two paths
    // that both mean "paid" must not produce two different records.
    await settleContractorPaid(ctx, payment, settled);
    // The disbursement belongs in the append-only trail, same as the approval
    // did. Releasing money is the act the separation-of-duties rules exist to
    // constrain, so "who paid this, and when" has to be answerable from the
    // record rather than inferred from a payout row's timestamps.
    await recordContractorApproval(
      ctx,
      chapterId,
      contractorPaymentId,
      "pay",
      callerPersonId,
      subject.installment
        ? `Marked paid by hand: ${describeInstallment(subject.installment, (await loadSchedule(ctx, contractorPaymentId)).length)}.`
        : "Marked paid by hand.",
    );
    return toPayoutSummary((await ctx.db.get(payout!._id))!);
  },
});
