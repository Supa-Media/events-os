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
 *  - createFcSession / storeFcAccount / setAccountFund / disconnect /
 *    refreshFcAccount                                               → manager
 *  - listAccounts                                                   → viewer
 *  - applyFcTransactions / syncTransactions / syncAllAccounts /
 *    refreshFcTransactions / refreshAllActiveFcAccounts /
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
import type { MutationCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { LEGACY_ACCOUNT_STATUSES, extractCardLast4 } from "@events-os/shared";
import { Doc, Id } from "./_generated/dataModel";
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
/** Bound the deployment-wide transaction backfill scan. */
const BACKFILL_SCAN_LIMIT = 10000;
/** Defensive page cap so a runaway sync can't loop forever. */
const MAX_SYNC_PAGES = 50;
const FC_PAGE_SIZE = 100;

/**
 * Fallback re-sync delays (ms) after kicking off a Stripe transaction refresh.
 * Stripe pulls FC transaction history ASYNCHRONOUSLY, so these give it time to
 * land even when the FC webhook isn't configured in this environment. Bounded —
 * two retries, never an unbounded loop; repeated syncs are idempotent (dedup on
 * `transactions.externalId`).
 */
const FC_REFRESH_RETRY_DELAYS_MS = [45_000, 180_000];

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
 * connect flow. Manager-only. Returns the `client_secret` the browser Stripe.js
 * SDK consumes to run the hosted linking, plus the `publishableKey` it inits
 * with. Degrades to a ConvexError NOT_CONFIGURED when STRIPE_SECRET_KEY is
 * unset (payments/finance vendor not wired yet).
 *
 * Stripe REQUIRES an `account_holder` on every FC session. We provision (once)
 * and cache a Stripe Customer per connecting chapter (`financeStripeCustomers`)
 * and scope every session to it, so a reconnect reuses the same holder instead
 * of minting a fresh customer each time.
 */
export const createFcSession = action({
  args: {},
  returns: v.object({
    clientSecret: v.string(),
    publishableKey: v.union(v.string(), v.null()),
  }),
  handler: async (
    ctx,
  ): Promise<{ clientSecret: string; publishableKey: string | null }> => {
    // Gate FIRST (identity propagates through runQuery) so only a finance
    // manager can even reach the vendor check. The gate resolves the chapter
    // the customer + session are scoped to.
    const { chapterId } = await ctx.runQuery(
      internal.stripeFinance.requireManagerForFc,
      {},
    );

    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new ConvexError({
        code: "NOT_CONFIGURED",
        message:
          "Bank syncing isn't available yet — the finance vendor is still being set up.",
      });
    }

    const authHeaders = {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    };

    // Ensure a Stripe Customer exists for this chapter (the FC session's
    // required account_holder). Reuse the cached one when present.
    let customerId = await ctx.runQuery(
      internal.stripeFinance.getStripeCustomerId,
      { chapterId },
    );
    if (!customerId) {
      const customerBody = new URLSearchParams();
      customerBody.set("metadata[chapterId]", chapterId);
      const customerResponse = await fetch(`${STRIPE_API}/customers`, {
        method: "POST",
        headers: authHeaders,
        body: customerBody.toString(),
      });
      if (!customerResponse.ok) {
        console.error(
          "[stripe-fc] customer create failed:",
          await customerResponse.text(),
        );
        throw new ConvexError({
          code: "STRIPE_ERROR",
          message: "Couldn't start the bank connection. Please try again.",
        });
      }
      const customer = (await customerResponse.json()) as { id: string };
      // saveStripeCustomerId is race-safe: if a concurrent create beat us it
      // returns the already-cached id (the extra Stripe customer is harmless).
      customerId = await ctx.runMutation(
        internal.stripeFinance.saveStripeCustomerId,
        { chapterId, stripeCustomerId: customer.id },
      );
    }

    const body = new URLSearchParams();
    // Read-only: we only ever pull transactions + balances.
    body.set("permissions[0]", "transactions");
    body.set("permissions[1]", "balances");
    // Required by Stripe — scope the session to the chapter's cached customer.
    body.set("account_holder[type]", "customer");
    body.set("account_holder[customer]", customerId);

    const response = await fetch(
      `${STRIPE_API}/financial_connections/sessions`,
      {
        method: "POST",
        headers: authHeaders,
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
    return {
      clientSecret: session.client_secret,
      publishableKey: process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? null,
    };
  },
});

/** The cached Stripe Customer id for a chapter (the FC session account_holder),
 *  or null when none has been provisioned yet. Internal — used from the action. */
export const getStripeCustomerId = internalQuery({
  args: { chapterId: v.union(v.id("chapters"), v.literal("central")) },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("financeStripeCustomers")
      .withIndex("by_chapter", (q) => q.eq("chapterId", args.chapterId))
      .first();
    return row?.stripeCustomerId ?? null;
  },
});

/** Cache the Stripe Customer id for a chapter. Race-safe: if a row already
 *  exists (a concurrent create won), keep it and return the cached id so we
 *  never double-store — the caller uses the returned id, not its own. */
export const saveStripeCustomerId = internalMutation({
  args: {
    chapterId: v.union(v.id("chapters"), v.literal("central")),
    stripeCustomerId: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const existing = await ctx.db
      .query("financeStripeCustomers")
      .withIndex("by_chapter", (q) => q.eq("chapterId", args.chapterId))
      .first();
    if (existing) return existing.stripeCustomerId;
    await ctx.db.insert("financeStripeCustomers", {
      chapterId: args.chapterId,
      stripeCustomerId: args.stripeCustomerId,
      createdAt: Date.now(),
    });
    return args.stripeCustomerId;
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
      // Was this row NOT already active (i.e. `disconnected`/`error`)? Then this
      // upsert REACTIVATES it. A reconnect after a disconnect must re-pull the
      // history — Stripe stops syncing while disconnected, so any activity since
      // then is missing. Re-connecting an already-active account is a pure
      // metadata refresh and needs no fetch (its ongoing sync never stopped).
      const wasActive = existing.status === "active";
      await ctx.db.patch(existing._id, {
        institutionName: args.institutionName ?? existing.institutionName,
        last4: args.last4 ?? existing.last4,
        type: args.type ?? existing.type,
        status: "active",
      });

      // Reactivation → ask Stripe to (re)fetch transactions, exactly like the
      // new-insert path below. Key-gated + idempotent (dedup on `externalId`), so
      // it's a safe no-op without the vendor and never double-counts.
      if (!wasActive && process.env.STRIPE_SECRET_KEY) {
        await ctx.scheduler.runAfter(
          0,
          internal.stripeFinance.refreshFcTransactions,
          {
            legacyAccountId: existing._id,
            stripeFcAccountId: existing.stripeFcAccountId,
          },
        );
      }
      return existing._id;
    }

    const legacyAccountId = await ctx.db.insert("legacyAccounts", {
      chapterId,
      stripeFcAccountId: args.stripeFcAccountId,
      institutionName: args.institutionName,
      last4: args.last4,
      type: args.type,
      status: "active",
      createdAt: Date.now(),
    });

    // Stripe pulls FC transaction history ASYNCHRONOUSLY after linking, so an
    // immediate sync would see an empty set. Instead ask Stripe to fetch the
    // transactions (POST .../refresh) and let the resulting
    // `refreshed_transactions` webhook — plus bounded fallback retries — drive
    // the actual sync once the data lands. No-op degrade when the vendor isn't
    // wired up — matches the key-gating elsewhere in this file.
    if (process.env.STRIPE_SECRET_KEY) {
      await ctx.scheduler.runAfter(
        0,
        internal.stripeFinance.refreshFcTransactions,
        { legacyAccountId, stripeFcAccountId: args.stripeFcAccountId },
      );
    }

    return legacyAccountId;
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

/**
 * Manually re-pull an account's transactions on demand ("Refresh now" / "Sync"
 * in the UI). Manager-only; the account must be in the caller's chapter. Kicks
 * off the SAME best-effort Stripe fetch + bounded fallback re-syncs the connect
 * path uses (`refreshFcTransactions`), so the freshest transactions land in
 * Reconcile without waiting for the daily cron. Degrades to a no-op without
 * STRIPE_SECRET_KEY (the vendor isn't wired up); throws `ConvexError` on an
 * authz/tenancy failure.
 */
export const refreshFcAccount = mutation({
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

    // Same key-gated, idempotent refresh the connect/reactivation paths use. The
    // action itself POSTs the Stripe refresh and schedules the bounded re-syncs.
    if (process.env.STRIPE_SECRET_KEY) {
      await ctx.scheduler.runAfter(
        0,
        internal.stripeFinance.refreshFcTransactions,
        {
          legacyAccountId: account._id,
          stripeFcAccountId: account.stripeFcAccountId,
        },
      );
    }
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

/**
 * Find the LEGACY card in a chapter that owns a given last-4, or null. Legacy
 * (external/Relay) cards are matched by `[chapterId, last4]`; a native Increase
 * card with the same last-4 is ignored here — only a linked legacy card
 * attributes FC-synced transactions. Shared by the sync apply + the backfill.
 */
async function findLegacyCardByLast4(
  ctx: { db: MutationCtx["db"] },
  chapterId: Id<"chapters">,
  last4: string,
): Promise<Doc<"cards"> | null> {
  const matches = await ctx.db
    .query("cards")
    .withIndex("by_chapter_and_last4", (q) =>
      q.eq("chapterId", chapterId).eq("last4", last4),
    )
    .collect();
  return matches.find((c) => c.source === "legacy") ?? null;
}

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
 * Stamps the account's `lastSyncedAt`. Returns `{inserted, updated}`. This apply
 * step keeps no cursor of its own — both the first-connect backfill and the
 * ongoing incremental re-sweep drive pagination in `syncTransactions` and lean
 * on this dedup; see that action's note.
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

    for (const row of args.transactions) {
      const externalId = FC_EXTERNAL_PREFIX + row.id;
      const amountCents = Math.abs(Math.round(row.amountCents));
      const flow: "outflow" | "inflow" =
        row.amountCents < 0 ? "outflow" : "inflow";
      // The card last-4 lives ONLY inside the description string (no structured
      // field), so parse it out for matching + display.
      const cardLast4 = extractCardLast4(row.description);
      // A linked legacy (Relay) card for that last-4 makes its charges that
      // person's responsibility. Attribute unattributed rows to it.
      const legacyCard = cardLast4
        ? await findLegacyCardByLast4(ctx, chapterId, cardLast4)
        : null;

      const existing = await ctx.db
        .query("transactions")
        .withIndex("by_external_id", (q) => q.eq("externalId", externalId))
        .first();

      if (existing) {
        // Refresh the volatile fields (a pending authorization posting, an
        // amount/date correction) but never touch a human's categorization or
        // status, and never insert a second row.
        const patch: Partial<Doc<"transactions">> = {
          amountCents,
          flow,
          postedAt: row.postedAt,
          pending: row.pending,
          // Don't clobber a hand-edited merchant name; only fill it when empty.
          merchantName: existing.merchantName ?? row.description,
        };
        // Backfill the parsed last-4 when the row lacks it (older synced rows).
        if (existing.cardLast4 == null && cardLast4) patch.cardLast4 = cardLast4;
        // Attribute to the legacy card only when a human hasn't already
        // categorized it — never clobber cardId/personId.
        if (legacyCard && existing.cardId == null && existing.personId == null) {
          patch.cardId = legacyCard._id;
          patch.personId = legacyCard.cardholderPersonId;
        }
        await ctx.db.patch(existing._id, patch);
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
        cardLast4: cardLast4 ?? undefined,
        status: "unreviewed",
        fundId: account.defaultFundId,
        sourceAccountId: account.stripeFcAccountId,
        // Attribute to a linked legacy card at insert time (a fresh sync row is
        // never human-categorized yet).
        cardId: legacyCard?._id,
        personId: legacyCard?.cardholderPersonId,
        externalId,
        pending: row.pending,
        createdAt: Date.now(),
      });
      inserted++;
    }

    // Stamp the sync time (no persistent cursor — see the docstring).
    await ctx.db.patch(args.legacyAccountId, { lastSyncedAt: Date.now() });

    return { inserted, updated };
  },
});

/**
 * Backfill legacy-card attribution over already-synced `stripe_fc` transactions
 * (bounded, idempotent). For each such transaction it:
 *  - parses `cardLast4` from `merchantName` (where the description was stored)
 *    when the row lacks it;
 *  - attributes the row to a linked legacy card (`cardId` + `personId`) when a
 *    legacy card matches that last-4 in the chapter AND the row isn't already
 *    human-categorized (both fields unset).
 * Never clobbers an existing categorization. Re-running changes nothing once
 * every row is stamped + attributed.
 *
 * Ops escape hatch — runnable from `run-convex-function.yml`
 * (`stripeFinance:backfillLegacyCardAttribution`). Scans up to `BACKFILL_SCAN_LIMIT`
 * transactions per run; returns what it touched.
 */
export const backfillLegacyCardAttribution = internalMutation({
  args: {},
  returns: v.object({
    scanned: v.number(),
    last4Set: v.number(),
    attributed: v.number(),
  }),
  handler: async (ctx) => {
    const rows = await ctx.db.query("transactions").take(BACKFILL_SCAN_LIMIT);
    let scanned = 0;
    let last4Set = 0;
    let attributed = 0;

    for (const row of rows) {
      if (row.source !== "stripe_fc") continue;
      scanned++;

      const patch: Partial<Doc<"transactions">> = {};
      // The card last-4 lives in the stored description (merchantName).
      const cardLast4 = row.cardLast4 ?? extractCardLast4(row.merchantName);
      if (row.cardLast4 == null && cardLast4) {
        patch.cardLast4 = cardLast4;
        last4Set++;
      }

      // Attribute to a linked legacy card only when unset (never clobber).
      if (cardLast4 && row.cardId == null && row.personId == null) {
        const legacyCard = await findLegacyCardByLast4(
          ctx,
          row.chapterId,
          cardLast4,
        );
        if (legacyCard) {
          patch.cardId = legacyCard._id;
          patch.personId = legacyCard.cardholderPersonId;
          attributed++;
        }
      }

      if (Object.keys(patch).length > 0) await ctx.db.patch(row._id, patch);
    }

    return { scanned, last4Set, attributed };
  },
});

// ── Internal: the network fetch + drivers ────────────────────────────────────

/** Load a legacy account by id (for the fetch action, which has no `ctx.db`).
 *  Includes the backfill state (`backfilledAt` / `syncCursor`) so the sync
 *  action can branch between first-connect full-history backfill and the
 *  ongoing incremental re-sweep. */
export const getAccount = internalQuery({
  args: { legacyAccountId: v.id("legacyAccounts") },
  returns: v.union(
    v.object({
      id: v.id("legacyAccounts"),
      stripeFcAccountId: v.string(),
      backfilledAt: v.union(v.number(), v.null()),
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
      backfilledAt: account.backfilledAt ?? null,
      syncCursor: account.syncCursor ?? null,
    };
  },
});

/**
 * Persist first-connect backfill progress (the fetch action has no `ctx.db`).
 *  - `completed`: the whole history has been paged in — stamp `backfilledAt`,
 *    CLEAR `syncCursor`, and stamp `lastSyncedAt`. Subsequent syncs go
 *    incremental.
 *  - otherwise (more history remains, or a mid-backfill fetch errored): save
 *    the resume cursor (`syncCursor`) and stamp `lastSyncedAt`, WITHOUT setting
 *    `backfilledAt`, so a follow-up run continues draining from that point.
 */
export const recordBackfillProgress = internalMutation({
  args: {
    legacyAccountId: v.id("legacyAccounts"),
    completed: v.boolean(),
    syncCursor: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.completed) {
      // Patching a field to `undefined` removes it — clears the resume cursor.
      await ctx.db.patch(args.legacyAccountId, {
        backfilledAt: Date.now(),
        syncCursor: undefined,
        lastSyncedAt: Date.now(),
      });
    } else {
      await ctx.db.patch(args.legacyAccountId, {
        syncCursor: args.syncCursor,
        lastSyncedAt: Date.now(),
      });
    }
    return null;
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

/** All active legacy accounts (bounded) as `{id, stripeFcAccountId}` — the feed
 *  for a forced transaction re-fetch (`refreshAllActiveFcAccounts`), which needs
 *  the Stripe id `refreshFcTransactions` POSTs against. */
export const listActiveAccountsForRefresh = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      id: v.id("legacyAccounts"),
      stripeFcAccountId: v.string(),
    }),
  ),
  handler: async (ctx) => {
    const accounts = await ctx.db
      .query("legacyAccounts")
      .take(ACCOUNT_SCAN_LIMIT);
    return accounts
      .filter((a) => a.status === "active")
      .map((a) => ({ id: a._id, stripeFcAccountId: a.stripeFcAccountId }));
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
 * Fetch a legacy account's transactions from Stripe and apply them.
 *
 * TWO PHASES, branched on `account.backfilledAt`:
 *
 * 1. FIRST-CONNECT FULL BACKFILL (`backfilledAt` unset): page through the
 *    ENTIRE history until Stripe reports `has_more:false`. MAX_SYNC_PAGES is a
 *    per-invocation BATCH size (respecting action time/step limits), NOT a hard
 *    history limit: when a run hits the cap with more history left, it saves the
 *    resume cursor (`syncCursor`) and schedules itself again to keep draining;
 *    when it reaches the end it stamps `backfilledAt` and clears the cursor.
 *
 * 2. INCREMENTAL RE-SWEEP (`backfilledAt` set): a BOUNDED newest-first re-sweep,
 *    NOT a persistent walking cursor. Stripe lists FC transactions newest-first,
 *    so each scheduled sync re-reads from the top (up to MAX_SYNC_PAGES, using
 *    `starting_after` only for intra-sweep pagination). Genuinely new rows sit
 *    at the front and get inserted; already-seen rows (including ones synced
 *    while `pending`) are absorbed by `applyFcTransactions`'s idempotent dedup —
 *    which is also what fires the pending→posted in-place update. This catches
 *    BOTH new activity and pending→posted transitions on every sweep. (A
 *    persistent last-id cursor would walk toward OLDER records and miss both.)
 *
 * Both phases dedup on `transactions.externalId`, so a re-run (a resumed
 * backfill, an overlapping sweep) never double-counts.
 *
 * Best-effort: a missing key or any network/parse error logs and returns rather
 * than throwing, so a cron sweep of many accounts never aborts on one account.
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

    const isBackfill = account.backfilledAt === null;

    let inserted = 0;
    let updated = 0;
    try {
      const collected: (typeof fcTxnValidator.type)[] = [];
      // Backfill RESUMES from the saved cursor; the incremental sweep always
      // starts fresh from the newest row.
      let startingAfter: string | undefined =
        isBackfill && account.syncCursor ? account.syncCursor : undefined;
      let lastObjectId: string | undefined = startingAfter;
      let hasMore = false;
      let errored = false;

      for (let page = 0; page < MAX_SYNC_PAGES; page++) {
        const params = new URLSearchParams();
        params.set("account", account.stripeFcAccountId);
        params.set("limit", String(FC_PAGE_SIZE));
        // Stripe's FC transactions list uses `starting_after` (an object id) for
        // pagination — not `after`, which Stripe silently ignores.
        if (startingAfter) params.set("starting_after", startingAfter);

        const response = await fetch(
          `${STRIPE_API}/financial_connections/transactions?${params.toString()}`,
          { headers: { Authorization: `Bearer ${secretKey}` } },
        );
        if (!response.ok) {
          console.error(
            "[stripe-fc] transactions fetch failed:",
            await response.text(),
          );
          errored = true;
          break;
        }
        const body = (await response.json()) as {
          data?: StripeFcTransaction[];
          has_more?: boolean;
        };
        const data = body.data ?? [];
        for (const txn of data) collected.push(mapFcTransaction(txn));
        hasMore = body.has_more ?? false;
        if (data.length > 0) lastObjectId = data[data.length - 1].id;
        if (!hasMore || data.length === 0) break;
        startingAfter = data[data.length - 1].id;
      }

      if (collected.length > 0) {
        const result = await ctx.runMutation(
          internal.stripeFinance.applyFcTransactions,
          { legacyAccountId: args.legacyAccountId, transactions: collected },
        );
        inserted = result.inserted;
        updated = result.updated;
      }

      if (isBackfill) {
        if (!errored && !hasMore) {
          // Reached the end of history — mark the account fully backfilled and
          // drop the resume cursor. Future syncs run the incremental re-sweep.
          await ctx.runMutation(
            internal.stripeFinance.recordBackfillProgress,
            { legacyAccountId: args.legacyAccountId, completed: true },
          );
        } else {
          // More history remains (hit the per-run page cap) OR a fetch errored
          // mid-drain: persist the resume cursor so a follow-up run continues.
          await ctx.runMutation(
            internal.stripeFinance.recordBackfillProgress,
            {
              legacyAccountId: args.legacyAccountId,
              completed: false,
              syncCursor: lastObjectId,
            },
          );
          // Only chain another invocation when Stripe still has more to give;
          // on an error we stop and let the daily cron / a webhook retry, so a
          // failing account can't spin in a tight reschedule loop.
          if (!errored && hasMore) {
            await ctx.scheduler.runAfter(
              0,
              internal.stripeFinance.syncTransactions,
              { legacyAccountId: args.legacyAccountId },
            );
          }
        }
      }
    } catch (err) {
      console.error("[stripe-fc] sync error:", err);
      return { skipped: false, inserted, updated };
    }

    return { skipped: false, inserted, updated };
  },
});

/**
 * Ask Stripe to (asynchronously) fetch a freshly-connected account's
 * transaction history, then schedule bounded fallback re-syncs.
 *
 * WHY: Stripe populates FC transactions ASYNCHRONOUSLY after linking, so a sync
 * fired the instant an account connects reads an empty set (and would stamp
 * `lastSyncedAt` with nothing). This POSTs
 * `/financial_connections/accounts/{id}/refresh` with `features[]=transactions`
 * to kick that fetch off. When it completes Stripe sends a
 * `financial_connections.account.refreshed_transactions` webhook, which
 * `onFcWebhookEvent` turns into a `syncTransactions` — but the webhook may not
 * be configured for FC events in every environment, so we ALSO schedule a
 * couple of delayed `syncTransactions` retries as a belt-and-suspenders
 * fallback. Bounded (two retries) and idempotent (dedup on `externalId`), so
 * overlapping with a webhook-driven sync never double-counts.
 *
 * Best-effort + key-gated like the rest of this file: no key → no-op; any
 * network/parse error logs and returns (never throws).
 */
export const refreshFcTransactions = internalAction({
  args: {
    legacyAccountId: v.id("legacyAccounts"),
    stripeFcAccountId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      console.warn(
        "[stripe-fc] refresh skipped: STRIPE_SECRET_KEY not configured",
      );
      return null;
    }

    try {
      const body = new URLSearchParams();
      body.set("features[]", "transactions");
      const response = await fetch(
        `${STRIPE_API}/financial_connections/accounts/${args.stripeFcAccountId}/refresh`,
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
          "[stripe-fc] transaction refresh failed:",
          await response.text(),
        );
      }
    } catch (err) {
      console.error("[stripe-fc] transaction refresh error:", err);
    }

    // Fallback for environments without the FC webhook: re-sync a couple of
    // times after Stripe has had a moment to pull the history. Idempotent, so
    // this is harmless whether or not the webhook also fires.
    for (const delayMs of FC_REFRESH_RETRY_DELAYS_MS) {
      await ctx.scheduler.runAfter(
        delayMs,
        internal.stripeFinance.syncTransactions,
        { legacyAccountId: args.legacyAccountId },
      );
    }
    return null;
  },
});

/**
 * React to a Stripe FC webhook event for an account. For a
 * `financial_connections.account.disconnected` event we mark the account
 * `disconnected` (Stripe cut us off — stop syncing); for any other event we
 * schedule a sync. No-op (never throws) for an account we don't track — the
 * shared `/stripe/webhook` handler fans every FC event through here with its
 * `eventType`.
 */
export const onFcWebhookEvent = internalMutation({
  args: { stripeAccountId: v.string(), eventType: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const account = await ctx.db
      .query("legacyAccounts")
      .withIndex("by_stripe_fc_account", (q) =>
        q.eq("stripeFcAccountId", args.stripeAccountId),
      )
      .first();
    if (!account) return null;

    if (args.eventType === "financial_connections.account.disconnected") {
      await ctx.db.patch(account._id, { status: "disconnected" });
      return null;
    }

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

/**
 * Force a transaction re-fetch for EVERY active legacy account across all
 * chapters (bounded). Ops escape hatch — runnable from `run-convex-function.yml`
 * (`stripeFinance:refreshAllActiveFcAccounts`) to pull the latest history for a
 * chapter without touching the UI. Schedules `refreshFcTransactions` (Stripe
 * fetch + bounded fallback re-syncs) per account; key-gated + idempotent (dedup
 * on `externalId`), so it's a safe no-op without the vendor and never
 * double-counts. Mirrors `syncAllAccounts`, but asks Stripe to REFETCH first
 * rather than only re-sweeping what's already landed.
 */
export const refreshAllActiveFcAccounts = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const accounts = await ctx.runQuery(
      internal.stripeFinance.listActiveAccountsForRefresh,
      {},
    );
    for (const account of accounts) {
      await ctx.scheduler.runAfter(
        0,
        internal.stripeFinance.refreshFcTransactions,
        {
          legacyAccountId: account.id,
          stripeFcAccountId: account.stripeFcAccountId,
        },
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
