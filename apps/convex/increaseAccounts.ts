/**
 * Increase account ROWS — the `increaseAccounts` table's own lifecycle: the
 * find-or-create half of provisioning (the network half lives in
 * `increaseProvision.ts`), the viewer/status queries, removing a stale test
 * account, and the environment-field backfill. Part of the `increase*` module
 * family (see `increase.ts`'s header for the module map).
 *
 * INVARIANTS (shared across the family):
 *  - Every table is chapter-scoped; every client id is verified in the caller's
 *    chapter before use.
 *  - Degrade to a logged no-op (never throw) when the environment isn't wired.
 *  - All failures throw `ConvexError` (never a plain `Error`).
 */
import { mutation, query, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { isSandboxObjectId } from "@events-os/shared";
import { readSandbox } from "./financeSettings";
import { requireChapterId, getChapterIdOrNull } from "./lib/context";
import {
  requireFinanceRole,
  requireFinanceManager,
  getChapterAccountForMode,
  requireCentralEdOrFm,
  type FinanceScope,
} from "./lib/finance";
import {
  onboardingValidator,
  financeScopeValidator,
  increaseAccountSummaryValidator,
  toAccountSummary,
  type IncreaseAccountSummary,
  type BeginProvisionResult,
} from "./lib/increaseShapes";

/** The org level's own Increase account (WP-1.2) — where the City Launch Fund
 *  lives (feeds the future skim destination). Named for the org, not a
 *  generic "Central", so it reads clearly next to chapter account names in
 *  the match-before-create list. */
export const CENTRAL_ACCOUNT_NAME = "Public Worship — Central";

/**
 * Find-or-create the `increaseAccounts` row for a SCOPE (a real chapter, or
 * `"central"` — WP-1.2). Returns the existing account when it's already active
 * (idempotent), else the row to provision + the name to open the Increase
 * Account under (a real chapter's name, or `CENTRAL_ACCOUNT_NAME`).
 *
 * Pure DB logic shared by BOTH authz paths: the caller-scoped `beginProvision`
 * (a manager provisioning their OWN chapter) and the ops-only
 * `beginProvisionForScope` (the WP-1.2 backfill / auto-provision-at-creation,
 * which may target ANY chapter or central — no caller-chapter membership to
 * gate on).
 */
async function doBeginProvision(
  ctx: MutationCtx,
  scope: FinanceScope,
): Promise<BeginProvisionResult> {
  // Mode-aware find-or-create: only ever look at / create the account for the
  // CURRENT environment. The other environment's row (if any) is untouched.
  const sandboxMode = await readSandbox(ctx);
  const existing = await getChapterAccountForMode(ctx, scope, sandboxMode);
  if (
    existing &&
    existing.onboardingStatus === "active" &&
    existing.increaseAccountId
  ) {
    return { kind: "existing", account: toAccountSummary(existing) };
  }

  const scopeName =
    scope === "central"
      ? CENTRAL_ACCOUNT_NAME
      : ((await ctx.db.get(scope))?.name ?? "Chapter");

  if (existing) {
    return {
      kind: "provision",
      accountId: existing._id,
      chapterId: scope,
      chapterName: scopeName,
    };
  }
  const now = Date.now();
  const accountId = await ctx.db.insert("increaseAccounts", {
    chapterId: scope,
    sandbox: sandboxMode,
    onboardingStatus: "not_started",
    createdAt: now,
    updatedAt: now,
  });
  return {
    kind: "provision",
    accountId,
    chapterId: scope,
    chapterName: scopeName,
  };
}

const beginProvisionReturns = v.union(
  v.object({
    kind: v.literal("existing"),
    account: increaseAccountSummaryValidator,
  }),
  v.object({
    kind: v.literal("provision"),
    accountId: v.id("increaseAccounts"),
    chapterId: financeScopeValidator,
    chapterName: v.string(),
  }),
);

/** Gate + find-or-create the CALLER'S OWN chapter's `increaseAccounts` row.
 *  Manager-only — the normal (non-ops) provisioning path. */
export const beginProvision = internalMutation({
  args: {},
  returns: beginProvisionReturns,
  handler: async (ctx): Promise<BeginProvisionResult> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    return doBeginProvision(ctx, chapterId);
  },
});

/**
 * Ops-only counterpart of `beginProvision`: find-or-create the
 * `increaseAccounts` row for an EXPLICIT scope (any chapter, or `"central"`),
 * with NO caller-chapter gate — this is only ever invoked by
 * `backfillChapterAccounts` / `provisionAccountForScope` (internal actions,
 * never reachable from a client).
 */
export const beginProvisionForScope = internalMutation({
  args: { scope: financeScopeValidator },
  returns: beginProvisionReturns,
  handler: async (ctx, { scope }): Promise<BeginProvisionResult> =>
    doBeginProvision(ctx, scope),
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

// ── getChapterAccount (query, viewer) ────────────────────────────────────────

/** The caller's chapter's Increase Account summary for the CURRENT mode
 *  (viewer+), or null if none has been provisioned in this environment yet. The
 *  off-mode account (e.g. a leftover sandbox account while in production) is
 *  hidden — a null return drives the "Provision account" trigger. */
export const getChapterAccount = query({
  args: {},
  returns: v.union(increaseAccountSummaryValidator, v.null()),
  handler: async (ctx): Promise<IncreaseAccountSummary | null> => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return null;
    await requireFinanceRole(ctx, chapterId, "viewer");

    const sandboxMode = await readSandbox(ctx);
    const account = await getChapterAccountForMode(ctx, chapterId, sandboxMode);
    return account ? toAccountSummary(account) : null;
  },
});

// ── listAccountsStatus (query, ED/FM only — WP-1.2) ──────────────────────────

/**
 * The read-only Increase account status list (WP-1.2): one row per scope —
 * every chapter, plus `"central"` — with its CURRENT-mode account (or `null`
 * if not yet provisioned). Backs the Accounts tab's "quiet status/audit view"
 * now that provisioning is fully automatic; there's nothing left to DO here,
 * only to see. ED/FM-only (`requireCentralEdOrFm` — tighter than the old
 * central-scope manager gate); everyone else, including chapter finance
 * managers, gets a `FORBIDDEN` `ConvexError`.
 */
export const listAccountsStatus = query({
  args: {},
  returns: v.array(
    v.object({
      scope: financeScopeValidator,
      scopeName: v.string(),
      account: v.union(increaseAccountSummaryValidator, v.null()),
    }),
  ),
  handler: async (ctx) => {
    await requireCentralEdOrFm(ctx);

    const sandboxMode = await readSandbox(ctx);
    const chapters = (await ctx.db.query("chapters").collect())
      .filter((c) => c.isActive !== false)
      .sort((a, b) => a.name.localeCompare(b.name));

    const scopes: { scope: FinanceScope; scopeName: string }[] = [
      { scope: "central", scopeName: CENTRAL_ACCOUNT_NAME },
      ...chapters.map((c) => ({ scope: c._id, scopeName: c.name })),
    ];

    const rows = [];
    for (const { scope, scopeName } of scopes) {
      const account = await getChapterAccountForMode(ctx, scope, sandboxMode);
      rows.push({
        scope,
        scopeName,
        account: account ? toAccountSummary(account) : null,
      });
    }
    return rows;
  },
});

// ── removeChapterAccount (mutation, manager) ─────────────────────────────────

/**
 * Delete the chapter's `increaseAccounts` row. Manager-only. Used to clear a
 * STALE TEST account — a `sandbox_`-prefixed account left behind after the
 * deployment was flipped from sandbox back to production mode — so the manager
 * can provision the real production account fresh (via `provisionChapterAccount`).
 *
 * SAFETY: refuses to remove a LIVE production account (active + a non-`sandbox_`
 * `increaseAccountId`) — that row maps to a real Increase Account holding the
 * chapter's money; dropping it would orphan the balance. Removing a pending row
 * (never fully provisioned) or a sandbox test row is always allowed. Idempotent:
 * a no-op (returns) when there's no row. Does NOT auto-provision a replacement.
 *
 * CASCADE: removing a sandbox/test account also deletes the chapter's leftover
 * SANDBOX child records so the chapter is clean for a fresh production
 * provision — `sandbox_`-issued `cards` (+ their `cardAuthorizations`),
 * `sandbox_` `payouts`, any `increase_*` `transactions` with a `sandbox_`
 * external/source id, AND any transfer leg (the current generic `"transfer"`
 * source, or a historical `skim`/`launch_grant`/`settlement` row — see
 * `transfers.ts`'s header comment) whose `externalId` is `sandbox_`-prefixed
 * — otherwise a sandbox-initiated transfer would keep counting toward the
 * PRODUCTION City Launch Fund position forever (`dashboardCentral`).
 * Environment-NEUTRAL records (a null-id
 * degraded card, a manual null-transfer payout, a manually-recorded transfer
 * leg with no `externalId`) are left untouched. Best-effort Increase-side card
 * cancellation is OUT OF SCOPE — this only cleans our DB (a sandbox object is
 * disposable at the vendor anyway). Idempotent.
 */
export const removeChapterAccount = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);

    // Remove the account for the CURRENT mode — the one the UI shows. The
    // off-mode account (if any) is left untouched.
    const sandboxMode = await readSandbox(ctx);
    const account = await getChapterAccountForMode(ctx, chapterId, sandboxMode);
    if (!account) return null; // nothing to remove (idempotent)

    const isLiveProductionAccount =
      account.onboardingStatus === "active" &&
      !!account.increaseAccountId &&
      !account.increaseAccountId.startsWith("sandbox_");
    if (isLiveProductionAccount) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message:
          "This is the chapter's live production account — it can't be removed here.",
      });
    }

    // Cascade: drop the chapter's leftover SANDBOX child records. Bounded scans
    // (these per-chapter tables are small); env-neutral null-id records survive.
    const CASCADE_SCAN_LIMIT = 5000;

    // 1. Sandbox cards + their authorizations.
    const cards = await ctx.db
      .query("cards")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(CASCADE_SCAN_LIMIT);
    for (const card of cards) {
      if (!isSandboxObjectId(card.increaseCardId)) continue; // keep null/prod
      const auths = await ctx.db
        .query("cardAuthorizations")
        .withIndex("by_card", (q) => q.eq("cardId", card._id))
        .take(CASCADE_SCAN_LIMIT);
      for (const a of auths) await ctx.db.delete(a._id);
      await ctx.db.delete(card._id);
    }

    // 2. Sandbox payouts (a NULL transfer id is a manual payout → NOT deleted).
    const payouts = await ctx.db
      .query("payouts")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(CASCADE_SCAN_LIMIT);
    for (const p of payouts) {
      if (isSandboxObjectId(p.increaseTransferId)) await ctx.db.delete(p._id);
    }

    // 3. Sandbox increase_* transactions — `increase_card` card charges AND
    //    `increase_ach` account activity (`increaseLedger.ts` writes both). A
    //    reimbursement/repayment/manual txn is env-neutral and left alone.
    //    ALSO sandbox transfer legs — historical `skim`/`launch_grant`/
    //    `settlement` rows AND the current generic `transfer` source. Before
    //    the 2026-07-26 collapse to one generic transfer (see
    //    `transfers.ts`'s header comment), a sandbox-initiated
    //    `initiateSkimTransfer`/`initiateLaunchGrant`/`initiateSettlementTransfer`
    //    (all deleted with that collapse — there's no more Increase
    //    auto-initiate path for a transfer, so no NEW row will ever carry a
    //    sandbox `externalId` here) stamped the leg's `externalId` with the
    //    real Increase account-transfer id (`sandbox_account_transfer_…` in
    //    sandbox), matched by prefix the same way a card/ACH row is; kept for
    //    any such row still sitting in a sandbox env from before — otherwise
    //    it would count toward the PRODUCTION City Launch Fund position
    //    forever (dashboardCentral).
    const txns = await ctx.db
      .query("transactions")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(CASCADE_SCAN_LIMIT);
    for (const t of txns) {
      const isIncreaseTxn =
        t.source === "increase_card" || t.source === "increase_ach";
      const isTransferTxn =
        t.source === "skim" ||
        t.source === "launch_grant" ||
        t.source === "settlement" ||
        t.source === "transfer";
      if (
        (isIncreaseTxn &&
          (isSandboxObjectId(t.externalId) ||
            isSandboxObjectId(t.sourceAccountId))) ||
        (isTransferTxn && isSandboxObjectId(t.externalId))
      ) {
        await ctx.db.delete(t._id);
      }
    }

    await ctx.db.delete(account._id);
    return null;
  },
});

// ── runBackfillIncreaseAccountEnv (internalMutation, CLI/CI) ──────────────────

/**
 * Backfill the `sandbox` environment field on existing `increaseAccounts` rows
 * from their `increaseAccountId` prefix (`isSandboxObjectId`) — a `sandbox_` id
 * is a sandbox account, everything else (incl. a null/pending id) is production.
 *
 * ONLY stamps LEGACY rows that predate the field (`sandbox === undefined`); rows
 * already carrying an explicit value are the source of truth and left untouched,
 * which makes this idempotent (a second run stamps nothing).
 *
 * CLI-runnable (no auth gate — an internalMutation isn't publicly callable):
 *   npx convex run increaseAccounts:runBackfillIncreaseAccountEnv
 * On prod via the workflow:
 *   gh workflow run run-convex-function.yml -f function=increaseAccounts:runBackfillIncreaseAccountEnv
 */
export const runBackfillIncreaseAccountEnv = internalMutation({
  args: {},
  returns: v.object({ scanned: v.number(), updated: v.number() }),
  handler: async (ctx): Promise<{ scanned: number; updated: number }> => {
    const rows = await ctx.db.query("increaseAccounts").collect();
    let updated = 0;
    for (const row of rows) {
      if (row.sandbox !== undefined) continue; // already stamped (source of truth)
      await ctx.db.patch(row._id, {
        sandbox: isSandboxObjectId(row.increaseAccountId),
      });
      updated += 1;
    }
    return { scanned: rows.length, updated };
  },
});
