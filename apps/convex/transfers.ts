/**
 * The City Launch Fund money flows — WP-4.1 (the skim) + WP-4.2 (launch grants).
 *
 * The playbook moves money BOTH ways between a chapter and central (PRD §0.1):
 *  - UP:   the monthly ~15% SKIM, chapter → central City Launch Fund.
 *  - DOWN: a one-time LAUNCH GRANT, central → a new chapter (equipment +
 *          training trip), which ALSO stamps a launch budget on that chapter.
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
  easternParts,
  formatCents,
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
  source: Extract<TransactionSource, "skim" | "launch_grant">;
  transferGroupId: string;
  postedAt: number;
  note?: string;
  /** The Increase account-transfer id when this pair records a REAL movement;
   *  absent for a manually-recorded (money-moved-outside) pair. */
  increaseTransferId?: string;
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
    const rec = await ctx.runMutation(
      internal.transfers.recordSkimPairFromIncrease,
      {
        chapterId: args.chapterId,
        year: args.year,
        month: args.month,
        amountCents: prep.amountCents,
        increaseTransferId: transfer.id,
        note: args.note,
      },
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
    const rec = await ctx.runMutation(
      internal.transfers.recordLaunchFromIncrease,
      {
        chapterId: args.chapterId,
        amountCents: prep.amountCents,
        year: prep.year,
        increaseTransferId: transfer.id,
        note: args.note,
      },
    );
    return { ...rec, increaseTransferId: transfer.id };
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
