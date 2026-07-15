/**
 * Increase — the native money layer for Chapter OS (Phase 4: ACH reimbursement
 * payouts + the chapter's bank Account).
 *
 * Increase is the source of truth for a chapter's balance: one Entity + Account
 * per chapter (`increaseAccounts`), member cards issued on it (Phase 5), and ACH
 * reimbursement payouts (`payouts`) originating from it. NO Stripe Issuing /
 * Connect — Stripe FC (`stripeFinance.ts`) only *reads* legacy accounts.
 *
 * DESIGN (mirrors `stripeFinance.ts`): the network fetch is separated from the
 * DB apply so the payout state machine is testable WITHOUT hitting Increase.
 * Actions FETCH (raw `fetch`, no SDK); internal mutations APPLY against
 * `ctx.db`. The webhook state machine (`onIncreaseWebhookEvent`) is a pure
 * internal mutation the orchestrator's `/increase/webhook` route fans events
 * into after `verifyIncreaseSignature`.
 *
 * INVARIANTS:
 *  - Money is ALWAYS a non-negative INTEGER number of cents; direction lives in
 *    `transactions.flow`, never a sign.
 *  - Every table is chapter-scoped; every client id is verified in the caller's
 *    chapter before use.
 *  - Reimbursement payouts post as `flow:"transfer"` → EXCLUDED from category /
 *    budget spend (the underlying expense was already booked on the line item;
 *    counting the transfer too would double-count).
 *  - `payouts` is idempotency-keyed on `reimbursementId`: at most one LIVE payout
 *    per reimbursement, so an approved reimbursement can NEVER double-pay.
 *  - Degrade to a logged no-op (never throw) when `INCREASE_API_KEY` is unset.
 *  - All failures throw `ConvexError` (never a plain `Error`).
 *
 * DESTINATION-DETAILS GAP (documented, deliberate): the public reimbursement
 * form only captured `bankAccountLast4` — NOT the full routing + account number
 * an ACH credit must be addressed to. So a real Increase ACH transfer cannot yet
 * be fully addressed; `payReimbursement` DEGRADES to a `provider:"manual"`,
 * `pending` payout and steers the manager to `markPaidManually` (the working
 * Phase-4 path). See the TODO breadcrumb in `beginPayout`.
 *
 * Env: INCREASE_API_KEY, INCREASE_WEBHOOK_SECRET.
 */
import {
  action,
  mutation,
  query,
  internalMutation,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  PAYOUT_PROVIDERS,
  PAYOUT_STATUSES,
  INCREASE_ONBOARDING_STATUSES,
  type PayoutProvider,
  type PayoutStatus,
} from "@events-os/shared";
import {
  requireChapterId,
  requireInChapter,
  getChapterIdOrNull,
} from "./lib/context";
import {
  requireFinanceRole,
  requireFinanceManager,
  resolveCallerPersonId,
} from "./lib/finance";

const INCREASE_API = "https://api.increase.com";

/** Payouts that block a re-pay (money is in motion or already out the door).
 *  `failed` / `returned` / `canceled` are NOT live — a fresh payout may follow. */
const LIVE_PAYOUT_STATUSES: readonly PayoutStatus[] = [
  "pending",
  "processing",
  "paid",
];

// ── Validators ────────────────────────────────────────────────────────────────

const onboardingValidator = v.union(
  ...INCREASE_ONBOARDING_STATUSES.map((s) => v.literal(s)),
);
const payoutProviderValidator = v.union(
  ...PAYOUT_PROVIDERS.map((p) => v.literal(p)),
);
const payoutStatusValidator = v.union(
  ...PAYOUT_STATUSES.map((s) => v.literal(s)),
);

/** The read shape the UI renders for a payout (also every action's return). */
const payoutSummaryValidator = v.object({
  id: v.id("payouts"),
  reimbursementId: v.id("reimbursementRequests"),
  payeePersonId: v.union(v.id("people"), v.null()),
  amountCents: v.number(),
  provider: payoutProviderValidator,
  status: payoutStatusValidator,
  increaseTransferId: v.union(v.string(), v.null()),
  createdAt: v.number(),
});

const increaseAccountSummaryValidator = v.object({
  id: v.id("increaseAccounts"),
  chapterId: v.id("chapters"),
  increaseEntityId: v.union(v.string(), v.null()),
  increaseAccountId: v.union(v.string(), v.null()),
  onboardingStatus: onboardingValidator,
});

// ── TS shapes (for action ↔ internal-mutation typing) ────────────────────────

interface PayoutSummary {
  id: Id<"payouts">;
  reimbursementId: Id<"reimbursementRequests">;
  payeePersonId: Id<"people"> | null;
  amountCents: number;
  provider: PayoutProvider;
  status: PayoutStatus;
  increaseTransferId: string | null;
  createdAt: number;
}

interface IncreaseAccountSummary {
  id: Id<"increaseAccounts">;
  chapterId: Id<"chapters">;
  increaseEntityId: string | null;
  increaseAccountId: string | null;
  onboardingStatus: (typeof INCREASE_ONBOARDING_STATUSES)[number];
}

type BeginPayoutResult =
  | { kind: "existing"; payout: PayoutSummary }
  | { kind: "manual"; payout: PayoutSummary }
  | {
      kind: "increase";
      payoutId: Id<"payouts">;
      increaseAccountId: string;
      amountCents: number;
      reimbursementId: Id<"reimbursementRequests">;
    };

type BeginProvisionResult =
  | { kind: "existing"; account: IncreaseAccountSummary }
  | {
      kind: "provision";
      accountId: Id<"increaseAccounts">;
      chapterId: Id<"chapters">;
      chapterName: string;
    };

function toPayoutSummary(p: Doc<"payouts">): PayoutSummary {
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

function toAccountSummary(a: Doc<"increaseAccounts">): IncreaseAccountSummary {
  return {
    id: a._id,
    chapterId: a.chapterId,
    increaseEntityId: a.increaseEntityId ?? null,
    increaseAccountId: a.increaseAccountId ?? null,
    onboardingStatus: a.onboardingStatus,
  };
}

// ── Raw Increase fetch helpers (default runtime `fetch`, no SDK) ──────────────

/** POST JSON to the Increase API. `idempotencyKey` sets the `Idempotency-Key`
 *  header so a retried request never creates a second transfer. Throws
 *  ConvexError on a non-2xx (the caller logs + degrades). */
async function increasePost(
  key: string,
  path: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(`${INCREASE_API}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`[increase] POST ${path} failed:`, await res.text());
    throw new ConvexError({
      code: "INCREASE_ERROR",
      message: "The Increase request failed. Please try again.",
    });
  }
  return (await res.json()) as Record<string, unknown>;
}

// ── Payout state-machine helpers (pure DB, the testable core) ────────────────

/** The single `transfer`-flow transaction recording a reimbursement payout
 *  leaving the account. IDEMPOTENT: at most one per reimbursement (keyed via
 *  the `by_reimbursement` index). Positive integer cents; `flow:"transfer"` so
 *  it's excluded from category/budget spend. Links the payout to the txn. */
async function postReimbursementTransfer(
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
  const txnId = await ctx.db.insert("transactions", {
    chapterId,
    source: "reimbursement",
    flow: "transfer", // EXCLUDED from category/budget spend (anti-double-count)
    amountCents: payout.amountCents,
    currency: "usd",
    postedAt: now,
    personId: req.personId,
    reimbursementId: req._id,
    status: "reconciled",
    createdAt: now,
  });
  await ctx.db.patch(payout._id, { transactionId: txnId, updatedAt: now });
  return txnId;
}

/** Settle a payout: mark the reimbursement `paid` + post the offsetting
 *  `transfer` ledger row. Idempotent via `postReimbursementTransfer`. */
async function settleReimbursementPaid(
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
  }
  await postReimbursementTransfer(ctx, req.chapterId, req, payout);
}

/** The payout status an inbound webhook event maps to (or null = ignore).
 *
 * ASSUMPTION: Increase's ACH-transfer lifecycle is read from `eventType`
 * (`ach_transfer.*`) plus the object's `status`. There's no single "settled"
 * status on an ACH transfer, so the orchestrator translates a settlement signal
 * into a `paid`/`settled` status (or an `ach_transfer.settled` eventType); both
 * are accepted here. `returned` / `failed` / `rejected` map to the matching
 * non-live terminal; created/submitted/pending map to `processing`. */
type PayoutTarget = "processing" | "paid" | "failed" | "returned";
function payoutTargetFor(
  eventType: string,
  status?: string,
): PayoutTarget | null {
  const s = (status ?? "").toLowerCase();
  const e = eventType.toLowerCase();
  if (s === "returned" || e.includes("returned")) return "returned";
  if (
    ["failed", "rejected", "declined"].includes(s) ||
    e.includes("failed") ||
    e.includes("rejected")
  ) {
    return "failed";
  }
  if (
    ["paid", "settled", "complete", "completed"].includes(s) ||
    e.includes("settled") ||
    e.includes("paid")
  ) {
    return "paid";
  }
  if (
    ["submitted", "pending_submission", "pending_approval", "created", "processing"].includes(
      s,
    ) ||
    e.includes("created") ||
    e.includes("submitted") ||
    e.includes("updated")
  ) {
    return "processing";
  }
  return null;
}

/** Advance a payout toward `target`, guarding illegal transitions. A `paid`
 *  (or `canceled`) payout is terminal — it ignores a later `failed`/`returned`. */
async function applyPayoutOutcome(
  ctx: MutationCtx,
  payout: Doc<"payouts">,
  target: PayoutTarget,
  failureReason?: string,
): Promise<void> {
  const now = Date.now();
  // Terminal states ignore any later signal (a paid payout can't "un-pay").
  if (payout.status === "paid" || payout.status === "canceled") return;

  const req = await ctx.db.get(payout.reimbursementId);

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

// ── provisionChapterAccount (action, manager) ────────────────────────────────

/** Gate + find-or-create the chapter's `increaseAccounts` row. Manager-only.
 *  Returns the existing account when it's already active (idempotent), else the
 *  row to provision + the chapter name for the Increase Entity. */
export const beginProvision = internalMutation({
  args: {},
  returns: v.union(
    v.object({ kind: v.literal("existing"), account: increaseAccountSummaryValidator }),
    v.object({
      kind: v.literal("provision"),
      accountId: v.id("increaseAccounts"),
      chapterId: v.id("chapters"),
      chapterName: v.string(),
    }),
  ),
  handler: async (ctx): Promise<BeginProvisionResult> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);

    const existing = await ctx.db
      .query("increaseAccounts")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .first();
    if (
      existing &&
      existing.onboardingStatus === "active" &&
      existing.increaseAccountId
    ) {
      return { kind: "existing", account: toAccountSummary(existing) };
    }

    const chapter = await ctx.db.get(chapterId);
    const chapterName = chapter?.name ?? "Chapter";

    if (existing) {
      return { kind: "provision", accountId: existing._id, chapterId, chapterName };
    }
    const now = Date.now();
    const accountId = await ctx.db.insert("increaseAccounts", {
      chapterId,
      onboardingStatus: "not_started",
      createdAt: now,
      updatedAt: now,
    });
    return { kind: "provision", accountId, chapterId, chapterName };
  },
});

/** Patch the `increaseAccounts` row after provisioning (or the degrade path). */
export const finishProvision = internalMutation({
  args: {
    accountId: v.id("increaseAccounts"),
    onboardingStatus: onboardingValidator,
    increaseEntityId: v.optional(v.string()),
    increaseAccountId: v.optional(v.string()),
  },
  returns: increaseAccountSummaryValidator,
  handler: async (ctx, args): Promise<IncreaseAccountSummary> => {
    const patch: Partial<Doc<"increaseAccounts">> = {
      onboardingStatus: args.onboardingStatus,
      updatedAt: Date.now(),
    };
    if (args.increaseEntityId) patch.increaseEntityId = args.increaseEntityId;
    if (args.increaseAccountId) patch.increaseAccountId = args.increaseAccountId;
    await ctx.db.patch(args.accountId, patch);
    const row = await ctx.db.get(args.accountId);
    if (!row) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Increase account row vanished.",
      });
    }
    return toAccountSummary(row);
  },
});

/**
 * Provision the chapter's single Increase Entity + Account (one per chapter).
 * Manager-only. Idempotent: an already-active account is returned untouched.
 * DEGRADES (logs + returns, never throws) to `onboardingStatus:"pending"` when
 * `INCREASE_API_KEY` is unset — the finance vendor isn't wired up yet.
 */
export const provisionChapterAccount = action({
  args: {},
  returns: increaseAccountSummaryValidator,
  handler: async (ctx): Promise<IncreaseAccountSummary> => {
    const prep: BeginProvisionResult = await ctx.runMutation(
      internal.increase.beginProvision,
      {},
    );
    if (prep.kind === "existing") return prep.account;

    const key = process.env.INCREASE_API_KEY;
    if (!key) {
      console.warn(
        "[increase] provision skipped: INCREASE_API_KEY not configured",
      );
      return await ctx.runMutation(internal.increase.finishProvision, {
        accountId: prep.accountId,
        onboardingStatus: "pending",
      });
    }

    // NOTE: a real Increase Entity requires KYC/KYB details this app hasn't
    // collected yet — full onboarding is a hosted flow beyond Phase 4. This
    // call shape is provisional; on any failure we degrade to `pending`.
    // TODO: drive Increase Entity onboarding (KYB) before going live.
    try {
      const entity = await increasePost(key, "/entities", {
        structure: "corporation",
        corporation: { name: prep.chapterName },
      });
      const account = await increasePost(key, "/accounts", {
        entity_id: entity.id,
        name: `${prep.chapterName} operating`,
      });
      return await ctx.runMutation(internal.increase.finishProvision, {
        accountId: prep.accountId,
        onboardingStatus: "active",
        increaseEntityId: String(entity.id),
        increaseAccountId: String(account.id),
      });
    } catch (err) {
      console.error("[increase] provision failed:", err);
      return await ctx.runMutation(internal.increase.finishProvision, {
        accountId: prep.accountId,
        onboardingStatus: "pending",
      });
    }
  },
});

// ── payReimbursement (action, manager) ───────────────────────────────────────

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

    const amountCents = reimbursement.approvedCents ?? reimbursement.totalCents;
    const now = Date.now();

    // Is a real ACH addressable? Needs the vendor wired, an active account, AND
    // full destination bank details. We only captured `bankAccountLast4`, so a
    // real ACH can't be fully addressed yet → we always DEGRADE to manual.
    // TODO: capture full destination bank details via Increase external-account
    // linking, then flip `hasFullDestination` true and route ACH transfers.
    const hasFullDestination = false;
    const account = await ctx.db
      .query("increaseAccounts")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .first();
    const canAch =
      !!process.env.INCREASE_API_KEY &&
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

/** Apply a created Increase ACH transfer to the payout: `processing` +
 *  `increaseTransferId`, and move the reimbursement to `paying`. */
export const applyAchTransfer = internalMutation({
  args: {
    payoutId: v.id("payouts"),
    increaseTransferId: v.string(),
  },
  returns: payoutSummaryValidator,
  handler: async (ctx, args): Promise<PayoutSummary> => {
    const now = Date.now();
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
    const req = await ctx.db.get(payout.reimbursementId);
    if (req && req.status === "approved") {
      await ctx.db.patch(req._id, {
        status: "paying",
        payoutId: payout._id,
        updatedAt: now,
      });
    }
    return toPayoutSummary(payout);
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
      internal.increase.beginPayout,
      { reimbursementId },
    );
    if (result.kind === "existing" || result.kind === "manual") {
      return result.payout;
    }

    // ACH path (enabled once full destination details are captured).
    const key = process.env.INCREASE_API_KEY!;
    try {
      const transfer = await increasePost(
        key,
        "/ach_transfers",
        {
          account_id: result.increaseAccountId,
          amount: result.amountCents,
          statement_descriptor: "Reimbursement",
        },
        // Idempotency-Key = reimbursementId (the schema's idempotency key).
        String(reimbursementId),
      );
      return await ctx.runMutation(internal.increase.applyAchTransfer, {
        payoutId: result.payoutId,
        increaseTransferId: String(transfer.id),
      });
    } catch (err) {
      console.error("[increase] ach transfer failed:", err);
      await ctx.runMutation(internal.increase.failPayout, {
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
 * posts the offsetting `flow:"transfer"` ledger row (excluded from spend), and
 * appends a `"pay"` entry to the audit trail. IDEMPOTENT: a re-call after it's
 * paid returns the payout without a second transaction or audit row.
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

    const amountCents =
      reimbursement.approvedCents ?? reimbursement.totalCents;
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
    await ctx.db.patch(reimbursement._id, {
      status: "paid",
      paidAt: reimbursement.paidAt ?? now,
      payoutId: payout._id,
      updatedAt: now,
    });
    // Offsetting `transfer` ledger row (idempotent — one per reimbursement).
    await postReimbursementTransfer(ctx, chapterId, reimbursement, payout);

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
 * Advance a payout from an inbound Increase `ach_transfer.*` webhook event.
 * Matches by `increaseTransferId` (the `by_increase_transfer` index); no
 * matching payout → no-op (never throws). Guards transitions: a `paid` payout
 * ignores a later `failed`/`returned`. On `paid` the reimbursement is settled
 * (`paid` + the offsetting `transfer` txn, idempotent); on `failed`/`returned`
 * the reimbursement walks back to `approved`.
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

// ── verifyIncreaseSignature (webhook signature verify) ───────────────────────

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Verify an Increase webhook signature against the raw payload — HMAC-SHA256 of
 * `${t}.${payload}` with the webhook signing secret, constant-time compared
 * against every `v1` candidate, 5-minute timestamp tolerance. The orchestrator
 * calls this in `/increase/webhook`.
 *
 * ASSUMPTION: Increase signs webhooks with a scheme mirroring Stripe's
 * `t=...,v1=...` header (see `verifyStripeSignature`). If Increase's real header
 * format differs, only this parser changes — the HMAC construction is identical.
 */
export async function verifyIncreaseSignature(
  payload: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader) return false;
  const parts = new Map<string, string[]>();
  for (const kv of signatureHeader.split(",")) {
    const [k, val] = kv.split("=", 2);
    if (!k || !val) continue;
    const list = parts.get(k.trim()) ?? [];
    list.push(val.trim());
    parts.set(k.trim(), list);
  }
  const timestamp = Number(parts.get("t")?.[0]);
  const candidates = parts.get("v1") ?? [];
  if (!Number.isFinite(timestamp) || candidates.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${timestamp}.${payload}`),
    ),
  );

  for (const candidate of candidates) {
    if (candidate.length !== mac.length * 2) continue;
    const candidateBytes = hexToBytes(candidate);
    let diff = 0;
    for (let i = 0; i < mac.length; i++) diff |= mac[i] ^ candidateBytes[i];
    if (diff === 0) return true;
  }
  return false;
}

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

    const payouts = await ctx.db
      .query("payouts")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .order("desc")
      .take(200);
    return payouts.map(toPayoutSummary);
  },
});
