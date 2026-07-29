/**
 * Shared validators, TS shapes, and small guards for the `increase*` modules:
 * the payout / account summary read shapes (what actions return and the UI
 * renders), the payout-status ladders, and the two payout preconditions
 * (positive amount, disbursement separation-of-duties).
 *
 * PURE HELPERS ONLY — nothing in `lib/` registers Convex functions (see
 * `lib/increaseApi.ts`'s header note).
 */
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import {
  PAYOUT_PROVIDERS,
  PAYOUT_STATUSES,
  INCREASE_ONBOARDING_STATUSES,
  type PayoutProvider,
  type PayoutStatus,
} from "@events-os/shared";
import {
  normalizeEmail,
} from "./access";
import {
  assertSeparationOfDuties,
  type FinanceScope,
} from "./finance";

// ── Validators ────────────────────────────────────────────────────────────────

export const onboardingValidator = v.union(
  ...INCREASE_ONBOARDING_STATUSES.map((s) => v.literal(s)),
);
export const payoutProviderValidator = v.union(
  ...PAYOUT_PROVIDERS.map((p) => v.literal(p)),
);
export const payoutStatusValidator = v.union(
  ...PAYOUT_STATUSES.map((s) => v.literal(s)),
);

/** The read shape the UI renders for a payout (also every action's return). */
export const payoutSummaryValidator = v.object({
  id: v.id("payouts"),
  reimbursementId: v.id("reimbursementRequests"),
  payeePersonId: v.union(v.id("people"), v.null()),
  amountCents: v.number(),
  provider: payoutProviderValidator,
  status: payoutStatusValidator,
  increaseTransferId: v.union(v.string(), v.null()),
  createdAt: v.number(),
});

export const financeScopeValidator = v.union(
  v.id("chapters"),
  v.literal("central"),
);

export const increaseAccountSummaryValidator = v.object({
  id: v.id("increaseAccounts"),
  chapterId: financeScopeValidator,
  increaseEntityId: v.union(v.string(), v.null()),
  increaseAccountId: v.union(v.string(), v.null()),
  onboardingStatus: onboardingValidator,
});

// ── TS shapes (for action ↔ internal-mutation typing) ────────────────────────

export interface PayoutSummary {
  id: Id<"payouts">;
  reimbursementId: Id<"reimbursementRequests">;
  payeePersonId: Id<"people"> | null;
  amountCents: number;
  provider: PayoutProvider;
  status: PayoutStatus;
  increaseTransferId: string | null;
  createdAt: number;
}

export interface IncreaseAccountSummary {
  id: Id<"increaseAccounts">;
  chapterId: FinanceScope;
  increaseEntityId: string | null;
  increaseAccountId: string | null;
  onboardingStatus: (typeof INCREASE_ONBOARDING_STATUSES)[number];
}

export type BeginPayoutResult =
  | { kind: "existing"; payout: PayoutSummary }
  | { kind: "manual"; payout: PayoutSummary }
  | {
      kind: "increase";
      payoutId: Id<"payouts">;
      increaseAccountId: string;
      amountCents: number;
      reimbursementId: Id<"reimbursementRequests">;
      // ACH destination (whichever exists): the reimbursement's linked Increase
      // External Account (`reimbursementRequests.externalAccountId`, captured
      // via `linkPublicBankAccount` / `linkBankAccount`), OR raw routing +
      // account (+ funding) — currently always null; kept for forward-compat
      // with a future raw-details capture path. `beginPayout` only takes this
      // branch when `hasFullDestination` is true, so `payReimbursement` always
      // has something here to address the transfer with.
      externalAccountId: string | null;
      accountNumber: string | null;
      routingNumber: string | null;
      funding: "checking" | "savings" | null;
    };

export type BeginProvisionResult =
  | { kind: "existing"; account: IncreaseAccountSummary }
  | {
      kind: "provision";
      accountId: Id<"increaseAccounts">;
      chapterId: FinanceScope;
      chapterName: string;
    };

export function toPayoutSummary(p: Doc<"payouts">): PayoutSummary {
  return {
    id: p._id,
    reimbursementId: p.reimbursementId,
    payeePersonId: p.payeePersonId ?? null,
    amountCents: p.amountCents,
    provider: p.provider,
    status: p.status,
    increaseTransferId: p.increaseTransferId ?? null,
    createdAt: p.createdAt,
  };
}

export function toAccountSummary(
  a: Doc<"increaseAccounts">,
): IncreaseAccountSummary {
  return {
    id: a._id,
    chapterId: a.chapterId,
    increaseEntityId: a.increaseEntityId ?? null,
    increaseAccountId: a.increaseAccountId ?? null,
    onboardingStatus: a.onboardingStatus,
  };
}

// ── Payout preconditions ─────────────────────────────────────────────────────

/** Payouts that block a re-pay (money is in motion or already out the door).
 *  `failed` / `returned` / `canceled` are NOT live — a fresh payout may follow. */
export const LIVE_PAYOUT_STATUSES: readonly PayoutStatus[] = [
  "pending",
  "processing",
  "paid",
];

/** Terminal ACH-transfer statuses. A transfer in one of these can never move
 *  money — if Increase returns one on our CREATE call, it's a REPLAY of a dead
 *  prior transfer, not a fresh origination (see `applyAchTransfer`). */
export const TERMINAL_TRANSFER_STATUSES = [
  "returned",
  "canceled",
  "cancelled",
  "rejected",
  "failed",
];

/** Reject a non-positive payout amount. Guards the `0 ?? x === 0` trap: a
 *  reimbursement approved with zero lines has `approvedCents === 0`, which would
 *  otherwise mint a $0 payout + $0 `transfer` marked paid. */
export function assertPositivePayout(amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new ConvexError({
      code: "INVALID_AMOUNT",
      message:
        "A reimbursement payout must be a positive whole number of cents.",
    });
  }
}

/**
 * Disbursement separation of duties: the person RELEASING a payout must not be
 * the payee. Mirrors the approval-side SoD (`reimbursements.ts`) with two
 * independent signals so it can't be sidestepped:
 *   - the roster link: the caller's person is the request's linked payee, OR
 *   - the email: the caller's auth email equals the request's `payeeEmail`
 *     (case-insensitive) — catches an unlinked self-submission.
 */
export function assertDisbursementSoD(
  callerPersonId: Id<"people">,
  callerEmail: string | null,
  req: Doc<"reimbursementRequests">,
): void {
  assertSeparationOfDuties(callerPersonId, req.personId);
  const payer = normalizeEmail(callerEmail);
  const payee = normalizeEmail(req.payeeEmail);
  if (payer && payee && payer === payee) {
    throw new ConvexError({
      code: "SOD_VIOLATION",
      message:
        "The person releasing a payout must be different from the payee.",
    });
  }
}
