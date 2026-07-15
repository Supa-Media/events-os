/**
 * Stripe Financial Connections — READ-ONLY legacy external-account sync.
 *
 * Increase is the money layer (payouts + cards); Stripe FC only *reads* legacy
 * bank/card accounts the chapter already has elsewhere, syncing their
 * transactions in as normal `transactions` rows so every dollar still lands in
 * one ledger. Synced rows are `source:"stripe_fc"`, `status:"unreviewed"` (they
 * drop into the reconcile queue for a human), and dedup on
 * `transactions.externalId` = `"stripe_fc:"+<stripe txn id>` so a re-sync (or a
 * pending→posted refresh) never double-counts.
 *
 * DESIGN: the network fetch is separated from the DB apply so the sync is
 * testable without hitting Stripe. `syncTransactions` (internalAction) FETCHES
 * from Stripe, then calls `applyFcTransactions` (internalMutation) which does
 * all dedup/insert/update against `ctx.db`. Tests call `applyFcTransactions`
 * directly with fixture rows.
 *
 * No `"use node"`: `fetch()` runs in the default Convex runtime, so queries +
 * mutations + actions all live in this one file (the action uses runQuery /
 * runMutation, never `ctx.db`). Mirrors the raw-fetch pattern in `stripe.ts`.
 *
 * Env: STRIPE_SECRET_KEY (shared with `stripe.ts`). Degrades gracefully when
 * unset — session creation throws NOT_CONFIGURED; sync logs + skips.
 *
 * Gating (finance-role ladder viewer < bookkeeper < manager):
 *  - createFcSession / storeFcAccount / setAccountFund / disconnect → manager
 *  - listAccounts                                                   → viewer
 *  - applyFcTransactions / syncTransactions / syncAllAccounts /
 *    onFcWebhookEvent                                               → internal
 */
import {
  action,
  mutation,
  query,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { LEGACY_ACCOUNT_STATUSES } from "@events-os/shared";
import { Id } from "./_generated/dataModel";
import {
  getChapterIdOrNull,
  requireChapterId,
} from "./lib/context";
import { requireFinanceRole, requireFinanceManager } from "./lib/finance";

const STRIPE_API = "https://api.stripe.com/v1";

/** The dedup-key prefix that namespaces a Stripe FC txn id in `externalId`. */
const FC_EXTERNAL_PREFIX = "stripe_fc:";

/** Keep every cross-chapter / all-account scan bounded. */
const ACCOUNT_SCAN_LIMIT = 1000;
/** Defensive page cap so a runaway sync can't loop forever. */
const MAX_SYNC_PAGES = 50;
const FC_PAGE_SIZE = 100;

const legacyStatusValidator = v.union(
  ...LEGACY_ACCOUNT_STATUSES.map((s) => v.literal(s)),
);

/** The normalized FC transaction shape the DB-apply mutation consumes. */
const fcTxnValidator = v.object({
  id: v.string(),
  // Signed integer cents from Stripe (negative = debit/outflow).
  amountCents: v.number(),
  postedAt: v.number(),
  description: v.optional(v.string()),
  pending: v.optional(v.boolean()),
});

// ── Public: connect + configure legacy accounts ──────────────────────────────

/**
 * Create a Stripe Financial Connections Session so the client can launch the
 * connect flow. Manager-only. Returns the `client_secret` the front-end SDK
 * needs. Degrades to a ConvexError NOT_CONFIGURED when STRIPE_SECRET_KEY is
 * unset (payments/finance vendor not wired yet).
 */
export const createFcSession = action({
  args: { customerId: v.optional(v.string()) },
  returns: v.object({ clientSecret: v.string() }),
  handler: async (ctx, args): Promise<{ clientSecret: string }> => {
    // Gate FIRST (identity propagates through runQuery) so only a finance
    // manager can even reach the vendor check.
    await ctx.runQuery(internal.stripeFinance.requireManagerForFc, {});

    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new ConvexError({
        code: "NOT_CONFIGURED",
        message:
          "Bank syncing isn't available yet — the finance vendor is still being set up.",
      });
    }

    const body = new URLSearchParams();
    // Read-only: we only ever pull transactions + balances.
    body.set("permissions[0]", "transactions");
    body.set("permissions[1]", "balances");
    // An account holder is required by Stripe; when a customer is known we
    // scope the session to them.
    if (args.customerId) {
      body.set("account_holder[type]", "customer");
      body.set("account_holder[customer]", args.customerId);
    }

    const response = await fetch(
      `${STRIPE_API}/financial_connections/sessions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      },
    );
    if (!response.ok) {
      console.error(
        "[stripe-fc] session create failed:",
        await response.text(),
      );
      throw new ConvexError({
        code: "STRIPE_ERROR",
        message: "Couldn't start the bank connection. Please try again.",
      });
    }
    const session = (await response.json()) as { client_secret: string };
    return { clientSecret: session.client_secret };
  },
});

/** Internal gate for `createFcSession`: assert the caller is a finance manager
 *  in their chapter (used from the action, which has no `ctx.db`). */
export const requireManagerForFc = internalQuery({
  args: {},
  returns: v.object({ chapterId: v.id("chapters") }),
  handler: async (ctx) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);
    return { chapterId };
  },
});

/**
 * Upsert a legacy account for the caller's chapter after a successful connect.
 * Manager-only. Dedups on `stripeFcAccountId` (a Stripe account id is globally
 * unique) so re-connecting the same account refreshes its metadata instead of
 * creating a duplicate. Returns the account id.
 */
export const storeFcAccount = mutation({
  args: {
    stripeFcAccountId: v.string(),
    institutionName: v.optional(v.string()),
    last4: v.optional(v.string()),
    type: v.optional(v.string()),
  },
  returns: v.id("legacyAccounts"),
  handler: async (ctx, args): Promise<Id<"legacyAccounts">> => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);

    const existing = await ctx.db
      .query("legacyAccounts")
      .withIndex("by_stripe_fc_account", (q) =>
        q.eq("stripeFcAccountId", args.stripeFcAccountId),
      )
      .first();
    if (existing) {
      if (existing.chapterId !== chapterId) {
        throw new ConvexError({
          code: "CONFLICT",
          message: "That account is already connected to another chapter.",
        });
      }
      await ctx.db.patch(existing._id, {
        institutionName: args.institutionName ?? existing.institutionName,
        last4: args.last4 ?? existing.last4,
        type: args.type ?? existing.type,
        status: "active",
      });
      return existing._id;
    }

    return await ctx.db.insert("legacyAccounts", {
      chapterId,
      stripeFcAccountId: args.stripeFcAccountId,
      institutionName: args.institutionName,
      last4: args.last4,
      type: args.type,
      status: "active",
      createdAt: Date.now(),
    });
  },
});

/** Set the default fund newly-synced transactions from an account land in.
 *  Manager-only; both the account and the fund must be in the caller's chapter. */
export const setAccountFund = mutation({
  args: {
    legacyAccountId: v.id("legacyAccounts"),
    fundId: v.id("funds"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);

    const account = await ctx.db.get(args.legacyAccountId);
    if (!account || account.chapterId !== chapterId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That account isn't in your chapter.",
      });
    }
    const fund = await ctx.db.get(args.fundId);
    if (!fund || fund.chapterId !== chapterId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That fund isn't in your chapter.",
      });
    }
    await ctx.db.patch(args.legacyAccountId, { defaultFundId: args.fundId });
    return null;
  },
});

/** Disconnect a legacy account (stop syncing). Manager-only. Marks the row
 *  `disconnected` and, when a Stripe key is configured, best-effort tells Stripe
 *  to disconnect too (scheduled — a mutation can't make network calls). */
export const disconnect = mutation({
  args: { legacyAccountId: v.id("legacyAccounts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chapterId = (await requireChapterId(ctx)) as Id<"chapters">;
    await requireFinanceManager(ctx, chapterId);

    const account = await ctx.db.get(args.legacyAccountId);
    if (!account || account.chapterId !== chapterId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That account isn't in your chapter.",
      });
    }
    await ctx.db.patch(args.legacyAccountId, { status: "disconnected" });

    // Best-effort remote disconnect — only when the vendor is wired up.
    if (process.env.STRIPE_SECRET_KEY) {
      await ctx.scheduler.runAfter(
        0,
        internal.stripeFinance.disconnectFcAccount,
        { stripeFcAccountId: account.stripeFcAccountId },
      );
    }
    return null;
  },
});

/** The caller's chapter's legacy accounts (viewer+). Read shape the UI renders. */
export const listAccounts = query({
  args: {},
  returns: v.array(
    v.object({
      id: v.id("legacyAccounts"),
      institutionName: v.union(v.string(), v.null()),
      last4: v.union(v.string(), v.null()),
      type: v.union(v.string(), v.null()),
      status: legacyStatusValidator,
      defaultFundId: v.union(v.id("funds"), v.null()),
      lastSyncedAt: v.union(v.number(), v.null()),
    }),
  ),
  handler: async (ctx) => {
    const chapterId = (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
    if (!chapterId) return [];
    await requireFinanceRole(ctx, chapterId, "viewer");

    const accounts = await ctx.db
      .query("legacyAccounts")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(ACCOUNT_SCAN_LIMIT);
    return accounts.map((a) => ({
      id: a._id,
      institutionName: a.institutionName ?? null,
      last4: a.last4 ?? null,
      type: a.type ?? null,
      status: a.status,
      defaultFundId: a.defaultFundId ?? null,
      lastSyncedAt: a.lastSyncedAt ?? null,
    }));
  },
});

// ── Internal: the DB apply (dedup / insert / update) ─────────────────────────

/**
 * Apply a batch of already-fetched FC transactions to the ledger. THE testable
 * core: pure DB work, no network. For each row, the dedup key is
 * `"stripe_fc:"+id`:
 *  - an existing row with that `externalId` is UPDATED in place (refresh the
 *    pending/amount/postedAt as an authorization posts) — never duplicated;
 *  - otherwise a new `stripe_fc` / `unreviewed` transaction is INSERTED, with
 *    `flow` derived from the sign of the amount and `amountCents` stored as a
 *    non-negative integer (direction lives in `flow`, never a sign).
 * Advances the account's `syncCursor` to the last processed id + stamps
 * `lastSyncedAt`. Returns `{inserted, updated}`.
 */
export const applyFcTransactions = internalMutation({
  args: {
    legacyAccountId: v.id("legacyAccounts"),
    transactions: v.array(fcTxnValidator),
  },
  returns: v.object({ inserted: v.number(), updated: v.number() }),
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.legacyAccountId);
    if (!account) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Legacy account not found.",
      });
    }
    const chapterId = account.chapterId;

    let inserted = 0;
    let updated = 0;
    let lastId: string | null = null;

    for (const row of args.transactions) {
      lastId = row.id;
      const externalId = FC_EXTERNAL_PREFIX + row.id;
      const amountCents = Math.abs(Math.round(row.amountCents));
      const flow: "outflow" | "inflow" =
        row.amountCents < 0 ? "outflow" : "inflow";

      const existing = await ctx.db
        .query("transactions")
        .withIndex("by_external_id", (q) => q.eq("externalId", externalId))
        .first();

      if (existing) {
        // Refresh the volatile fields (a pending authorization posting, an
        // amount/date correction) but never touch a human's categorization or
        // status, and never insert a second row.
        await ctx.db.patch(existing._id, {
          amountCents,
          flow,
          postedAt: row.postedAt,
          pending: row.pending,
          merchantName: row.description ?? existing.merchantName,
        });
        updated++;
        continue;
      }

      await ctx.db.insert("transactions", {
        chapterId,
        source: "stripe_fc",
        flow,
        amountCents,
        currency: "usd",
        postedAt: row.postedAt,
        merchantName: row.description,
        status: "unreviewed",
        fundId: account.defaultFundId,
        sourceAccountId: account.stripeFcAccountId,
        externalId,
        pending: row.pending,
        createdAt: Date.now(),
      });
      inserted++;
    }

    // Advance the cursor to the last id we saw so the next sync resumes after
    // it; always stamp the sync time.
    await ctx.db.patch(args.legacyAccountId, {
      ...(lastId != null ? { syncCursor: lastId } : {}),
      lastSyncedAt: Date.now(),
    });

    return { inserted, updated };
  },
});

// ── Internal: the network fetch + drivers ────────────────────────────────────

/** Load a legacy account by id (for the fetch action, which has no `ctx.db`). */
export const getAccount = internalQuery({
  args: { legacyAccountId: v.id("legacyAccounts") },
  returns: v.union(
    v.object({
      id: v.id("legacyAccounts"),
      stripeFcAccountId: v.string(),
      syncCursor: v.union(v.string(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.legacyAccountId);
    if (!account) return null;
    return {
      id: account._id,
      stripeFcAccountId: account.stripeFcAccountId,
      syncCursor: account.syncCursor ?? null,
    };
  },
});

/** All active legacy accounts across every chapter (bounded) — the cron feed. */
export const listActiveAccounts = internalQuery({
  args: {},
  returns: v.array(v.id("legacyAccounts")),
  handler: async (ctx) => {
    const accounts = await ctx.db
      .query("legacyAccounts")
      .take(ACCOUNT_SCAN_LIMIT);
    return accounts
      .filter((a) => a.status === "active")
      .map((a) => a._id);
  },
});

/** One Stripe FC transaction (only the fields we consume). */
interface StripeFcTransaction {
  id: string;
  amount: number;
  description?: string | null;
  status?: string;
  transacted_at?: number;
  status_transitions?: { posted_at?: number | null };
}

/** Map a raw Stripe FC transaction to the `applyFcTransactions` row shape. */
function mapFcTransaction(
  txn: StripeFcTransaction,
): typeof fcTxnValidator.type {
  const postedSeconds =
    txn.status_transitions?.posted_at ?? txn.transacted_at ?? 0;
  return {
    id: txn.id,
    amountCents: txn.amount,
    postedAt: postedSeconds * 1000,
    description: txn.description ?? undefined,
    pending: txn.status === "pending",
  };
}

/**
 * Fetch a legacy account's transactions from Stripe and apply them. Best-effort:
 * missing key or any network/parse error logs and returns rather than throwing,
 * so a cron sweep of many accounts never aborts on one bad account.
 */
export const syncTransactions = internalAction({
  args: { legacyAccountId: v.id("legacyAccounts") },
  returns: v.object({
    skipped: v.boolean(),
    inserted: v.number(),
    updated: v.number(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ skipped: boolean; inserted: number; updated: number }> => {
    const account = await ctx.runQuery(internal.stripeFinance.getAccount, {
      legacyAccountId: args.legacyAccountId,
    });
    if (!account) {
      console.warn(
        `[stripe-fc] sync skipped: account ${args.legacyAccountId} not found`,
      );
      return { skipped: true, inserted: 0, updated: 0 };
    }

    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      console.warn(
        "[stripe-fc] sync skipped: STRIPE_SECRET_KEY not configured",
      );
      return { skipped: true, inserted: 0, updated: 0 };
    }

    let inserted = 0;
    let updated = 0;
    try {
      const collected: (typeof fcTxnValidator.type)[] = [];
      let after = account.syncCursor ?? undefined;
      for (let page = 0; page < MAX_SYNC_PAGES; page++) {
        const params = new URLSearchParams();
        params.set("account", account.stripeFcAccountId);
        params.set("limit", String(FC_PAGE_SIZE));
        if (after) params.set("after", after);

        const response = await fetch(
          `${STRIPE_API}/financial_connections/transactions?${params.toString()}`,
          { headers: { Authorization: `Bearer ${secretKey}` } },
        );
        if (!response.ok) {
          console.error(
            "[stripe-fc] transactions fetch failed:",
            await response.text(),
          );
          break;
        }
        const body = (await response.json()) as {
          data?: StripeFcTransaction[];
          has_more?: boolean;
        };
        const data = body.data ?? [];
        for (const txn of data) collected.push(mapFcTransaction(txn));
        if (!body.has_more || data.length === 0) break;
        after = data[data.length - 1].id;
      }

      if (collected.length > 0) {
        const result = await ctx.runMutation(
          internal.stripeFinance.applyFcTransactions,
          { legacyAccountId: args.legacyAccountId, transactions: collected },
        );
        inserted = result.inserted;
        updated = result.updated;
      }
    } catch (err) {
      console.error("[stripe-fc] sync error:", err);
      return { skipped: false, inserted, updated };
    }

    return { skipped: false, inserted, updated };
  },
});

/**
 * React to a Stripe FC webhook event for an account: look the account up and
 * schedule a sync. No-op (never throws) for an account we don't track — the
 * shared `/stripe/webhook` handler fans every FC event through here.
 */
export const onFcWebhookEvent = internalMutation({
  args: { stripeAccountId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const account = await ctx.db
      .query("legacyAccounts")
      .withIndex("by_stripe_fc_account", (q) =>
        q.eq("stripeFcAccountId", args.stripeAccountId),
      )
      .first();
    if (!account) return null;
    await ctx.scheduler.runAfter(0, internal.stripeFinance.syncTransactions, {
      legacyAccountId: account._id,
    });
    return null;
  },
});

/** Cron backstop: schedule a sync for every active legacy account. */
export const syncAllAccounts = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const ids: Id<"legacyAccounts">[] = await ctx.runQuery(
      internal.stripeFinance.listActiveAccounts,
      {},
    );
    for (const legacyAccountId of ids) {
      await ctx.scheduler.runAfter(
        0,
        internal.stripeFinance.syncTransactions,
        { legacyAccountId },
      );
    }
    return null;
  },
});

/** Best-effort Stripe-side disconnect of a legacy account (scheduled from the
 *  `disconnect` mutation). Logs + swallows errors — the local row is already
 *  marked disconnected. */
export const disconnectFcAccount = internalAction({
  args: { stripeFcAccountId: v.string() },
  returns: v.null(),
  handler: async (_ctx, args) => {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) return null;
    try {
      const response = await fetch(
        `${STRIPE_API}/financial_connections/accounts/${args.stripeFcAccountId}/disconnect`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${secretKey}` },
        },
      );
      if (!response.ok) {
        console.error(
          "[stripe-fc] disconnect failed:",
          await response.text(),
        );
      }
    } catch (err) {
      console.error("[stripe-fc] disconnect error:", err);
    }
    return null;
  },
});
