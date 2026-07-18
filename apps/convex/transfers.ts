/**
 * The City Launch Fund money flows — WP-4.1 (the skim) + WP-4.2 (launch grants)
 * + WP-4.5 (inter-scope settlement).
 *
 * The playbook moves money BOTH ways between a chapter and central (PRD §0.1):
 *  - UP:   the monthly ~15% SKIM, chapter → central City Launch Fund.
 *  - DOWN: a one-time LAUNCH GRANT, central → a new chapter (equipment +
 *          training trip), which ALSO stamps a launch budget on that chapter.
 *
 * WP-4.5 adds a THIRD kind, SETTLEMENT, for a different problem: cards stay
 * account-scoped (cash physics — a chapter's card always draws on the
 * chapter's own account), but Reconcile's `budgetId` attribution crosses
 * scopes freely (a chapter's card can pay for a central budget line, or vice
 * versa). That creates a net CASH imbalance separate from the skim — the
 * account that PAID isn't always the scope whose BUDGET absorbed it. Owner
 * policy: "Your card determines whose account paid; reconcile determines
 * whose budget it was; Central settles the difference monthly alongside the
 * skim." `interScopeBalances` computes that ledger-derived imbalance (see its
 * doc comment); `recordSettlementTransfer`/`initiateSettlementTransfer` true
 * it up, mirroring the skim/launch-grant machinery exactly.
 *
 * LEDGER MODEL. Every transfer is a PAIR of `flow:"transfer"` transactions — an
 * outflow leg on the source scope + an inflow leg on the destination scope —
 * linked by a shared `transactions.transferGroupId` (mirroring how a
 * reimbursement payout leg is a `flow:"transfer"` row keyed by `reimbursementId`).
 * The leg's `source` (`skim`/`launch_grant`) names the kind and its `chapterId`
 * (a real chapter vs the `"central"` sentinel) names the side. Transfers never
 * count as spend (`countsAsSpend`), so no budget/category rollup is distorted.
 *
 * REAL MONEY. Two entry points per direction (mirroring reimbursement's
 * manual-vs-ACH split):
 *  - `record*` MUTATION: records the ledger truth for money that moved OUTSIDE
 *    the app (e.g. the owner moved it in the Increase dashboard). No network.
 *  - `initiate*` ACTION: performs the REAL Increase account-to-account transfer
 *    (`POST /account_transfers`, Idempotency-Key = the deterministic group id),
 *    then records the same ledger pair stamped with the Increase transfer id.
 *    It NEVER auto-fires — a human runs it — and DEGRADES to a `NOT_CONFIGURED`
 *    error (telling the caller to use the `record*` mutation) whenever the two
 *    accounts aren't both active in the current mode with a wired API key. So a
 *    merge → prod deploy can never move money on its own.
 *
 * GATING (per the PRD seat table §0.2):
 *  - the skim is a central MONEY WRITE → central reach + bookkeeper+ (#151).
 *  - a launch grant is a central-ED/FM decision → `requireCentralEdOrFm` (#149).
 *
 * IDEMPOTENCY. The `transferGroupId` is deterministic — `skim-<chapter>-<yyyy>-<mm>`
 * (one per month) and `launch-<chapter>` (one per chapter, ever). Re-recording
 * the same id is REJECTED with an `ALREADY_RECORDED` `ConvexError` (not a silent
 * no-op) so a duplicate is loud; the Increase Idempotency-Key guards the vendor
 * side of the initiate path identically.
 */
import {
  mutation,
  action,
  query,
  internalMutation,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  CENTRAL,
  CENTRAL_SKIM_PCT,
  LAUNCH_BUDGET_TEMPLATE,
  launchTemplateTotalCents,
  skimAmountCents,
  skimTransferGroupId,
  launchTransferGroupId,
  settlementTransferGroupId,
  easternParts,
  formatCents,
  matchesMode,
  type TransactionSource,
} from "@events-os/shared";
import { requireChapterId, requireUserId } from "./lib/context";
import {
  requireCentralFinanceRole,
  requireCentralEdOrFm,
  getChapterAccountForMode,
  defaultFundId,
  type FinanceScope,
} from "./lib/finance";
import { readSandbox } from "./financeSettings";
import { increaseEnvForObjectId } from "./increase";
import { ROLLUP_SCAN_LIMIT, isSpend, inPeriod, txnMatchesMode } from "./finances";

// ── Shared amount validation ─────────────────────────────────────────────────

/** A transfer amount must be a positive whole number of cents (invariant #1). */
function assertPositiveCents(amountCents: number, label = "Transfer amount"): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new ConvexError({
      code: "INVALID_AMOUNT",
      message: `${label} must be a positive whole number of cents.`,
    });
  }
}

function assertValidMonth(month: number): void {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new ConvexError({ code: "INVALID_PERIOD", message: "Month must be 1–12." });
  }
}

/**
 * Resolve a skim's amount from EXACTLY ONE of `monthlyBackerRevenueCents` (→
 * `CENTRAL_SKIM_PCT` of it, integer-rounded) or an explicit `amountCents`.
 * Providing both, or neither, is rejected — the caller must be unambiguous
 * about whether the app computes the skim or is told it.
 */
function resolveSkimAmount(args: {
  monthlyBackerRevenueCents?: number;
  amountCents?: number;
}): number {
  const hasRevenue = args.monthlyBackerRevenueCents != null;
  const hasAmount = args.amountCents != null;
  if (hasRevenue === hasAmount) {
    throw new ConvexError({
      code: "INVALID_ARGS",
      message:
        "Provide exactly one of monthlyBackerRevenueCents or amountCents.",
    });
  }
  if (hasAmount) {
    assertPositiveCents(args.amountCents!);
    return args.amountCents!;
  }
  const revenue = args.monthlyBackerRevenueCents!;
  if (!Number.isInteger(revenue) || revenue < 0) {
    throw new ConvexError({
      code: "INVALID_AMOUNT",
      message: "Monthly backer revenue must be a whole number of cents.",
    });
  }
  const amount = skimAmountCents(revenue);
  if (amount <= 0) {
    throw new ConvexError({
      code: "INVALID_AMOUNT",
      message: `A ${Math.round(CENTRAL_SKIM_PCT * 100)}% skim on ${formatCents(revenue)} rounds to $0 — nothing to move.`,
    });
  }
  return amount;
}

/** A representative timestamp (noon-ish ET on the 15th) inside a skim's month,
 *  so the recorded legs bucket into the right dashboard period. */
function skimPostedAt(year: number, month: number): number {
  // 16:00 UTC ≈ noon ET (handles both EST/EDT for a mid-month, mid-day stamp).
  return Date.UTC(year, month - 1, 15, 16, 0, 0);
}

/** Assert a client-supplied chapter id points at a real, existing chapter (a
 *  skim/grant counterpart is always a real chapter, never the central sentinel). */
async function loadRealChapter(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<Doc<"chapters">> {
  const chapter = await ctx.db.get(chapterId);
  if (!chapter) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Chapter not found." });
  }
  return chapter;
}

// ── The ledger pair (the shared core both entry points record) ───────────────

/** Every transaction row carrying this `transferGroupId` (0, or the 2 legs). */
async function transferPairLegs(
  ctx: QueryCtx,
  transferGroupId: string,
): Promise<Doc<"transactions">[]> {
  return await ctx.db
    .query("transactions")
    .withIndex("by_transfer_group", (q) =>
      q.eq("transferGroupId", transferGroupId),
    )
    .collect();
}

interface RecordPairArgs {
  sourceScope: FinanceScope;
  destScope: FinanceScope;
  amountCents: number;
  source: Extract<TransactionSource, "skim" | "launch_grant" | "settlement">;
  transferGroupId: string;
  postedAt: number;
  note?: string;
  /** The Increase account-transfer id when this pair records a REAL movement;
   *  absent for a manually-recorded (money-moved-outside) pair. */
  increaseTransferId?: string;
  /** WP-4.5 ONLY: which way a `settlement` pair moved — see the schema field's
   *  doc comment. Absent for skim/launch_grant (direction is fixed by kind). */
  transferDirection?: SettlementDirection;
  userId: Id<"users">;
}

/**
 * Insert the two `flow:"transfer"` legs (outflow on `sourceScope`, inflow on
 * `destScope`), both carrying the same `transferGroupId`. REJECTS with
 * `ALREADY_RECORDED` when a pair for that id already exists — the deterministic
 * id makes a re-record a loud duplicate, never a silent double-move. Returns the
 * two leg ids (outflow = the money-leaving leg, inflow = the money-arriving leg).
 */
async function recordTransferPair(
  ctx: MutationCtx,
  a: RecordPairArgs,
): Promise<{ outflowId: Id<"transactions">; inflowId: Id<"transactions"> }> {
  assertPositiveCents(a.amountCents);
  const existing = await transferPairLegs(ctx, a.transferGroupId);
  if (existing.length > 0) {
    throw new ConvexError({
      code: "ALREADY_RECORDED",
      message: "This transfer has already been recorded.",
    });
  }
  const now = Date.now();
  // Shared columns for both legs. `flow:"transfer"` → excluded from spend;
  // `status:"reconciled"` (it's a settled, fully-attributed movement, not a
  // charge awaiting review). The Increase id (when real) lives in `externalId`,
  // like every other vendor-originated row — it never collides with card/ACH
  // sync (those key on `transaction_*` ids, not `account_transfer_*`), and
  // `source` isn't `increase_card`/`increase_ach` so it stays env-neutral in the
  // dashboard's mode filter (same as a reimbursement transfer leg).
  const shared = {
    source: a.source,
    flow: "transfer" as const,
    amountCents: a.amountCents,
    currency: "usd",
    postedAt: a.postedAt,
    description: a.note,
    transferGroupId: a.transferGroupId,
    transferDirection: a.transferDirection,
    externalId: a.increaseTransferId,
    status: "reconciled" as const,
    createdBy: a.userId,
    createdAt: now,
  };
  const outflowId = await ctx.db.insert("transactions", {
    chapterId: a.sourceScope,
    ...shared,
  });
  const inflowId = await ctx.db.insert("transactions", {
    chapterId: a.destScope,
    ...shared,
  });
  return { outflowId, inflowId };
}

/**
 * Stamp the playbook launch budget on a freshly-granted chapter: one `one_time`
 * budget per NONZERO template line (owner rule — a zeroed line is skipped).
 * Called inside the launch-grant mutation right after its ledger pair is
 * recorded, so the `ALREADY_RECORDED` guard above makes it once-per-chapter too.
 */
async function stampLaunchBudget(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
  year: number,
  userId: Id<"users">,
): Promise<Id<"budgets">[]> {
  const fundId = (await defaultFundId(ctx, chapterId)) ?? undefined;
  const now = Date.now();
  const ids: Id<"budgets">[] = [];
  for (const line of LAUNCH_BUDGET_TEMPLATE) {
    if (line.amountCents <= 0) continue; // only nonzero lines become budgets
    const id = await ctx.db.insert("budgets", {
      chapterId,
      amountCents: line.amountCents,
      label: line.label,
      type: "one_time",
      cadence: "one_off",
      year,
      fundId,
      createdBy: userId,
      createdAt: now,
    });
    ids.push(id);
  }
  return ids;
}

// ── Increase account-to-account transfer (the real movement) ─────────────────

/**
 * `POST /account_transfers` — move money between two accounts in the same
 * Increase group (grounded against increase.com/documentation/api/account-transfers):
 * body is `{ account_id, amount, destination_account_id, description }`, the
 * `Idempotency-Key` header dedups a retry, and the created transfer comes back
 * with `id` + `status` (`pending_approval` | `complete` | `canceled`). We omit
 * `require_approval`, so a same-group transfer completes straight away.
 */
async function postAccountTransfer(
  key: string,
  base: string,
  body: {
    account_id: string;
    destination_account_id: string;
    amount: number;
    description: string;
  },
  idempotencyKey: string,
): Promise<{ id: string; status: string }> {
  const res = await fetch(`${base}/account_transfers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[transfers] POST /account_transfers failed:`, text);
    throw new ConvexError({
      code: "INCREASE_ERROR",
      message: "Couldn't start the transfer with Increase. Please try again.",
    });
  }
  const json = (await res.json()) as Record<string, unknown>;
  return { id: String(json.id), status: String(json.status ?? "") };
}

/**
 * Assert a freshly-created Increase account transfer is booking-safe.
 * Grounded against increase.com/documentation/api/account-transfers: a
 * same-group transfer (no `require_approval`) usually comes back `complete`
 * immediately, but Increase can also return `pending_approval` (the account
 * requires manual approval in the Increase dashboard) or `canceled`. Booking
 * the ledger pair for either would let money that never moved (or hasn't
 * moved YET) look reconciled, so this throws instead of the caller recording
 * anything. The deterministic `Idempotency-Key` (the transfer group id) makes
 * a later re-run of `initiate*` safe either way: the re-POST returns the SAME
 * Increase transfer object — once it's `complete`, that re-run books the pair.
 */
function assertTransferSettled(
  transfer: { id: string; status: string },
  label: string,
): void {
  if (transfer.status === "complete") return;
  if (transfer.status === "pending_approval") {
    throw new ConvexError({
      code: "TRANSFER_PENDING_APPROVAL",
      message: `${label} (Increase transfer ${transfer.id}) is awaiting approval at Increase and was NOT recorded. Approve it in the Increase dashboard, then re-run this same initiate call — the idempotency key returns the same transfer, now complete, and books it then.`,
    });
  }
  if (transfer.status === "canceled") {
    throw new ConvexError({
      code: "TRANSFER_CANCELED",
      message: `${label} (Increase transfer ${transfer.id}) was canceled at Increase. Nothing was recorded.`,
    });
  }
  throw new ConvexError({
    code: "TRANSFER_NOT_SETTLED",
    message: `${label} (Increase transfer ${transfer.id}) came back with an unexpected status "${transfer.status}" and was NOT recorded. Check the transfer in the Increase dashboard before retrying.`,
  });
}

/**
 * Run the post-POST recording mutation, translating any failure into an
 * operator-actionable `ConvexError`. The Increase transfer already succeeded
 * at this point (its id is `transfer.id`) — a failure here (a transient
 * Convex error, a network blip) means the money moved but the ledger pair
 * didn't get written. The fix is always the same re-run, and the deterministic
 * Idempotency-Key makes it safe (the re-POST returns the same, already-
 * complete transfer and books it on retry) — so the error says exactly that
 * instead of surfacing a generic/opaque failure.
 */
async function recordAfterTransferOrExplain<T>(
  transfer: { id: string },
  record: () => Promise<T>,
): Promise<T> {
  try {
    return await record();
  } catch (err) {
    console.error(
      `[transfers] recording failed after Increase transfer ${transfer.id} succeeded:`,
      err,
    );
    throw new ConvexError({
      code: "RECORD_FAILED_AFTER_TRANSFER",
      message: `The Increase transfer succeeded (id ${transfer.id}) but recording failed — RE-RUN this transfer with the same inputs to record it; the duplicate-send is prevented by the idempotency key.`,
    });
  }
}

/**
 * Resolve the two live Increase accounts for a real movement, or throw
 * `NOT_CONFIGURED`. Both the source + destination scopes must have an `active`
 * account WITH an `increaseAccountId` in the CURRENT mode; anything less means
 * the money can't move for real yet and the caller must fall back to the
 * `record*` mutation. Returns the two Increase account ids.
 */
async function resolveLiveAccounts(
  ctx: QueryCtx,
  sourceScope: FinanceScope,
  destScope: FinanceScope,
): Promise<{ sourceAccountId: string; destAccountId: string }> {
  const sandboxMode = await readSandbox(ctx);
  const source = await getChapterAccountForMode(ctx, sourceScope, sandboxMode);
  const dest = await getChapterAccountForMode(ctx, destScope, sandboxMode);
  const ready = (a: Doc<"increaseAccounts"> | null): a is Doc<"increaseAccounts"> =>
    a != null && a.onboardingStatus === "active" && !!a.increaseAccountId;
  if (!ready(source) || !ready(dest)) {
    throw new ConvexError({
      code: "NOT_CONFIGURED",
      message:
        "Both accounts must be active in this mode to move money for real — record the transfer manually instead.",
    });
  }
  return {
    sourceAccountId: source.increaseAccountId!,
    destAccountId: dest.increaseAccountId!,
  };
}

// ── Return validators ────────────────────────────────────────────────────────

const recordResult = v.object({
  outflowId: v.id("transactions"),
  inflowId: v.id("transactions"),
  amountCents: v.number(),
  transferGroupId: v.string(),
});

const initiateResult = v.object({
  outflowId: v.id("transactions"),
  inflowId: v.id("transactions"),
  amountCents: v.number(),
  transferGroupId: v.string(),
  increaseTransferId: v.string(),
});

// ── WP-4.1 · The skim (chapter → central City Launch Fund) ───────────────────

const skimArgs = {
  chapterId: v.id("chapters"),
  year: v.number(),
  month: v.number(),
  // Provide EXACTLY ONE: the month's backer revenue (→ 15%, integer-rounded) or
  // the already-computed skim amount.
  monthlyBackerRevenueCents: v.optional(v.number()),
  amountCents: v.optional(v.number()),
  note: v.optional(v.string()),
};

/**
 * Record a monthly skim that moved OUTSIDE the app (central bookkeeper+). Books
 * the ledger pair (chapter outflow → central inflow). No money moves here — this
 * is the truth-recording path when the owner moved the money in the Increase
 * dashboard.
 */
export const recordSkimTransfer = mutation({
  args: skimArgs,
  returns: recordResult,
  handler: async (ctx, args) => {
    const home = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireCentralFinanceRole(ctx, home, "bookkeeper");
    const userId = (await requireUserId(ctx)) as Id<"users">;
    assertValidMonth(args.month);
    await loadRealChapter(ctx, args.chapterId);
    const amountCents = resolveSkimAmount(args);
    const transferGroupId = skimTransferGroupId(
      args.chapterId,
      args.year,
      args.month,
    );
    const pair = await recordTransferPair(ctx, {
      sourceScope: args.chapterId,
      destScope: CENTRAL,
      amountCents,
      source: "skim",
      transferGroupId,
      postedAt: skimPostedAt(args.year, args.month),
      note: args.note,
      userId,
    });
    return { ...pair, amountCents, transferGroupId };
  },
});

/** Internal: gate + resolve the skim amount + the two live accounts, or throw
 *  (NOT_CONFIGURED / ALREADY_RECORDED). Runs BEFORE any network call. */
export const prepareSkimMovement = internalMutation({
  args: skimArgs,
  returns: v.object({
    sourceAccountId: v.string(),
    destAccountId: v.string(),
    amountCents: v.number(),
    transferGroupId: v.string(),
  }),
  handler: async (ctx, args) => {
    const home = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireCentralFinanceRole(ctx, home, "bookkeeper");
    assertValidMonth(args.month);
    await loadRealChapter(ctx, args.chapterId);
    const amountCents = resolveSkimAmount(args);
    const transferGroupId = skimTransferGroupId(
      args.chapterId,
      args.year,
      args.month,
    );
    const existing = await transferPairLegs(ctx, transferGroupId);
    if (existing.length > 0) {
      throw new ConvexError({
        code: "ALREADY_RECORDED",
        message: "This month's skim has already been recorded.",
      });
    }
    const { sourceAccountId, destAccountId } = await resolveLiveAccounts(
      ctx,
      args.chapterId,
      CENTRAL,
    );
    return { sourceAccountId, destAccountId, amountCents, transferGroupId };
  },
});

/** Internal: record the skim pair once Increase confirms the real transfer. */
export const recordSkimPairFromIncrease = internalMutation({
  args: {
    chapterId: v.id("chapters"),
    year: v.number(),
    month: v.number(),
    amountCents: v.number(),
    increaseTransferId: v.string(),
    note: v.optional(v.string()),
  },
  returns: recordResult,
  handler: async (ctx, args) => {
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const transferGroupId = skimTransferGroupId(
      args.chapterId,
      args.year,
      args.month,
    );
    const pair = await recordTransferPair(ctx, {
      sourceScope: args.chapterId,
      destScope: CENTRAL,
      amountCents: args.amountCents,
      source: "skim",
      transferGroupId,
      postedAt: skimPostedAt(args.year, args.month),
      note: args.note,
      increaseTransferId: args.increaseTransferId,
      userId,
    });
    return { ...pair, amountCents: args.amountCents, transferGroupId };
  },
});

/**
 * Initiate the REAL monthly skim over Increase (central bookkeeper+). Human-run
 * only — no cron. Degrades to `NOT_CONFIGURED` (use `recordSkimTransfer`) when
 * the accounts aren't both live or the API key is unset, WITHOUT touching the
 * network. On success, records the ledger pair stamped with the Increase id.
 */
export const initiateSkimTransfer = action({
  args: skimArgs,
  returns: initiateResult,
  handler: async (ctx, args): Promise<typeof initiateResult.type> => {
    const prep = await ctx.runMutation(
      internal.transfers.prepareSkimMovement,
      args,
    );
    const { key, base } = increaseEnvForObjectId(prep.sourceAccountId);
    if (!key) {
      throw new ConvexError({
        code: "NOT_CONFIGURED",
        message:
          "The Increase API key for this environment isn't set — record the skim manually instead.",
      });
    }
    const transfer = await postAccountTransfer(
      key,
      base,
      {
        account_id: prep.sourceAccountId,
        destination_account_id: prep.destAccountId,
        amount: prep.amountCents,
        description: `City Launch Fund skim ${args.year}-${String(args.month).padStart(2, "0")}`,
      },
      prep.transferGroupId,
    );
    assertTransferSettled(transfer, "This month's skim transfer");
    const rec = await recordAfterTransferOrExplain(transfer, () =>
      ctx.runMutation(internal.transfers.recordSkimPairFromIncrease, {
        chapterId: args.chapterId,
        year: args.year,
        month: args.month,
        amountCents: prep.amountCents,
        increaseTransferId: transfer.id,
        note: args.note,
      }),
    );
    return { ...rec, increaseTransferId: transfer.id };
  },
});

// ── WP-4.2 · Launch grants (central → new chapter, one-time) ─────────────────

const launchArgs = {
  chapterId: v.id("chapters"),
  // Defaults to the launch template total; an explicit override is allowed
  // (e.g. a partial grant). The stamped budget always reflects the template.
  amountCents: v.optional(v.number()),
  // The budget period the stamped launch budgets bucket into; defaults to the
  // current year.
  year: v.optional(v.number()),
  note: v.optional(v.string()),
};

const launchResult = v.object({
  outflowId: v.id("transactions"),
  inflowId: v.id("transactions"),
  amountCents: v.number(),
  transferGroupId: v.string(),
  budgetIds: v.array(v.id("budgets")),
});

const launchInitiateResult = v.object({
  outflowId: v.id("transactions"),
  inflowId: v.id("transactions"),
  amountCents: v.number(),
  transferGroupId: v.string(),
  budgetIds: v.array(v.id("budgets")),
  increaseTransferId: v.string(),
});

function resolveLaunchAmount(amountCents?: number): number {
  if (amountCents == null) return launchTemplateTotalCents();
  assertPositiveCents(amountCents, "Launch grant amount");
  return amountCents;
}

/**
 * Record a launch grant that moved OUTSIDE the app (central ED/FM) AND stamp the
 * playbook launch budget on the receiving chapter. Books the ledger pair
 * (central outflow → chapter inflow) + one `one_time` budget per nonzero
 * template line, atomically. Once-per-chapter (the `launch-<chapter>` group id).
 */
export const recordLaunchGrant = mutation({
  args: launchArgs,
  returns: launchResult,
  handler: async (ctx, args) => {
    await requireCentralEdOrFm(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    await loadRealChapter(ctx, args.chapterId);
    const amountCents = resolveLaunchAmount(args.amountCents);
    const year = args.year ?? easternParts(Date.now()).year;
    const transferGroupId = launchTransferGroupId(args.chapterId);
    const pair = await recordTransferPair(ctx, {
      sourceScope: CENTRAL,
      destScope: args.chapterId,
      amountCents,
      source: "launch_grant",
      transferGroupId,
      postedAt: Date.now(),
      note: args.note,
      userId,
    });
    const budgetIds = await stampLaunchBudget(ctx, args.chapterId, year, userId);
    return { ...pair, amountCents, transferGroupId, budgetIds };
  },
});

/** Internal: gate + resolve the launch amount + the two live accounts, or throw. */
export const prepareLaunchMovement = internalMutation({
  args: launchArgs,
  returns: v.object({
    sourceAccountId: v.string(),
    destAccountId: v.string(),
    amountCents: v.number(),
    transferGroupId: v.string(),
    year: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireCentralEdOrFm(ctx);
    await loadRealChapter(ctx, args.chapterId);
    const amountCents = resolveLaunchAmount(args.amountCents);
    const year = args.year ?? easternParts(Date.now()).year;
    const transferGroupId = launchTransferGroupId(args.chapterId);
    const existing = await transferPairLegs(ctx, transferGroupId);
    if (existing.length > 0) {
      throw new ConvexError({
        code: "ALREADY_RECORDED",
        message: "This chapter has already been launch-granted.",
      });
    }
    const { sourceAccountId, destAccountId } = await resolveLiveAccounts(
      ctx,
      CENTRAL,
      args.chapterId,
    );
    return { sourceAccountId, destAccountId, amountCents, transferGroupId, year };
  },
});

/** Internal: record the launch pair + stamp the budget once Increase confirms. */
export const recordLaunchFromIncrease = internalMutation({
  args: {
    chapterId: v.id("chapters"),
    amountCents: v.number(),
    year: v.number(),
    increaseTransferId: v.string(),
    note: v.optional(v.string()),
  },
  returns: launchResult,
  handler: async (ctx, args) => {
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const transferGroupId = launchTransferGroupId(args.chapterId);
    const pair = await recordTransferPair(ctx, {
      sourceScope: CENTRAL,
      destScope: args.chapterId,
      amountCents: args.amountCents,
      source: "launch_grant",
      transferGroupId,
      postedAt: Date.now(),
      note: args.note,
      increaseTransferId: args.increaseTransferId,
      userId,
    });
    const budgetIds = await stampLaunchBudget(
      ctx,
      args.chapterId,
      args.year,
      userId,
    );
    return { ...pair, amountCents: args.amountCents, transferGroupId, budgetIds };
  },
});

/**
 * Initiate the REAL launch grant over Increase (central ED/FM). Human-run only.
 * Degrades to `NOT_CONFIGURED` (use `recordLaunchGrant`) without touching the
 * network when the accounts aren't both live or the key is unset. On success,
 * records the ledger pair + stamps the launch budget, stamped with the id.
 */
export const initiateLaunchGrant = action({
  args: launchArgs,
  returns: launchInitiateResult,
  handler: async (ctx, args): Promise<typeof launchInitiateResult.type> => {
    const prep = await ctx.runMutation(
      internal.transfers.prepareLaunchMovement,
      args,
    );
    const { key, base } = increaseEnvForObjectId(prep.sourceAccountId);
    if (!key) {
      throw new ConvexError({
        code: "NOT_CONFIGURED",
        message:
          "The Increase API key for this environment isn't set — record the launch grant manually instead.",
      });
    }
    const transfer = await postAccountTransfer(
      key,
      base,
      {
        account_id: prep.sourceAccountId,
        destination_account_id: prep.destAccountId,
        amount: prep.amountCents,
        description: "City Launch grant",
      },
      prep.transferGroupId,
    );
    assertTransferSettled(transfer, "This launch grant transfer");
    const rec = await recordAfterTransferOrExplain(transfer, () =>
      ctx.runMutation(internal.transfers.recordLaunchFromIncrease, {
        chapterId: args.chapterId,
        amountCents: prep.amountCents,
        year: prep.year,
        increaseTransferId: transfer.id,
        note: args.note,
      }),
    );
    return { ...rec, increaseTransferId: transfer.id };
  },
});

// ── WP-4.5 · Settlements (central ↔ chapter, monthly, either direction) ──────

/** Which way a settlement moves money. Unlike the skim (always chapter→central)
 *  or a launch grant (always central→chapter), a settlement can run EITHER
 *  way — it true-ups whichever net imbalance `interScopeBalances` computes for
 *  that chapter that month. */
const SETTLEMENT_DIRECTIONS = ["central_to_chapter", "chapter_to_central"] as const;
type SettlementDirection = (typeof SETTLEMENT_DIRECTIONS)[number];
const settlementDirectionValidator = v.union(
  ...SETTLEMENT_DIRECTIONS.map((d) => v.literal(d)),
);

const settlementArgs = {
  chapterId: v.id("chapters"),
  year: v.number(),
  month: v.number(),
  amountCents: v.number(),
  direction: settlementDirectionValidator,
  note: v.optional(v.string()),
};

/** The source/dest scopes for a settlement pair, by direction — mirrors the
 *  skim (`chapterId → CENTRAL`) and launch grant (`CENTRAL → chapterId`)
 *  shapes, just with the direction as an explicit arg instead of fixed. */
function settlementScopes(
  chapterId: Id<"chapters">,
  direction: SettlementDirection,
): { sourceScope: FinanceScope; destScope: FinanceScope } {
  return direction === "central_to_chapter"
    ? { sourceScope: CENTRAL, destScope: chapterId }
    : { sourceScope: chapterId, destScope: CENTRAL };
}

/**
 * Record a settlement that moved OUTSIDE the app (central bookkeeper+) — the
 * monthly true-up of the net cash imbalance `interScopeBalances` computes.
 * Books the ledger pair for the given (chapter, year, month); idempotent on
 * the deterministic group id (one settlement per chapter per month, either
 * direction — a second call for the same month is REJECTED, matching the
 * skim/launch-grant convention).
 */
export const recordSettlementTransfer = mutation({
  args: settlementArgs,
  returns: recordResult,
  handler: async (ctx, args) => {
    const home = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireCentralFinanceRole(ctx, home, "bookkeeper");
    const userId = (await requireUserId(ctx)) as Id<"users">;
    assertValidMonth(args.month);
    assertPositiveCents(args.amountCents, "Settlement amount");
    await loadRealChapter(ctx, args.chapterId);
    const transferGroupId = settlementTransferGroupId(
      args.chapterId,
      args.year,
      args.month,
    );
    const { sourceScope, destScope } = settlementScopes(
      args.chapterId,
      args.direction,
    );
    const pair = await recordTransferPair(ctx, {
      sourceScope,
      destScope,
      amountCents: args.amountCents,
      source: "settlement",
      transferGroupId,
      postedAt: skimPostedAt(args.year, args.month),
      note: args.note,
      transferDirection: args.direction,
      userId,
    });
    return { ...pair, amountCents: args.amountCents, transferGroupId };
  },
});

/** Internal: gate + resolve the two live accounts for a settlement, or throw
 *  (NOT_CONFIGURED / ALREADY_RECORDED). Runs BEFORE any network call. */
export const prepareSettlementMovement = internalMutation({
  args: settlementArgs,
  returns: v.object({
    sourceAccountId: v.string(),
    destAccountId: v.string(),
    amountCents: v.number(),
    transferGroupId: v.string(),
  }),
  handler: async (ctx, args) => {
    const home = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireCentralFinanceRole(ctx, home, "bookkeeper");
    assertValidMonth(args.month);
    assertPositiveCents(args.amountCents, "Settlement amount");
    await loadRealChapter(ctx, args.chapterId);
    const transferGroupId = settlementTransferGroupId(
      args.chapterId,
      args.year,
      args.month,
    );
    const existing = await transferPairLegs(ctx, transferGroupId);
    if (existing.length > 0) {
      throw new ConvexError({
        code: "ALREADY_RECORDED",
        message: "This chapter's settlement for this month has already been recorded.",
      });
    }
    const { sourceScope, destScope } = settlementScopes(
      args.chapterId,
      args.direction,
    );
    const { sourceAccountId, destAccountId } = await resolveLiveAccounts(
      ctx,
      sourceScope,
      destScope,
    );
    return {
      sourceAccountId,
      destAccountId,
      amountCents: args.amountCents,
      transferGroupId,
    };
  },
});

/** Internal: record the settlement pair once Increase confirms the real transfer. */
export const recordSettlementPairFromIncrease = internalMutation({
  args: {
    chapterId: v.id("chapters"),
    year: v.number(),
    month: v.number(),
    amountCents: v.number(),
    direction: settlementDirectionValidator,
    increaseTransferId: v.string(),
    note: v.optional(v.string()),
  },
  returns: recordResult,
  handler: async (ctx, args) => {
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const transferGroupId = settlementTransferGroupId(
      args.chapterId,
      args.year,
      args.month,
    );
    const { sourceScope, destScope } = settlementScopes(
      args.chapterId,
      args.direction,
    );
    const pair = await recordTransferPair(ctx, {
      sourceScope,
      destScope,
      amountCents: args.amountCents,
      source: "settlement",
      transferGroupId,
      postedAt: skimPostedAt(args.year, args.month),
      note: args.note,
      increaseTransferId: args.increaseTransferId,
      transferDirection: args.direction,
      userId,
    });
    return { ...pair, amountCents: args.amountCents, transferGroupId };
  },
});

/**
 * Initiate a REAL settlement over Increase (central bookkeeper+) — human-run
 * only, gated identically to `initiateSkimTransfer`/`initiateLaunchGrant`:
 * degrades to `NOT_CONFIGURED` (use `recordSettlementTransfer`) without
 * touching the network when the two accounts aren't both live in this mode or
 * the API key is unset.
 */
export const initiateSettlementTransfer = action({
  args: settlementArgs,
  returns: initiateResult,
  handler: async (ctx, args): Promise<typeof initiateResult.type> => {
    const prep = await ctx.runMutation(
      internal.transfers.prepareSettlementMovement,
      args,
    );
    const { key, base } = increaseEnvForObjectId(prep.sourceAccountId);
    if (!key) {
      throw new ConvexError({
        code: "NOT_CONFIGURED",
        message:
          "The Increase API key for this environment isn't set — record the settlement manually instead.",
      });
    }
    const transfer = await postAccountTransfer(
      key,
      base,
      {
        account_id: prep.sourceAccountId,
        destination_account_id: prep.destAccountId,
        amount: prep.amountCents,
        description: `Inter-scope settlement ${args.year}-${String(args.month).padStart(2, "0")}`,
      },
      prep.transferGroupId,
    );
    assertTransferSettled(transfer, "This settlement transfer");
    const rec = await recordAfterTransferOrExplain(transfer, () =>
      ctx.runMutation(internal.transfers.recordSettlementPairFromIncrease, {
        chapterId: args.chapterId,
        year: args.year,
        month: args.month,
        amountCents: prep.amountCents,
        direction: args.direction,
        increaseTransferId: transfer.id,
        note: args.note,
      }),
    );
    return { ...rec, increaseTransferId: transfer.id };
  },
});

// ── WP-4.5 · Inter-scope balances (the settlement's input) ────────────────────

const interScopeBalanceRow = v.object({
  chapterId: v.id("chapters"),
  chapterName: v.string(),
  // Ledger-derived, ALL-TIME net owed between central and this chapter, net
  // of every settlement already recorded. Positive = CENTRAL owes the
  // chapter; negative = the CHAPTER owes central (display `Math.abs`).
  netCents: v.number(),
  // Same computation, narrowed to the given {year, month} only (not
  // cumulative) — "how much moved this month," for the "settle alongside the
  // skim" monthly workflow.
  periodNetCents: v.number(),
});

/**
 * WP-4.5: the net cash imbalance between central and each chapter, created by
 * cross-scope BUDGET attribution on account-scoped CARDS. Owner policy: "Your
 * card determines whose account paid; reconcile determines whose budget it
 * was; Central settles the difference monthly alongside the skim."
 *
 * Two directions, summed all-time then netted against recorded settlements:
 *
 *  (a) CENTRAL OWES CHAPTER: a txn OWNED by a real chapter (its card/account
 *      paid) whose `budgetId` resolves to a CENTRAL budget — the chapter
 *      fronted money for a central line item. This is the common case and
 *      mirrors `dashboardChapter`'s existing `centralLinkedCents` split
 *      (WP-0.1) — same rule, summed all-time instead of one dashboard period.
 *
 *  (b) CHAPTER OWES CENTRAL: a txn OWNED by central whose `budgetId` resolves
 *      to a CHAPTER budget — central fronted money for a chapter's line item.
 *      VERIFIED NOT ATTRIBUTABLE TODAY: `categorizeTransaction` and
 *      `createManualTransaction`'s central path both call
 *      `requireInCallerChapter(ctx, CENTRAL, "budgets", budgetId, ..., {
 *      allowCentral: true })`, which for a central-scope caller only ever
 *      admits a budget whose OWN `chapterId` is also `CENTRAL` — a chapter
 *      budget is rejected `NOT_FOUND` (#151's rule; see
 *      `transfers.test.ts`'s "central txn cannot attribute to a chapter
 *      budget" case). So this term is ALWAYS 0 through every write path in
 *      the app today. It's still computed generically here (not hardcoded)
 *      rather than assumed, so the balance stays correct — and this comment
 *      stays honest — if that restriction is ever relaxed, and so a stray
 *      legacy/migration row is still caught rather than silently dropped.
 *
 * SETTLEMENTS ALREADY RECORDED (`source:"settlement"` transfer legs) are
 * netted out. Both legs of a settlement pair share `flow:"transfer"` (like
 * every transfer leg — excluded from spend), so the pair's `transferDirection`
 * field is what distinguishes it: `"central_to_chapter"` means central paid
 * THIS chapter (pays down (a)); `"chapter_to_central"` means this chapter
 * paid central (pays down (b)). `netCents = (a - settled_a) - (b - settled_b)`.
 *
 * CONSENT SEMANTICS (owner-decided): upward attribution — a chapter fronting
 * money for central — stays VISIBLE-BUT-UNSETTLED here until central actually
 * records a settlement. There is no auto-settle, no accrual write, no
 * separate balances table: this query is a pure ledger read, recomputed live
 * from `transactions` + recorded `settlement` legs every call.
 *
 * Mode-filtered like the City Launch Fund position (#163's IMPORTANT-1 fix):
 * the underlying card/ACH spend is filtered via `txnMatchesMode`, and a
 * settlement leg's REAL-movement `externalId` via `matchesMode` — a manual
 * leg (no `externalId`) is env-neutral and counts in both modes.
 *
 * Gate: central VIEWER+ reach (a read, not a write) — a chapter manager with
 * no central grant is FORBIDDEN.
 *
 * The per-chapter row-computing logic below is factored into
 * `loadInterScopeContext` / `loadChapterOwesCentralRows` / `chapterInterScopeRows`
 * so `interScopeBalanceContributors` (dashboard-drilldown work) can show the
 * exact transactions/settlement legs behind a chapter's `netCents` without
 * re-deriving the same predicates — see those helpers' own doc comments.
 */
export const interScopeBalances = query({
  args: { year: v.optional(v.number()), month: v.optional(v.number()) },
  returns: v.array(interScopeBalanceRow),
  handler: async (ctx, args) => {
    const home = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireCentralFinanceRole(ctx, home, "viewer");
    const now = easternParts(Date.now());
    const year = args.year ?? now.year;
    const month = args.month ?? now.month;
    const sandboxMode = await readSandbox(ctx);

    const { centralBudgetIds, chapters } = await loadInterScopeContext(ctx);
    const chapterOwesCentralRowsByChapter = await loadChapterOwesCentralRows(
      ctx,
      centralBudgetIds,
      sandboxMode,
    );

    const rows: (typeof interScopeBalanceRow.type)[] = [];
    for (const chapter of chapters) {
      const chapterTxns = await ctx.db
        .query("transactions")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapter._id))
        .take(ROLLUP_SCAN_LIMIT);
      if (chapterTxns.length === ROLLUP_SCAN_LIMIT) {
        console.warn(
          `[transfers] interScopeBalances hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) reading transactions for chapter ${chapter._id}; balance truncated.`,
        );
      }
      const grouped = chapterInterScopeRows(
        chapterTxns,
        centralBudgetIds,
        chapterOwesCentralRowsByChapter.get(chapter._id) ?? [],
        sandboxMode,
      );

      const netCents =
        sumAllCents(grouped.centralOwesChapterRows) -
        sumAllCents(grouped.settledCentralToChapterRows) -
        (sumAllCents(grouped.chapterOwesCentralRows) -
          sumAllCents(grouped.settledChapterToCentralRows));
      const periodNetCents =
        sumInPeriodCents(grouped.centralOwesChapterRows, year, month) -
        sumInPeriodCents(grouped.settledCentralToChapterRows, year, month) -
        (sumInPeriodCents(grouped.chapterOwesCentralRows, year, month) -
          sumInPeriodCents(grouped.settledChapterToCentralRows, year, month));

      rows.push({
        chapterId: chapter._id,
        chapterName: chapter.name,
        netCents,
        periodNetCents,
      });
    }
    return rows;
  },
});

// ── WP-dashboard-drill: `interScopeBalances`' shared row-computing helpers ──

/** Direction (a)'s target set (every CENTRAL budget, any year) + every ACTIVE
 *  chapter (shadow/pre-launch territory rows excluded — this also keeps skim
 *  automation off shadow chapters, since `interScopeBalances`' rows drive it;
 *  see `lib/chapters.ts#listActiveChapters`) — the context both
 *  `interScopeBalances` and `interScopeBalanceContributors` need before they
 *  can compute anything. Inlines the same `isActive !== false` filter
 *  `listActiveChapters` applies (rather than calling it directly) because the
 *  truncation warning needs the RAW pre-filter scan length. */
async function loadInterScopeContext(
  ctx: QueryCtx,
): Promise<{ centralBudgetIds: Set<Id<"budgets">>; chapters: Doc<"chapters">[] }> {
  const centralBudgetDocs = await ctx.db
    .query("budgets")
    .withIndex("by_chapter", (q) => q.eq("chapterId", CENTRAL))
    .take(ROLLUP_SCAN_LIMIT);
  if (centralBudgetDocs.length === ROLLUP_SCAN_LIMIT) {
    console.warn(
      `[transfers] interScopeBalances hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) reading central budgets; direction (a) target set truncated.`,
    );
  }
  const rawChapters = await ctx.db.query("chapters").take(ROLLUP_SCAN_LIMIT);
  if (rawChapters.length === ROLLUP_SCAN_LIMIT) {
    console.warn(
      `[transfers] interScopeBalances hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) reading chapters; result rows truncated.`,
    );
  }
  const chapters = rawChapters.filter((c) => c.isActive !== false);
  return { centralBudgetIds: new Set(centralBudgetDocs.map((b) => b._id)), chapters };
}

/** Direction (b)'s raw rows (see `interScopeBalances`' doc comment — verified
 *  unattributable through every write path today, computed generically
 *  anyway), grouped by the chapter whose budget absorbed the spend. Read once
 *  (central-owned txns are low-volume, like the City Launch Fund scan);
 *  mode-filtered inline via `txnMatchesMode`. */
async function loadChapterOwesCentralRows(
  ctx: QueryCtx,
  centralBudgetIds: Set<Id<"budgets">>,
  sandboxMode: boolean,
): Promise<Map<Id<"chapters">, Doc<"transactions">[]>> {
  const centralTxns = await ctx.db
    .query("transactions")
    .withIndex("by_chapter", (q) => q.eq("chapterId", CENTRAL))
    .take(ROLLUP_SCAN_LIMIT);
  if (centralTxns.length === ROLLUP_SCAN_LIMIT) {
    console.warn(
      `[transfers] interScopeBalances hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) reading central-owned transactions; direction (b) truncated.`,
    );
  }
  const budgetCache = new Map<Id<"budgets">, Doc<"budgets"> | null>();
  async function resolveBudget(id: Id<"budgets">): Promise<Doc<"budgets"> | null> {
    if (!budgetCache.has(id)) budgetCache.set(id, await ctx.db.get(id));
    return budgetCache.get(id) ?? null;
  }
  const byChapter = new Map<Id<"chapters">, Doc<"transactions">[]>();
  for (const tr of centralTxns) {
    if (!isSpend(tr) || tr.budgetId == null || centralBudgetIds.has(tr.budgetId)) continue;
    if (!txnMatchesMode(tr, sandboxMode)) continue;
    const linked = await resolveBudget(tr.budgetId);
    if (!linked || linked.chapterId === CENTRAL) continue; // dangling, or (shouldn't happen) central
    const chId = linked.chapterId as Id<"chapters">;
    const rows = byChapter.get(chId) ?? [];
    rows.push(tr);
    byChapter.set(chId, rows);
  }
  return byChapter;
}

/**
 * ONE chapter's four row groups behind its `interScopeBalances` net figures:
 * direction (a) rows (this chapter's spend linked to a central budget),
 * direction (b) rows (passed in, pre-scanned by `loadChapterOwesCentralRows`),
 * and the two settlement-leg directions already recorded. Every group is
 * mode-filtered. `interScopeBalances` sums each group (all-time, and
 * `inPeriod`-filtered for the period figure); `interScopeBalanceContributors`
 * returns them directly as the "why" behind a chapter's balance.
 */
function chapterInterScopeRows(
  chapterTxns: Doc<"transactions">[],
  centralBudgetIds: Set<Id<"budgets">>,
  chapterOwesCentralRows: Doc<"transactions">[],
  sandboxMode: boolean,
): {
  centralOwesChapterRows: Doc<"transactions">[];
  chapterOwesCentralRows: Doc<"transactions">[];
  settledCentralToChapterRows: Doc<"transactions">[];
  settledChapterToCentralRows: Doc<"transactions">[];
} {
  const modeFiltered = chapterTxns.filter((tr) => txnMatchesMode(tr, sandboxMode));

  const centralOwesChapterRows = modeFiltered.filter(
    (tr) => isSpend(tr) && tr.budgetId != null && centralBudgetIds.has(tr.budgetId),
  );

  const settlementRows = modeFiltered.filter(
    (tr) => tr.source === "settlement" && matchesMode(tr.externalId ?? null, sandboxMode),
  );
  const settledCentralToChapterRows = settlementRows.filter(
    (tr) => tr.transferDirection === "central_to_chapter",
  );
  const settledChapterToCentralRows = settlementRows.filter(
    (tr) => tr.transferDirection === "chapter_to_central",
  );

  return {
    centralOwesChapterRows,
    chapterOwesCentralRows,
    settledCentralToChapterRows,
    settledChapterToCentralRows,
  };
}

function sumAllCents(rows: Doc<"transactions">[]): number {
  return rows.reduce((s, tr) => s + tr.amountCents, 0);
}

function sumInPeriodCents(rows: Doc<"transactions">[], year: number, month: number): number {
  return rows.reduce((s, tr) => (inPeriod(tr.postedAt, year, month) ? s + tr.amountCents : s), 0);
}

/** `YYYY-MM-DD` in America/New_York — the same one-liner as
 *  `finances.ts#easternDateStr` (unexported there); duplicated here rather
 *  than importing across an off-limits file for a single date formatter. */
function easternDateStrLocal(ts: number): string {
  return new Date(ts).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

type InterScopeContributorDirection =
  | "central_owes_chapter"
  | "chapter_owes_central"
  | "settlement_central_to_chapter"
  | "settlement_chapter_to_central";

const interScopeContributorRow = v.object({
  id: v.id("transactions"),
  date: v.string(),
  amountCents: v.number(),
  description: v.union(v.string(), v.null()),
  merchantName: v.union(v.string(), v.null()),
  direction: v.union(
    v.literal("central_owes_chapter"),
    v.literal("chapter_owes_central"),
    v.literal("settlement_central_to_chapter"),
    v.literal("settlement_chapter_to_central"),
  ),
});

/**
 * WP-dashboard-drill: the raw transactions/settlement legs composing ONE
 * chapter's `interScopeBalances` row — "why does Central owe NY $160.20?"
 * Reuses `chapterInterScopeRows`, the EXACT same predicates `interScopeBalances`
 * itself sums, so the signed sum of these rows' `amountCents` (central_owes -
 * settlement_central_to_chapter - (chapter_owes - settlement_chapter_to_central))
 * always equals that query's `netCents` for the same chapter. ALL-TIME (no
 * year/month arg) — `netCents` itself is all-time, not `periodNetCents`.
 *
 * Gate: central VIEWER+ reach, same as `interScopeBalances`.
 */
export const interScopeBalanceContributors = query({
  args: { chapterId: v.id("chapters") },
  returns: v.array(interScopeContributorRow),
  handler: async (ctx, { chapterId }) => {
    const home = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireCentralFinanceRole(ctx, home, "viewer");
    const sandboxMode = await readSandbox(ctx);

    const { centralBudgetIds } = await loadInterScopeContext(ctx);
    const chapterOwesCentralRowsByChapter = await loadChapterOwesCentralRows(
      ctx,
      centralBudgetIds,
      sandboxMode,
    );
    const chapterTxns = await ctx.db
      .query("transactions")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(ROLLUP_SCAN_LIMIT);

    const grouped = chapterInterScopeRows(
      chapterTxns,
      centralBudgetIds,
      chapterOwesCentralRowsByChapter.get(chapterId) ?? [],
      sandboxMode,
    );

    const tagged: Array<Doc<"transactions"> & { direction: InterScopeContributorDirection }> = [
      ...grouped.centralOwesChapterRows.map((tr) => ({ ...tr, direction: "central_owes_chapter" as const })),
      ...grouped.chapterOwesCentralRows.map((tr) => ({ ...tr, direction: "chapter_owes_central" as const })),
      ...grouped.settledCentralToChapterRows.map((tr) => ({
        ...tr,
        direction: "settlement_central_to_chapter" as const,
      })),
      ...grouped.settledChapterToCentralRows.map((tr) => ({
        ...tr,
        direction: "settlement_chapter_to_central" as const,
      })),
    ];
    tagged.sort((a, b) => b.postedAt - a.postedAt);

    return tagged.map((tr) => ({
      id: tr._id,
      date: easternDateStrLocal(tr.postedAt),
      amountCents: tr.amountCents,
      description: tr.description ?? null,
      merchantName: tr.merchantName ?? null,
      direction: tr.direction,
    }));
  },
});

// ── UI readiness (manual vs real) ─────────────────────────────────────────────

/**
 * Whether a real Increase movement is possible for a chapter's transfers right
 * now: both the chapter's AND central's accounts are `active` in the current
 * mode with an Increase account id. The dashboard shows the "initiate real
 * transfer" affordance only when true (mirroring how the reimbursement UI shows
 * the manual-vs-ACH choice). Central reach required to read it.
 */
export const transferReadiness = query({
  args: { chapterId: v.id("chapters") },
  returns: v.object({ canMoveReal: v.boolean() }),
  handler: async (ctx, { chapterId }) => {
    const home = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireCentralFinanceRole(ctx, home, "bookkeeper");
    const sandboxMode = await readSandbox(ctx);
    const chapterAccount = await getChapterAccountForMode(ctx, chapterId, sandboxMode);
    const centralAccount = await getChapterAccountForMode(ctx, CENTRAL, sandboxMode);
    const ready = (a: Doc<"increaseAccounts"> | null): boolean =>
      a != null && a.onboardingStatus === "active" && !!a.increaseAccountId;
    return { canMoveReal: ready(chapterAccount) && ready(centralAccount) };
  },
});
