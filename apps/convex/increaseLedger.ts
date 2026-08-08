/**
 * Increase transaction INGESTION → the `transactions` ledger. Every settled
 * entry on a provisioned Increase account lands here exactly once, split into
 * two lanes (see `lib/increaseExtract.ts` for the pure extraction half):
 *
 *  - CARD lane (`source:"increase_card"`): a settled member-card charge/refund
 *    (`card_settlement`/`card_refund`), attributed to our `cards` row via its
 *    Card Payment (`GET /card_payments/{id}` → `card_id`).
 *  - ACCOUNT lane (`source:"increase_ach"`): EVERYTHING ELSE that moves money
 *    on the account — inbound/outbound ACH, wires, check deposits, fees,
 *    interest, dashboard-initiated transfers. Without this lane an inbound
 *    transfer (e.g. Relay → the chapter's Increase account) never reached
 *    Reconcile, so its two legs could not be marked as a transfer.
 *
 * ALREADY-BOOKED GUARDS (the account lane's double-count protection): some
 * account activity is the settlement of money the app ALREADY ledgered
 * through its own state machines, matched via the activity's `transfer_id`:
 *  - a reimbursement payout ACH (`payouts.increaseTransferId` — its expense
 *    posts as `source:"reimbursement"` at settle, see
 *    `lib/increasePayoutMachine.ts#postReimbursementSpend`),
 *  - a personal-repayment ACH debit (`personalRepayments.increaseRef` — its
 *    offsetting credit posts as `source:"repayment"` at settle, `cards.ts`),
 *  - a historical auto-initiated transfer leg (retired skim/launch-grant/
 *    settlement flows stamped the leg's `externalId` with the Increase
 *    transfer id — see `transfers.ts`'s header comment).
 * A matched row is SKIPPED (logged), everything else is posted `unreviewed`
 * for a bookkeeper to code/mark in Reconcile.
 *
 * DESIGN (mirrors `stripeFinance.ts`): the network fetch is separated from the
 * DB apply so ingestion is testable WITHOUT hitting Increase. Webhook events
 * carry NO inline object — `ingestIncreaseTransaction` fetches
 * `GET /transactions/{id}`; the daily backfill pages
 * `GET /transactions?account_id=…`. Both dedup on `externalId`
 * (`by_external_id`) and both are best-effort (log + continue, never throw).
 */
import { internalQuery, internalMutation, internalAction } from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc } from "./_generated/dataModel";
import { defaultFundId, type FinanceScope } from "./lib/finance";
import { increaseEnvForObjectId, increaseGet } from "./lib/increaseApi";
import {
  extractCardCharge,
  extractAccountActivity,
  type IncreaseTransactionLite,
} from "./lib/increaseExtract";

/** Resolve the owning scope (chapter or central) from an Increase account id.
 *  Null when the account isn't ours — the caller skips the row. */
async function resolveOwningAccount(
  ctx: MutationCtx,
  increaseAccountId: string,
): Promise<Doc<"increaseAccounts"> | null> {
  return await ctx.db
    .query("increaseAccounts")
    .withIndex("by_increase_account", (q) =>
      q.eq("increaseAccountId", increaseAccountId),
    )
    .first();
}

/**
 * Insert a settled Increase card charge into the `transactions` ledger — the pure
 * DB apply (no network), so the ingestion is testable without hitting Increase.
 *
 * IDEMPOTENT: dedups on `externalId` (the Increase transaction id) via
 * `by_external_id` — a redelivered webhook or an overlapping backfill never
 * double-inserts. Resolves the owning chapter from `accountId` → `increaseAccounts`
 * (`by_increase_account`); a transaction for an account we don't hold is SKIPPED.
 * Attribution: `increaseCardId` → our `cards` (`by_increase_card`, verified in the
 * resolved chapter) fills `cardId` / `personId` / `cardLast4`; an unmatched card
 * still records the txn with null attribution (a human reconciles it). New rows
 * land `status:"unreviewed"`, `pending:false` (settled).
 */
export const applyIncreaseCardTransaction = internalMutation({
  args: {
    externalId: v.string(),
    accountId: v.string(),
    flow: v.union(v.literal("outflow"), v.literal("inflow")),
    amountCents: v.number(),
    currency: v.optional(v.string()),
    postedAt: v.number(),
    merchantName: v.optional(v.string()),
    merchantCategory: v.optional(v.string()),
    // The resolved Increase card id (from the Card Payment), or absent when
    // attribution couldn't be resolved — the txn is still recorded.
    increaseCardId: v.optional(v.string()),
  },
  returns: v.object({ inserted: v.boolean(), skipped: v.boolean() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ inserted: boolean; skipped: boolean }> => {
    // Dedup: one ledger row per Increase transaction id.
    const existing = await ctx.db
      .query("transactions")
      .withIndex("by_external_id", (q) => q.eq("externalId", args.externalId))
      .first();
    if (existing) return { inserted: false, skipped: false };

    // Resolve the owning chapter from the Increase account id. Not ours → skip.
    const account = await resolveOwningAccount(ctx, args.accountId);
    if (!account) return { inserted: false, skipped: true };
    // Central (WP-1.2) holds its OWN Increase account (the City Launch Fund).
    // WP-2.1 lets money belong to central, so a charge landing on the central
    // account is INGESTED as a central-owned txn (`chapterId:"central"`) rather
    // than dropped. Central issues no member cards, so card attribution never
    // resolves and the fund default is null (central has no funds) — the row
    // records with null card/person/fund, for the central desk to reconcile.
    const chapterId: FinanceScope = account.chapterId;

    // Attribute to a native card in THIS scope (never cross-chapter). Central
    // has no cards, so this is always null there. An unmatched card id leaves
    // attribution null — the row is still recorded.
    let card: Doc<"cards"> | null = null;
    if (args.increaseCardId) {
      const cards = await ctx.db
        .query("cards")
        .withIndex("by_increase_card", (q) =>
          q.eq("increaseCardId", args.increaseCardId),
        )
        .collect();
      card = cards.find((c) => c.chapterId === chapterId) ?? null;
    }

    // Silently pre-code to the chapter's General Fund — funds are
    // backend-only (see WP-1.4), so a native Increase card charge never
    // lands fund-less waiting on a UI that no longer exists. Central has no
    // funds (`defaultFundId` returns null for it), so a central-owned charge
    // stays fund-less.
    const fundId = (await defaultFundId(ctx, chapterId)) ?? undefined;

    await ctx.db.insert("transactions", {
      chapterId,
      source: "increase_card",
      flow: args.flow,
      amountCents: args.amountCents,
      currency: args.currency ?? "usd",
      postedAt: args.postedAt,
      merchantName: args.merchantName,
      merchantCategory: args.merchantCategory,
      cardLast4: card?.last4,
      cardId: card?._id,
      personId: card?.cardholderPersonId,
      fundId,
      externalId: args.externalId,
      sourceAccountId: args.accountId,
      pending: false,
      status: "unreviewed",
      createdAt: Date.now(),
    });
    return { inserted: true, skipped: false };
  },
});

/**
 * Insert a non-card Increase account entry into the `transactions` ledger —
 * the ACCOUNT lane's pure DB apply. Same idempotency + owner-resolution
 * discipline as `applyIncreaseCardTransaction`, plus the ALREADY-BOOKED
 * guards from the module doc: activity whose `transferId` matches a payout,
 * a personal-repayment debit, or an existing transfer-leg `externalId` is
 * skipped (that money is already in the ledger under its own source).
 *
 * Rows post `flow:"inflow"`/`"outflow"` (never `"transfer"`): whether two
 * bank rows are the two legs of an internal transfer is a BOOKKEEPER call,
 * made in Reconcile via `finances.markAsTransfer` — exactly how a synced
 * Stripe FC / Relay CSV row works today. `merchantName` carries the
 * counterparty when Increase provides one; `description` keeps Increase's
 * own provider string (the UI falls back merchant → description).
 */
export const applyIncreaseAccountTransaction = internalMutation({
  args: {
    externalId: v.string(),
    accountId: v.string(),
    flow: v.union(v.literal("outflow"), v.literal("inflow")),
    amountCents: v.number(),
    currency: v.optional(v.string()),
    postedAt: v.number(),
    description: v.optional(v.string()),
    counterpartyName: v.optional(v.string()),
    // The Increase `source.category` (e.g. `inbound_ach_transfer`) — logging only.
    category: v.string(),
    // The originating transfer object's id, when the entry settles a transfer —
    // drives the already-booked guards below.
    transferId: v.optional(v.string()),
  },
  returns: v.object({ inserted: v.boolean(), skipped: v.boolean() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ inserted: boolean; skipped: boolean }> => {
    // Dedup: one ledger row per Increase transaction id.
    const existing = await ctx.db
      .query("transactions")
      .withIndex("by_external_id", (q) => q.eq("externalId", args.externalId))
      .first();
    if (existing) return { inserted: false, skipped: false };

    // Resolve the owning scope (chapter or central). Not ours → skip.
    const account = await resolveOwningAccount(ctx, args.accountId);
    if (!account) return { inserted: false, skipped: true };
    const chapterId: FinanceScope = account.chapterId;

    // ALREADY-BOOKED GUARDS — this entry settles money the app ledgered
    // through its own state machine; ingesting it too would double-count.
    if (args.transferId) {
      // 1. A reimbursement payout ACH: its expense posts as
      //    `source:"reimbursement"` when the payout settles.
      const payout = await ctx.db
        .query("payouts")
        .withIndex("by_increase_transfer", (q) =>
          q.eq("increaseTransferId", args.transferId),
        )
        .first();
      if (payout) {
        console.log(
          `[increase] account ingestion: skipping ${args.externalId} (${args.category}) — settles payout ${payout._id}`,
        );
        return { inserted: false, skipped: true };
      }
      // 2. A personal-repayment ACH debit: its offsetting credit posts as
      //    `source:"repayment"` when the repayment settles (`cards.ts`).
      const repayment = await ctx.db
        .query("personalRepayments")
        .withIndex("by_increase_ref", (q) => q.eq("increaseRef", args.transferId))
        .first();
      if (repayment) {
        console.log(
          `[increase] account ingestion: skipping ${args.externalId} (${args.category}) — settles repayment ${repayment._id}`,
        );
        return { inserted: false, skipped: true };
      }
      // 3. A historical auto-initiated transfer leg — OR a morning-engine
      //    real movement (`reconciliation.ts` stamps both legs' `externalId`
      //    with the account-transfer id right after creating it).
      const bookedLeg = await ctx.db
        .query("transactions")
        .withIndex("by_external_id", (q) => q.eq("externalId", args.transferId))
        .first();
      if (bookedLeg) {
        console.log(
          `[increase] account ingestion: skipping ${args.externalId} (${args.category}) — transfer leg already booked as ${bookedLeg._id}`,
        );
        return { inserted: false, skipped: true };
      }
    }

    // 4. A morning-engine real movement whose webhook RACED the stamp: the
    //    engine stamps the pair's legs only after `POST /account_transfers`
    //    returns, and an account transfer settles instantly — so this
    //    entry's `transaction.created` can arrive before the stamp lands.
    //    The engine puts the pair's `transferGroupId` in the transfer's
    //    description ("Chapter OS <groupId>") precisely so this guard can
    //    resolve the pair deterministically without the (not-yet-written)
    //    externalId. A matching BOOKED pair → this entry settles it → skip.
    const descMatch = args.description?.match(
      /Chapter OS ((?:payoutalloc|autosettle)-\S+)/,
    );
    if (descMatch) {
      const engineLeg = await ctx.db
        .query("transactions")
        .withIndex("by_transfer_group", (q) =>
          q.eq("transferGroupId", descMatch[1]),
        )
        .first();
      if (engineLeg) {
        console.log(
          `[increase] account ingestion: skipping ${args.externalId} (${args.category}) — settles engine pair ${descMatch[1]}`,
        );
        return { inserted: false, skipped: true };
      }
    }

    // Pre-code to the chapter's General Fund like the card lane (central has
    // no funds → stays fund-less there).
    const fundId = (await defaultFundId(ctx, chapterId)) ?? undefined;

    await ctx.db.insert("transactions", {
      chapterId,
      source: "increase_ach",
      flow: args.flow,
      amountCents: args.amountCents,
      currency: args.currency ?? "usd",
      postedAt: args.postedAt,
      description: args.description,
      merchantName: args.counterpartyName,
      fundId,
      externalId: args.externalId,
      sourceAccountId: args.accountId,
      pending: false,
      status: "unreviewed",
      createdAt: Date.now(),
    });
    return { inserted: true, skipped: false };
  },
});

/**
 * Resolve a settled card charge's `card_id` by fetching its Card Payment
 * (`GET /card_payments/{id}`), since neither `card_settlement` nor `card_refund`
 * carries `card_id` inline. Best-effort: returns null (never throws) on a missing
 * id, a 404, or any fetch/parse error — attribution then falls back to null and
 * the charge is still recorded. `cache` memoizes within a backfill run so many
 * charges on one card cost one fetch.
 */
async function resolveIncreaseCardId(
  key: string,
  base: string,
  cardPaymentId: string | undefined,
  cache?: Map<string, string | null>,
): Promise<string | null> {
  if (!cardPaymentId) return null;
  if (cache?.has(cardPaymentId)) return cache.get(cardPaymentId) ?? null;
  let cardId: string | null = null;
  try {
    const payment = await increaseGet(
      key,
      base,
      `/card_payments/${encodeURIComponent(cardPaymentId)}`,
    );
    cardId = typeof payment.card_id === "string" ? payment.card_id : null;
  } catch (err) {
    console.error(
      `[increase] card ingestion: failed to fetch card_payment ${cardPaymentId}`,
      err,
    );
    cardId = null;
  }
  cache?.set(cardPaymentId, cardId);
  return cardId;
}

/** Cheap `by_external_id` existence check, used to short-circuit a redelivered
 *  webhook BEFORE the network fetch below (avoids a wasted `GET /transactions`
 *  + `GET /card_payments` round trip for a transaction we've already ingested). */
export const transactionExistsByExternalId = internalQuery({
  args: { externalId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { externalId }) => {
    const existing = await ctx.db
      .query("transactions")
      .withIndex("by_external_id", (q) => q.eq("externalId", externalId))
      .first();
    return existing !== null;
  },
});

/** Route ONE fetched Increase Transaction into the right lane's DB apply.
 *  Shared verbatim by the webhook ingest and the backfill pager. */
async function applyFetchedTransaction(
  ctx: ActionCtx,
  txn: IncreaseTransactionLite,
  key: string,
  base: string,
  cardIdCache?: Map<string, string | null>,
): Promise<{ inserted: boolean; skipped: boolean } | null> {
  const charge = extractCardCharge(txn);
  if (charge) {
    const increaseCardId = await resolveIncreaseCardId(
      key,
      base,
      charge.cardPaymentId,
      cardIdCache,
    );
    return await ctx.runMutation(
      internal.increaseLedger.applyIncreaseCardTransaction,
      {
        externalId: charge.externalId,
        accountId: charge.accountId,
        flow: charge.flow,
        amountCents: charge.amountCents,
        currency: (txn.currency ?? "usd").toLowerCase(),
        postedAt: charge.postedAt,
        merchantName: charge.merchantName,
        merchantCategory: charge.merchantCategory,
        increaseCardId: increaseCardId ?? undefined,
      },
    );
  }
  const activity = extractAccountActivity(txn);
  if (activity) {
    return await ctx.runMutation(
      internal.increaseLedger.applyIncreaseAccountTransaction,
      {
        externalId: activity.externalId,
        accountId: activity.accountId,
        flow: activity.flow,
        amountCents: activity.amountCents,
        currency: (txn.currency ?? "usd").toLowerCase(),
        postedAt: activity.postedAt,
        description: activity.description,
        counterpartyName: activity.counterpartyName,
        category: activity.category,
        transferId: activity.transferId,
      },
    );
  }
  return null; // un-postable (missing id/account/amount, or $0)
}

/**
 * Fetch a `transaction.created` object and post it to the ledger (card OR
 * account lane). Best-effort (never throws): fetches `GET /transactions/{id}`,
 * extracts, and applies (idempotent on `externalId`). Routed by the object
 * id's `sandbox_` prefix like the rest of the family. Degrades to a logged
 * no-op when the environment's key is unset or a fetch fails.
 *
 * IMPORTANT — never throws. This is called from `increase.handleIncreaseWebhook`,
 * which runs AFTER `recordWebhookEvent` has already committed the event-dedup
 * row in a separate, already-committed step (see `apps/convex/webhooks.ts`).
 * If this function threw, Increase's retry would be dead-on-arrival — the
 * event id already reads as "processed" — and that entry would be silently
 * dropped with no trace. Every fallible step (the transaction fetch,
 * extraction, and the DB apply) is therefore individually guarded; on any
 * error we log (with the transaction id) and return. The daily
 * `backfillIncreaseTransactions` cron (see `crons.ts`) is the reconciliation
 * backstop for anything a swallowed error here would otherwise lose forever.
 */
export async function ingestIncreaseTransaction(
  ctx: ActionCtx,
  transactionId: string,
): Promise<void> {
  const { key, base } = increaseEnvForObjectId(transactionId);
  if (!key) {
    console.warn(
      "[increase] ingestion skipped: Increase API key not configured for this environment",
    );
    return;
  }

  // Dedup BEFORE the network fetch — a redelivered webhook for an
  // already-ingested transaction short-circuits without a wasted round trip.
  const alreadyIngested = await ctx.runQuery(
    internal.increaseLedger.transactionExistsByExternalId,
    { externalId: transactionId },
  );
  if (alreadyIngested) return;

  let txn: IncreaseTransactionLite;
  try {
    txn = (await increaseGet(
      key,
      base,
      `/transactions/${encodeURIComponent(transactionId)}`,
    )) as IncreaseTransactionLite;
  } catch (err) {
    console.error("[increase] ingestion: failed to fetch transaction", err);
    return;
  }

  try {
    await applyFetchedTransaction(ctx, txn, key, base);
  } catch (err) {
    // Never throw out of the webhook: recordWebhookEvent already committed the
    // event-dedup row in a separate step, so a throw here would make this
    // entry unrecoverable (Increase's retry reads the event as "processed").
    // The daily backfill cron reconciles anything lost here.
    console.error(
      `[increase] ingestion: failed to apply transaction ${transactionId}`,
      err,
    );
  }
}

// ── Backfill: page GET /transactions?account_id=… into the ledger ────────────

/** Active Increase accounts (id + owning scope) for the backfill to page.
 *  INCLUDES `"central"` (the City Launch Fund's own account): its non-card
 *  account activity — inbound transfers, fees, interest — belongs in the
 *  central Reconcile queue like any chapter's does. (It was excluded while
 *  only card charges were ingested — central issues no member cards, so
 *  paging it was a pointless API sweep back then.) */
export const listProvisionedIncreaseAccounts = internalQuery({
  args: {},
  returns: v.array(v.object({ increaseAccountId: v.string() })),
  handler: async (ctx) => {
    const rows = await ctx.db.query("increaseAccounts").collect();
    return rows
      .filter((a) => a.onboardingStatus === "active" && !!a.increaseAccountId)
      .map((a) => ({ increaseAccountId: a.increaseAccountId! }));
  },
});

/** A per-account page cap (each page is up to INCREASE_PAGE_SIZE rows). Bounds a
 *  single ops run; a genuinely huge account can be re-run to continue (dedup). */
const INCREASE_BACKFILL_MAX_PAGES = 200;
const INCREASE_PAGE_SIZE = 100;

/**
 * Ops backfill: page `GET /transactions?account_id=…` to completion for each
 * provisioned Increase account (chapters AND central) and post every settled
 * entry — card charges/refunds into the card lane, everything else into the
 * account lane — into the `transactions` ledger (dedup on `externalId`).
 * Mirrors the Stripe FC backfill (`stripeFinance.syncTransactions`) — Increase
 * lists are cursor-paginated (`{ data, next_cursor }`, `cursor` query param).
 * Card attribution reuses the Card Payment lookup with a per-run cache.
 * Environment is routed per account by its `sandbox_` id prefix. Logs the
 * inserted count. Best-effort: an account whose environment key is unset, or a
 * fetch error, logs + moves on (never throws).
 *
 * Runs DAILY as the "increase transaction reconciliation backstop" cron
 * (`crons.ts`) and ONCE post-deploy via migration
 * `0057_backfill_increase_transactions` (pulling in the account history the
 * card-only ingestion skipped). CLI/CI-runnable (internal → not publicly
 * callable):
 *   npx convex run increaseLedger:backfillIncreaseTransactions
 *   gh workflow run run-convex-function.yml -f function=increaseLedger:backfillIncreaseTransactions
 * Optionally scope to one account: `-f args='{"increaseAccountId":"account_…"}'`.
 */
export const backfillIncreaseTransactions = internalAction({
  args: { increaseAccountId: v.optional(v.string()) },
  returns: v.object({
    accounts: v.number(),
    scanned: v.number(),
    inserted: v.number(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ accounts: number; scanned: number; inserted: number }> => {
    const accountIds = args.increaseAccountId
      ? [args.increaseAccountId]
      : (
          await ctx.runQuery(
            internal.increaseLedger.listProvisionedIncreaseAccounts,
            {},
          )
        ).map((a) => a.increaseAccountId);

    let scanned = 0;
    let inserted = 0;
    let accountsProcessed = 0;
    // Memoize card_payment_id → card_id across the whole run (many charges share
    // a card / card payment).
    const cardIdCache = new Map<string, string | null>();

    for (const accountId of accountIds) {
      const { key, base } = increaseEnvForObjectId(accountId);
      if (!key) {
        console.warn(
          `[increase] backfill skipped account ${accountId}: no API key for its environment`,
        );
        continue;
      }
      accountsProcessed += 1;

      let cursor: string | undefined = undefined;
      for (let page = 0; page < INCREASE_BACKFILL_MAX_PAGES; page++) {
        const params = new URLSearchParams();
        params.set("account_id", accountId);
        params.set("limit", String(INCREASE_PAGE_SIZE));
        if (cursor) params.set("cursor", cursor);

        let body: {
          data?: IncreaseTransactionLite[];
          next_cursor?: string | null;
        };
        try {
          const res = await fetch(`${base}/transactions?${params.toString()}`, {
            method: "GET",
            headers: { Authorization: `Bearer ${key}` },
          });
          if (!res.ok) {
            console.error(
              `[increase] backfill: list failed for ${accountId}:`,
              await res.text(),
            );
            break;
          }
          body = (await res.json()) as {
            data?: IncreaseTransactionLite[];
            next_cursor?: string | null;
          };
        } catch (err) {
          console.error(
            `[increase] backfill: list error for ${accountId}:`,
            err,
          );
          break;
        }

        const rows = body.data ?? [];
        for (const row of rows) {
          scanned += 1;
          try {
            const result = await applyFetchedTransaction(
              ctx,
              row,
              key,
              base,
              cardIdCache,
            );
            if (result?.inserted) inserted += 1;
          } catch (err) {
            // One bad row must not abort the whole account's sweep — the
            // daily re-run picks up anything left behind (dedup makes that
            // safe).
            console.error(
              `[increase] backfill: failed to apply ${row.id ?? "<unknown>"}:`,
              err,
            );
          }
        }

        cursor = body.next_cursor ?? undefined;
        if (!cursor || rows.length === 0) break;
      }
    }

    console.log(
      `[increase] transaction backfill complete: ${accountsProcessed} account(s), scanned ${scanned}, inserted ${inserted}`,
    );
    return { accounts: accountsProcessed, scanned, inserted };
  },
});
