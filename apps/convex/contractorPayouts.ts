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
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
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
    };

/** Gate + load the payment + find-or-create its payout (idempotency-keyed on
 *  `contractorPaymentId`). Returns an existing LIVE payout as-is — never
 *  double-pays — else decides ACH-vs-manual and mints the payout row. */
export const beginContractorPayout = internalMutation({
  args: { contractorPaymentId: v.id("contractorPayments") },
  handler: async (
    ctx,
    { contractorPaymentId },
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

    const amountCents = payment.approvedCents ?? payment.agreedAmountCents;
    assertPositivePayout(amountCents);

    // IDEMPOTENT: at most one live payout per payment.
    const existing = await ctx.db
      .query("payouts")
      .withIndex("by_contractor_payment", (q) =>
        q.eq("contractorPaymentId", contractorPaymentId),
      )
      .take(50);
    const live = existing.find((p) => LIVE_PAYOUT_STATUSES.includes(p.status));
    if (live) return { kind: "existing", payout: toPayoutSummary(live) };

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
      };
    }

    // Degrade: a manual payout the treasurer completes via `markPaidManually`.
    const payoutId = await ctx.db.insert("payouts", {
      chapterId,
      contractorPaymentId,
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
  args: { contractorPaymentId: v.id("contractorPayments") },
  returns: payoutSummaryValidator,
  handler: async (ctx, { contractorPaymentId }): Promise<PayoutSummary> => {
    const result: BeginContractorPayoutResult = await ctx.runMutation(
      internal.contractorPayouts.beginContractorPayout,
      { contractorPaymentId },
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
        // module's header.
        String(contractorPaymentId),
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
  args: { contractorPaymentId: v.id("contractorPayments") },
  returns: payoutSummaryValidator,
  handler: async (ctx, { contractorPaymentId }): Promise<PayoutSummary> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    const row = await ctx.db.get(contractorPaymentId);
    await requireInChapter(ctx, chapterId, row, "Contractor payment");
    await requireContractorPaymentsApprove(ctx, chapterId);
    const payment = row!;

    const callerPersonId = await resolveCallerPersonId(ctx, chapterId);
    const callerEmail = await getUserEmail(ctx);
    assertContractorDisbursementSoD(callerPersonId, callerEmail, payment);

    const existing = await ctx.db
      .query("payouts")
      .withIndex("by_contractor_payment", (q) =>
        q.eq("contractorPaymentId", contractorPaymentId),
      )
      .take(50);
    let payout =
      existing.find((p) => LIVE_PAYOUT_STATUSES.includes(p.status)) ?? null;

    if (payout && payout.provider === "increase" && payout.increaseTransferId) {
      throw new ConvexError({
        code: "PAYOUT_IN_FLIGHT",
        message:
          "This payment has an ACH payout in progress — it can't be marked paid manually.",
      });
    }

    // IDEMPOTENT: already settled → return as-is.
    if (payout && payout.status === "paid" && payment.status === "paid") {
      return toPayoutSummary(payout);
    }

    if (payment.status !== "approved" && payment.status !== "paying") {
      throw new ConvexError({
        code: "ILLEGAL_TRANSITION",
        message: "Only an approved contractor payment can be marked paid.",
      });
    }

    const amountCents = payment.approvedCents ?? payment.agreedAmountCents;
    assertPositivePayout(amountCents);

    const now = Date.now();
    if (!payout) {
      const payoutId = await ctx.db.insert("payouts", {
        chapterId,
        contractorPaymentId,
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
    await ctx.db.patch(payout!._id, { status: "paid", updatedAt: now });
    const settled = (await ctx.db.get(payout!._id))!;
    // Routed through the SHARED settle function so a hand-marked payment posts
    // the identical ledger row, coding, and notice an ACH one does. Two paths
    // that both mean "paid" must not produce two different records.
    await settleContractorPaid(ctx, payment, settled);
    return toPayoutSummary((await ctx.db.get(payout!._id))!);
  },
});
