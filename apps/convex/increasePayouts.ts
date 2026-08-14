/**
 * ACH reimbursement PAYOUTS from the chapter's Increase account (Phase 4) —
 * begin/pay/mark-paid plus the webhook-driven payout state machine's entry
 * point. The pure transition logic lives in `lib/increasePayoutMachine.ts`
 * (testable WITHOUT hitting Increase); the fetch-then-apply orchestration for
 * webhooks lives in `increase.ts`. Part of the `increase*` module family (see
 * `increase.ts`'s header for the module map).
 *
 * INVARIANTS:
 *  - Money is ALWAYS a non-negative INTEGER number of cents; direction lives in
 *    `transactions.flow`, never a sign.
 *  - Reimbursement payouts post as `flow:"outflow"` → they ARE the chapter's
 *    expense (see `lib/increasePayoutMachine.ts#postReimbursementSpend`).
 *  - `payouts` is idempotency-keyed on `reimbursementId`: at most one LIVE payout
 *    per reimbursement, so an approved reimbursement can NEVER double-pay.
 *  - Degrade to a logged no-op (never throw) when `INCREASE_API_KEY` is unset.
 *  - All failures throw `ConvexError` (never a plain `Error`).
 */
import {
  action,
  mutation,
  query,
  internalMutation,
} from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { matchesMode } from "@events-os/shared";
import { readSandbox } from "./financeSettings";
import {
  requireChapterId,
  requireInChapter,
  getChapterIdOrNull,
} from "./lib/context";
import { getUserEmail } from "./lib/access";
import {
  requireFinanceRole,
  requireFinanceManager,
  resolveCallerPersonId,
  getChapterAccountForMode,
} from "./lib/finance";
import { increaseEnvForObjectId, increasePost } from "./lib/increaseApi";
import {
  payoutSummaryValidator,
  toPayoutSummary,
  assertPositivePayout,
  assertDisbursementSoD,
  LIVE_PAYOUT_STATUSES,
  TERMINAL_TRANSFER_STATUSES,
  type PayoutSummary,
  type BeginPayoutResult,
} from "./lib/increaseShapes";
import {
  payoutTargetFor,
  applyPayoutOutcome,
  settleReimbursementPaid,
} from "./lib/increasePayoutMachine";

// ── beginPayout (internalMutation) ───────────────────────────────────────────

/** Gate + load the reimbursement + find-or-create its payout (idempotency-keyed
 *  on `reimbursementId`). Manager-only. Returns an existing LIVE payout as-is
 *  (never double-pays), else decides ACH-vs-manual and creates the payout row. */
export const beginPayout = internalMutation({
  args: { reimbursementId: v.id("reimbursementRequests") },
  returns: v.union(
    v.object({ kind: v.literal("existing"), payout: payoutSummaryValidator }),
    v.object({ kind: v.literal("manual"), payout: payoutSummaryValidator }),
    v.object({
      kind: v.literal("increase"),
      payoutId: v.id("payouts"),
      increaseAccountId: v.string(),
      amountCents: v.number(),
      reimbursementId: v.id("reimbursementRequests"),
      externalAccountId: v.union(v.string(), v.null()),
      accountNumber: v.union(v.string(), v.null()),
      routingNumber: v.union(v.string(), v.null()),
      funding: v.union(v.literal("checking"), v.literal("savings"), v.null()),
      /** Who is being paid. Sent to Increase as `individual_name` so the
       *  transfer says whose reimbursement it is — see the descriptor comment
       *  at the `/ach_transfers` call. */
      payeeName: v.string(),
    }),
  ),
  handler: async (ctx, { reimbursementId }): Promise<BeginPayoutResult> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);

    const req = await ctx.db.get(reimbursementId);
    await requireInChapter(ctx, chapterId, req, "Reimbursement");
    const reimbursement = req!;
    if (reimbursement.status !== "approved") {
      throw new ConvexError({
        code: "ILLEGAL_TRANSITION",
        message: "Only an approved reimbursement can be paid.",
      });
    }

    // Disbursement SoD: the caller releasing the payout must not be the payee.
    const callerPersonId = await resolveCallerPersonId(ctx, chapterId);
    const callerEmail = await getUserEmail(ctx);
    assertDisbursementSoD(callerPersonId, callerEmail, reimbursement);

    // Reject a non-positive amount before any payout row is minted.
    const amountCents = reimbursement.approvedCents ?? reimbursement.totalCents;
    assertPositivePayout(amountCents);

    // IDEMPOTENT: at most one live payout per reimbursement — never double-pay.
    const existingPayouts = await ctx.db
      .query("payouts")
      .withIndex("by_reimbursement", (q) =>
        q.eq("reimbursementId", reimbursementId),
      )
      .take(50);
    const live = existingPayouts.find((p) =>
      LIVE_PAYOUT_STATUSES.includes(p.status),
    );
    if (live) return { kind: "existing", payout: toPayoutSummary(live) };

    const now = Date.now();

    // Is a real ACH addressable? Needs the vendor wired, an active account, AND
    // a full destination — a linked Increase External Account, captured at
    // submission time via `linkPublicBankAccount` / `linkBankAccount`
    // (`reimbursements.ts`). Absent that link (the member never provided full
    // bank details, or the Increase call degraded), we fall back to manual.
    const hasFullDestination = !!reimbursement.externalAccountId;
    // Mode-aware: pay from the chapter's CURRENT-environment account (never
    // `.first()`, which would arbitrarily pick sandbox-or-prod once both exist).
    const sandboxMode = await readSandbox(ctx);
    const account = await getChapterAccountForMode(ctx, chapterId, sandboxMode);
    // The key that will ACTUALLY be used to originate the transfer is resolved
    // from the ACCOUNT's own id prefix (`increaseEnvForObjectId`), NOT the
    // deployment's plain `INCREASE_API_KEY` — a sandbox-provisioned account
    // must be paid with `INCREASE_SANDBOX_API_KEY` even in production mode.
    // Checking the wrong env var here would silently degrade every sandbox
    // payout to manual even once fully wired.
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
        reimbursementId,
        payeePersonId: reimbursement.personId,
        amountCents,
        provider: "increase",
        status: "pending",
        bankAccountLast4: reimbursement.bankAccountLast4,
        createdAt: now,
        updatedAt: now,
      });
      return {
        kind: "increase",
        payoutId,
        increaseAccountId: account!.increaseAccountId!,
        amountCents,
        reimbursementId,
        externalAccountId: reimbursement.externalAccountId ?? null,
        payeeName: reimbursement.payeeName,
        accountNumber: null,
        routingNumber: null,
        funding: null,
      };
    }

    // Degrade: a manual payout the manager completes via `markPaidManually`.
    const payoutId = await ctx.db.insert("payouts", {
      chapterId,
      reimbursementId,
      payeePersonId: reimbursement.personId,
      amountCents,
      provider: "manual",
      status: "pending",
      bankAccountLast4: reimbursement.bankAccountLast4,
      createdAt: now,
      updatedAt: now,
    });
    const payout = await ctx.db.get(payoutId);
    return { kind: "manual", payout: toPayoutSummary(payout!) };
  },
});

/**
 * Apply a created Increase ACH transfer to the payout: `processing` +
 * `increaseTransferId`, and move the reimbursement to `paying`.
 *
 * REPLAY-OF-TERMINAL GUARD: Increase idempotency keys (we key on
 * `reimbursementId`) NEVER expire — one object per key, forever. After a
 * paid→returned reversal (`reverseSettledPayout`), RE-paying the same
 * reimbursement replays the ORIGINAL, now-BOUNCED transfer instead of
 * originating a new one. Stamping that dead transfer onto the fresh payout would
 * wedge it forever: no webhook ever arrives, `markPaidManually` throws
 * PAYOUT_IN_FLIGHT, and reject/cancel are illegal from `paying`. We detect the
 * DEAD replay two robust ways: (1) the replayed transfer's own status is TERMINAL
 * (`returned`/`canceled`/`rejected`/`failed`), and (2) ANOTHER payout already
 * carries this `increaseTransferId` — which only happens when a prior, now-dead
 * payout minted it (a still-LIVE prior payout would have blocked the re-pay at
 * `beginPayout`, so a match here is always a dead prior). On either, FAIL this
 * payout with `idempotent_replay` WITHOUT advancing the reimbursement (it stays
 * `approved`, so `markPaidManually` still works); the action throws a clear error.
 *
 * We deliberately do NOT trigger on the `Idempotent-Replayed` header alone: a
 * legitimate network-timeout retry also replays — but of a STILL-LIVE transfer,
 * which must be ADOPTED (marked `processing`), not failed. The two signals above
 * fire only for a DEAD replay, so timeout-retry adoption is preserved.
 */
export const applyAchTransfer = internalMutation({
  args: {
    payoutId: v.id("payouts"),
    increaseTransferId: v.string(),
    transferStatus: v.optional(v.string()),
  },
  returns: v.union(
    v.object({ kind: v.literal("applied"), payout: payoutSummaryValidator }),
    v.object({ kind: v.literal("replay") }),
  ),
  handler: async (
    ctx,
    args,
  ): Promise<{ kind: "applied"; payout: PayoutSummary } | { kind: "replay" }> => {
    const now = Date.now();

    // Dead-replay detection (see the doc comment above).
    const statusTerminal =
      !!args.transferStatus &&
      TERMINAL_TRANSFER_STATUSES.includes(args.transferStatus.toLowerCase());
    const othersWithSameTransfer = await ctx.db
      .query("payouts")
      .withIndex("by_increase_transfer", (q) =>
        q.eq("increaseTransferId", args.increaseTransferId),
      )
      .collect();
    const replayedOntoOtherPayout = othersWithSameTransfer.some(
      (p) => p._id !== args.payoutId,
    );
    if (statusTerminal || replayedOntoOtherPayout) {
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
    if (!payout) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Payout not found." });
    }
    // Move the SUBJECT to `paying`, whichever rail this payout belongs to. Both
    // subjects use the same literal and the same two fields, so the branch is
    // only about which table to patch.
    if (payout.reimbursementId) {
      const req = await ctx.db.get(payout.reimbursementId);
      if (req && req.status === "approved") {
        await ctx.db.patch(req._id, {
          status: "paying",
          payoutId: payout._id,
          updatedAt: now,
        });
      }
    } else if (payout.contractorPaymentId) {
      const row = await ctx.db.get(payout.contractorPaymentId);
      if (row && row.status === "approved") {
        await ctx.db.patch(row._id, {
          status: "paying",
          payoutId: payout._id,
          updatedAt: now,
        });
      }
    }
    return { kind: "applied", payout: toPayoutSummary(payout) };
  },
});

/** Mark a payout `failed` after the ACH create call itself failed. */
export const failPayout = internalMutation({
  args: { payoutId: v.id("payouts"), reason: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.payoutId, {
      status: "failed",
      failureReason: args.reason,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Pay an approved reimbursement over ACH from the chapter's Increase account.
 * Manager-only. IDEMPOTENT: a live payout already keyed on `reimbursementId` is
 * returned as-is (never double-pays).
 *
 * DESTINATION-DETAILS GAP: the form only captured `bankAccountLast4`, so a real
 * ACH can't be fully addressed yet — this DEGRADES to a `manual`/`pending`
 * payout and the manager finishes via `markPaidManually`. When the ACH path is
 * enabled, it creates an Increase transfer with `Idempotency-Key:
 * <reimbursementId>`, sets the payout `processing` + the reimbursement `paying`.
 */
export const payReimbursement = action({
  args: { reimbursementId: v.id("reimbursementRequests") },
  returns: payoutSummaryValidator,
  handler: async (ctx, { reimbursementId }): Promise<PayoutSummary> => {
    const result: BeginPayoutResult = await ctx.runMutation(
      internal.increasePayouts.beginPayout,
      { reimbursementId },
    );
    if (result.kind === "existing" || result.kind === "manual") {
      return result.payout;
    }

    // ACH path (enabled once full destination details are captured). Self-select
    // the Increase env from the chapter account's id prefix: a sandbox-
    // provisioned account (`sandbox_...`) routes to the sandbox with its key, a
    // prod account to prod — regardless of the current sandbox toggle. Env not
    // wired for that account's environment → degrade (fail the payout, throw).
    const { key, base } = increaseEnvForObjectId(result.increaseAccountId);
    if (!key) {
      await ctx.runMutation(internal.increasePayouts.failPayout, {
        payoutId: result.payoutId,
        reason: "increase_key_unset",
      });
      throw new ConvexError({
        code: "INCREASE_ERROR",
        message: "Couldn't start the ACH payout. Please try again.",
      });
    }

    // Address the ACH credit. Increase requires EITHER `external_account_id` OR
    // `account_number` + `routing_number` (+ `funding`) — never both. Gated by
    // `hasFullDestination` in `beginPayout`, so `destination` is never null here
    // in practice; the guard keeps us from ever sending an unaddressed credit.
    const destination: Record<string, unknown> | null = result.externalAccountId
      ? { external_account_id: result.externalAccountId }
      : result.accountNumber && result.routingNumber
        ? {
            account_number: result.accountNumber,
            routing_number: result.routingNumber,
            funding: result.funding ?? "checking",
          }
        : null;
    if (!destination) {
      await ctx.runMutation(internal.increasePayouts.failPayout, {
        payoutId: result.payoutId,
        reason: "missing_destination",
      });
      throw new ConvexError({
        code: "INCREASE_ERROR",
        message: "Missing ACH destination details for this payout.",
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
          // Increase requires a statement descriptor, max 10 characters — so
          // "Reimburse" is very nearly all it will hold, and on its own it left
          // every reimbursement in the Increase dashboard reading identically
          // with no way to tell whose it was (owner report, 2026-08-09).
          statement_descriptor: "Reimburse",
          // WHO it is for goes here instead. `individual_name` is the NACHA
          // receiver name — max 22 characters, and the field Increase shows on
          // the transfer alongside the descriptor. Our own ledger row already
          // reads "Reimbursement to <name>" (`lib/reimbursementTxnFields.ts`);
          // this carries the same fact into the bank's record, so the two
          // surfaces stop disagreeing about how much they know.
          individual_name: result.payeeName.slice(0, 22),
          ...destination,
        },
        // Idempotency-Key = reimbursementId (the schema's idempotency key).
        // KEEP this key (never switch to payoutId): a network-timeout retry must
        // replay THE SAME transfer, not originate a second one (double-pay). The
        // trade-off — a replay of a BOUNCED transfer after a reversal — is caught
        // by `applyAchTransfer`'s dead-replay guard (via the replayed transfer's
        // terminal status + the prior payout still holding the id).
        String(reimbursementId),
      );
      const applied = await ctx.runMutation(
        internal.increasePayouts.applyAchTransfer,
        {
          payoutId: result.payoutId,
          increaseTransferId: String(transfer.id),
          transferStatus:
            typeof transfer.status === "string" ? transfer.status : undefined,
        },
      );
      if (applied.kind === "replay") {
        // Increase replayed a dead (already-returned/failed) transfer for this
        // reimbursement's idempotency key — it can no longer be paid over ACH.
        // The payout is marked `failed:idempotent_replay`; the reimbursement is
        // left `approved` so a manager can still `markPaidManually`.
        throw new ConvexError({
          code: "IDEMPOTENT_REPLAY",
          message:
            "This request can no longer be paid by ACH — pay manually and mark paid.",
        });
      }
      return applied.payout;
    } catch (err) {
      // A deliberate replay-of-terminal rejection must propagate as-is (it's not
      // a transient ACH failure — do NOT re-fail the payout or mask the message).
      if (err instanceof ConvexError && err.data?.code === "IDEMPOTENT_REPLAY") {
        throw err;
      }
      console.error("[increase] ach transfer failed:", err);
      await ctx.runMutation(internal.increasePayouts.failPayout, {
        payoutId: result.payoutId,
        reason: "ach_create_failed",
      });
      throw new ConvexError({
        code: "INCREASE_ERROR",
        message: "Couldn't start the ACH payout. Please try again.",
      });
    }
  },
});

// ── markPaidManually (mutation, manager) — the working Phase-4 path ──────────

/**
 * Mark an approved reimbursement paid by hand (the working Phase-4 path while
 * ACH destination linking isn't built). Manager-only. Find-or-creates the
 * `manual` payout, marks it `paid`, sets the reimbursement `paid` + `paidAt`,
 * posts the `flow:"outflow"` ledger row for the expense (which is what puts it
 * into the budget/category totals), and appends a `"pay"` entry to the audit
 * trail. IDEMPOTENT: a re-call after it's paid returns the payout without a
 * second transaction or audit row.
 *
 * The reimbursement side of that — the `paid` patch, the ledger row, and the
 * claimant's "you were paid" notice — is `settleReimbursementPaid`, shared with
 * the ACH webhook path rather than re-implemented here. It used to be an inline
 * copy of the same two writes; folding it back means there is ONE definition of
 * what settling a reimbursement does, and a future third way to pay inherits
 * the notice for free instead of silently going out unannounced.
 */
export const markPaidManually = mutation({
  args: { reimbursementId: v.id("reimbursementRequests") },
  returns: payoutSummaryValidator,
  handler: async (ctx, { reimbursementId }): Promise<PayoutSummary> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    const callerPersonId = await resolveCallerPersonId(ctx, chapterId);

    const req = await ctx.db.get(reimbursementId);
    await requireInChapter(ctx, chapterId, req, "Reimbursement");
    const reimbursement = req!;

    // Disbursement SoD: the caller releasing the payout must not be the payee.
    const callerEmail = await getUserEmail(ctx);
    assertDisbursementSoD(callerPersonId, callerEmail, reimbursement);

    // Find (or create) the live payout keyed on the reimbursement.
    const existingPayouts = await ctx.db
      .query("payouts")
      .withIndex("by_reimbursement", (q) =>
        q.eq("reimbursementId", reimbursementId),
      )
      .take(50);
    let payout =
      existingPayouts.find((p) => LIVE_PAYOUT_STATUSES.includes(p.status)) ??
      null;

    // NEVER manual-clobber an in-flight real ACH payout. Once ACH is enabled a
    // `provider:"increase"` payout with an `increaseTransferId` is (or may be)
    // moving money at Increase; marking it paid by hand here would double-pay
    // (the ACH still settles). Only the true manual/degraded case is completable.
    if (payout && payout.provider === "increase" && payout.increaseTransferId) {
      throw new ConvexError({
        code: "PAYOUT_IN_FLIGHT",
        message:
          "This reimbursement has an ACH payout in progress — it can't be marked paid manually.",
      });
    }

    // IDEMPOTENT: already paid (payout paid + transfer posted) → return as-is.
    if (payout && payout.status === "paid" && reimbursement.status === "paid") {
      return toPayoutSummary(payout);
    }

    // Only an approved / already-paying reimbursement can be marked paid.
    if (
      reimbursement.status !== "approved" &&
      reimbursement.status !== "paying"
    ) {
      throw new ConvexError({
        code: "ILLEGAL_TRANSITION",
        message: "Only an approved reimbursement can be marked paid.",
      });
    }

    // Reject a non-positive amount (guards the `0 ?? x === 0` $0-payout trap).
    const amountCents = reimbursement.approvedCents ?? reimbursement.totalCents;
    assertPositivePayout(amountCents);
    const now = Date.now();

    if (!payout) {
      const payoutId = await ctx.db.insert("payouts", {
        chapterId,
        reimbursementId,
        payeePersonId: reimbursement.personId,
        amountCents,
        provider: "manual",
        status: "pending",
        bankAccountLast4: reimbursement.bankAccountLast4,
        createdAt: now,
        updatedAt: now,
      });
      payout = (await ctx.db.get(payoutId))!;
    }

    await ctx.db.patch(payout._id, {
      provider: "manual",
      status: "paid",
      updatedAt: now,
    });
    // Reimbursement → `paid`, the expense's `outflow` ledger row (idempotent —
    // one per reimbursement), and the claimant's notice. One definition, shared
    // with the ACH path; see this mutation's doc comment.
    await settleReimbursementPaid(ctx, reimbursement, payout);

    // Append to the append-only approval/audit trail.
    await ctx.db.insert("approvals", {
      chapterId,
      subjectType: "payout",
      subjectId: String(payout._id),
      action: "pay",
      actorPersonId: callerPersonId,
      createdAt: now,
    });

    const fresh = await ctx.db.get(payout._id);
    return toPayoutSummary(fresh!);
  },
});

// ── onIncreaseWebhookEvent (internal mutation) — the payout state machine ─────

/**
 * Advance a payout from an Increase ACH-transfer signal. Fed by
 * `increase.handleIncreaseWebhook` (which fetches the transfer to get `status`,
 * since the webhook event carries none); also called directly by tests.
 * `eventType` is the event `category` (`ach_transfer.created`/`.updated`),
 * `status` the FETCHED transfer status. Matches by `increaseTransferId` (the
 * `by_increase_transfer` index); no matching payout → no-op (never throws).
 * Guards transitions: a `paid` payout ignores a later `failed`/`returned`. On
 * `paid` the reimbursement is settled (`paid` + the offsetting `transfer` txn,
 * idempotent); on `failed`/`returned` the reimbursement walks back to
 * `approved`.
 */
export const onIncreaseWebhookEvent = internalMutation({
  args: {
    eventType: v.string(),
    transferId: v.string(),
    status: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { eventType, transferId, status }) => {
    const payout = await ctx.db
      .query("payouts")
      .withIndex("by_increase_transfer", (q) =>
        q.eq("increaseTransferId", transferId),
      )
      .first();
    if (!payout) return null; // unknown transfer → no-op

    const target = payoutTargetFor(eventType, status);
    if (!target) return null;

    await applyPayoutOutcome(
      ctx,
      payout,
      target,
      target === "failed" || target === "returned" ? eventType : undefined,
    );
    return null;
  },
});

// ── listPayouts (query, viewer) ──────────────────────────────────────────────

/** The caller's chapter's payouts (viewer+), newest first. The read shape the
 *  reimbursement/payout UI renders. */
export const listPayouts = query({
  args: {},
  returns: v.array(payoutSummaryValidator),
  handler: async (ctx): Promise<PayoutSummary[]> => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "viewer");

    // Filter to the current environment: a `sandbox_`-prefixed transfer id is a
    // sandbox payout (hidden in production mode, shown in sandbox mode). A NULL
    // transfer id is a manual/degraded payout (env-neutral) — always shown.
    const sandboxMode = await readSandbox(ctx);
    const payouts = (
      await ctx.db
        .query("payouts")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
        .order("desc")
        .take(200)
    ).filter((p) => matchesMode(p.increaseTransferId ?? null, sandboxMode));
    return payouts.map(toPayoutSummary);
  },
});
