/**
 * MORNING RECONCILIATION ENGINE — Stripe payout allocation + daily cross-book
 * settlement, so every book reflects its true value by morning instead of a
 * human being told "transfers need to be made" (owner request, 2026-08-07 —
 * the completion of 2026-08-05's "we can calculate in the backend what
 * transfers need to be made").
 *
 * WHAT IT DOES, each morning (cron, `crons.ts`) and on `payout.paid` webhooks:
 *
 *  1. PAYOUT DETECTION. Polls `GET /v1/payouts` for payouts arriving at/after
 *     `financeSettings.autoReconciliationSinceMs` and upserts one
 *     `stripePayouts` row per payout (idempotent on the `po_…` id).
 *
 *  2. PAYOUT ALLOCATION. For each paid, not-yet-allocated payout it pages the
 *     payout's balance transactions (`GET /v1/balance_transactions?payout=…`,
 *     `expand[]=data.source`), traces every charge/refund back to the record
 *     that earned it — ticket order / event donation / one-time give gift /
 *     pledge cycle / personal-charge repayment — and books ONE central↔chapter
 *     transfer pair per chapter for its net share (net of Stripe's fees),
 *     `transferOrigin:"payout_allocation"`. The payout lands physically in
 *     central's bank account; these pairs move each chapter's earned revenue
 *     onto its own book. Deterministic `transferGroupId`s
 *     (`payoutalloc-<po>-<scope>`) + `recordTransferPair`'s ALREADY_RECORDED
 *     guard make re-runs book nothing twice. Untraceable money stays on
 *     central's book, counted LOUDLY in `stripePayouts.unmappedNetCents`;
 *     repayment cash returns also stay central (the chapter book was already
 *     credited at settle — `cards.ts` — so allocating again would double-count).
 *     Allocation is all-or-nothing per payout: a payout too large to page
 *     within bounds marks itself `failed` rather than half-allocating.
 *
 *  3. DEPOSIT MATCHING ("detect when payouts are done"). Looks for the payout's
 *     bank deposit among central's ingested rows (increase_ach / stripe_fc /
 *     relay_csv inflow, same amount, near the arrival date, STRIPE in the
 *     statement text) and labels it `payoutProcessor:"stripe"` +
 *     `stripePayoutId` — the same label a treasurer used to apply by hand via
 *     `finances.markAsPayout`. Retries every run until the deposit syncs in.
 *
 *  4. AUTO SETTLEMENT. Books one `auto_settlement` pair per chapter with a
 *     nonzero `interScopeBalances` net (cross-book card spend: "your card
 *     determines whose account paid; reconcile determines whose budget it
 *     was") — deterministic per Eastern day (`autosettle-<chapter>-<date>`).
 *
 *  5. BANK-BALANCE SNAPSHOT. Best-effort refresh of each provisioned Increase
 *     account's cached `balanceCents` for the accounts page. Display only.
 *
 * WHAT IT NEVER DOES: move real money. Every write is a ledger entry; the
 * money-gating rule (movement requires human initiation) is untouched. The
 * physical cash keeps pooling wherever Stripe pays out; the LEDGER is what
 * states each book's true value, and that's what this engine keeps honest.
 *
 * SAFETY PROPERTIES:
 *  - Idempotent everywhere: deterministic transfer group ids, `stripePayouts`
 *    keyed on the payout id, webhook dedup via `webhookEvents`.
 *  - Forward-only by default: the first run stamps
 *    `autoReconciliationSinceMs = now`, so deploying this never retroactively
 *    books transfers against months of already-hand-coded history. The FM can
 *    move the start date back deliberately (`setReconciliationStart`).
 *  - Pausable: `financeSettings.autoReconciliationPaused` (accounts page).
 *  - Auditable: every run writes a `reconciliationRuns` row; every engine pair
 *    carries `transferOrigin`; the FM can flag any pair/payout
 *    (`reconciliationFlags`) and the fix is an offsetting entry per
 *    docs/plans/transfers-ops-notes.md — the engine's rows are never edited.
 *  - Readers that treat transfers as HUMAN money decisions exclude engine
 *    rows: the City Launch Fund position skips both origins
 *    (`finances.ts#dashboardCentral`), and `interScopeBalances`' settling
 *    legs skip `payout_allocation` (`transfers.ts#chapterInterScopeRows`).
 *
 * House patterns: REST via `fetch` (no SDK, no "use node" — matches
 * `stripe.ts`); network fetch separated from DB apply so the money math is
 * testable without Stripe (`applyPayoutAllocation` / `runAutoSettlement` are
 * pure DB mutations tests drive with fixture items); best-effort sweeps that
 * log + continue; every bound named and warned on.
 */
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  CENTRAL,
  PAYOUT_ITEM_KINDS,
  STRIPE_PAYOUT_PROCESS_STATES,
  RECONCILIATION_FLAG_KINDS,
  type PayoutItemKind,
} from "@events-os/shared";
import {
  recordTransferPair,
  transferScopes,
  loadInterScopeContext,
  loadChapterOwesCentralRows,
  chapterInterScopeRows,
  sumAllCents,
  type TransferDirection,
} from "./transfers";
import { readSandbox } from "./financeSettings";
import { requireUserId } from "./lib/context";
import { type FinanceScope } from "./lib/finance";
import {
  hasReconciliationAudit,
  requireReconciliationAudit,
} from "./lib/reconciliationAccess";
import { signedBookCents } from "./lib/bookBalance";
import { increaseEnvForObjectId, increaseGet } from "./lib/increaseApi";
import { ROLLUP_SCAN_LIMIT, txnMatchesMode } from "./finances";

const STRIPE_API = "https://api.stripe.com/v1";

/** Stripe list page size (their maximum). */
const STRIPE_PAGE_SIZE = 100;
/** Payout-list pages per run — 1,000 payouts/run is far beyond a daily sweep. */
const MAX_PAYOUT_PAGES = 10;
/** Balance-transaction pages per payout. A payout larger than this
 *  (1,000 items) marks itself `failed` instead of HALF-allocating. */
const MAX_BALANCE_TXN_PAGES = 10;
/** Cap on per-run human-readable notes so a run row never grows unbounded. */
const MAX_RUN_NOTES = 40;
/** Deposit-match window around Stripe's arrival_date. */
const DAY_MS = 24 * 60 * 60 * 1000;
const DEPOSIT_MATCH_BEFORE_MS = 2 * DAY_MS;
const DEPOSIT_MATCH_AFTER_MS = 5 * DAY_MS;
/** A `running` run row younger than this blocks a concurrent second run
 *  (webhook racing the cron); older ones are presumed crashed and superseded. */
const RUN_LOCK_MS = 15 * 60 * 1000;
/** Recent-payout window for the accounts-page overview. */
const OVERVIEW_PAYOUT_LIMIT = 15;
/** Transfer-history rows per page on the accounts page. */
const HISTORY_DEFAULT_LIMIT = 25;
const HISTORY_MAX_LIMIT = 100;

/** `YYYY-MM-DD` in America/New_York — the org's "which day is it" for the
 *  deterministic daily settlement group id (same one-liner as
 *  `transfers.ts#easternDateStrLocal`). */
function easternDateStr(ts: number): string {
  return new Date(ts).toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}

// ── Validators shared by the engine's internal plumbing ──────────────────────

const financeScopeValidator = v.union(v.id("chapters"), v.literal("central"));

/** One payout item (one Stripe balance transaction) as the ACTION hands it to
 *  the DB-apply mutation: signed cents + the tracing keys the mutation
 *  resolves against our own records. The action does the network; the
 *  mutation does the money — the testable seam. */
const payoutItemValidator = v.object({
  // Signed cents from Stripe: gross amount, Stripe's fee, and net (= amount −
  // fee). Charges positive, refunds negative.
  grossCents: v.number(),
  feeCents: v.number(),
  netCents: v.number(),
  // Tracing keys, best-effort extracted by the action:
  invoiceId: v.optional(v.string()), // charge.invoice → a pledge cycle's gift
  sessionId: v.optional(v.string()), // the Checkout Session behind the charge
  // The session's (or charge's) metadata — where our own ids live
  // (`orderId`, `donationId`, `giveDonation`/`giveDonorId`, `repaymentIds`,
  // `pledgeId` — see `http.ts`'s webhook fan-out, which keys on the same).
  metadata: v.optional(v.record(v.string(), v.string())),
  // True when this item is a refund/dispute reversal of one of the above.
  isReversal: v.optional(v.boolean()),
});
type PayoutItem = typeof payoutItemValidator.type;

const allocationEntryValidator = v.object({
  scope: financeScopeValidator,
  grossCents: v.number(),
  feeCents: v.number(),
  netCents: v.number(),
  itemCount: v.number(),
  transferGroupId: v.optional(v.string()),
});

// ── Settings + run bookkeeping (internal) ────────────────────────────────────

/** Engine settings the action needs before doing anything. */
export const engineSettings = internalQuery({
  args: {},
  returns: v.object({
    paused: v.boolean(),
    sinceMs: v.union(v.number(), v.null()),
  }),
  handler: async (ctx) => {
    const settings = await ctx.db.query("financeSettings").first();
    return {
      paused: settings?.autoReconciliationPaused ?? false,
      sinceMs: settings?.autoReconciliationSinceMs ?? null,
    };
  },
});

/**
 * Stamp `autoReconciliationSinceMs = now` iff unset, and return the effective
 * value. Called by the engine's first run so deploying the feature is
 * FORWARD-ONLY: months of already-hand-coded payout history never get
 * retroactively allocated by surprise. Backdating is a deliberate FM action
 * (`setReconciliationStart`).
 */
export const ensureSince = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx): Promise<number> => {
    const existing = await ctx.db.query("financeSettings").first();
    if (existing?.autoReconciliationSinceMs != null) {
      return existing.autoReconciliationSinceMs;
    }
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { autoReconciliationSinceMs: now });
    } else {
      await ctx.db.insert("financeSettings", {
        sandboxMode: false,
        updatedAt: now,
        autoReconciliationSinceMs: now,
      });
    }
    return now;
  },
});

/**
 * Open a run row, refusing when another run is still live (a webhook-triggered
 * run racing the morning cron). A `running` row older than `RUN_LOCK_MS` is
 * presumed crashed (its action died without reaching `finishRun`) and is
 * closed out as `error` so the new run can proceed — the engine is idempotent,
 * so re-covering a crashed run's ground is safe.
 */
export const beginRun = internalMutation({
  args: {
    trigger: v.union(
      v.literal("cron"),
      v.literal("manual"),
      v.literal("webhook"),
    ),
  },
  returns: v.union(v.id("reconciliationRuns"), v.null()),
  handler: async (ctx, { trigger }) => {
    const now = Date.now();
    const recent = await ctx.db
      .query("reconciliationRuns")
      .withIndex("by_startedAt", (q) => q.gte("startedAt", now - RUN_LOCK_MS))
      .collect();
    const live = recent.find((r) => r.status === "running");
    if (live) return null;
    // Close out any crashed older runs (bounded: only ones we can still see
    // cheaply — a run that crashed long ago was closed by a later pass).
    const stale = await ctx.db
      .query("reconciliationRuns")
      .withIndex("by_startedAt", (q) => q.lt("startedAt", now - RUN_LOCK_MS))
      .order("desc")
      .take(5);
    for (const run of stale) {
      if (run.status === "running") {
        await ctx.db.patch(run._id, {
          status: "error",
          finishedAt: now,
          error: "Run never finished (engine action died); superseded.",
        });
      }
    }
    return await ctx.db.insert("reconciliationRuns", {
      trigger,
      status: "running",
      startedAt: now,
      payoutsProcessed: 0,
      transfersBooked: 0,
      settlementsBooked: 0,
      allocatedCents: 0,
      notes: [],
    });
  },
});

export const finishRun = internalMutation({
  args: {
    runId: v.id("reconciliationRuns"),
    status: v.union(v.literal("ok"), v.literal("error"), v.literal("skipped")),
    payoutsProcessed: v.number(),
    transfersBooked: v.number(),
    settlementsBooked: v.number(),
    allocatedCents: v.number(),
    notes: v.array(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, {
      status: args.status,
      finishedAt: Date.now(),
      payoutsProcessed: args.payoutsProcessed,
      transfersBooked: args.transfersBooked,
      settlementsBooked: args.settlementsBooked,
      allocatedCents: args.allocatedCents,
      notes: args.notes.slice(0, MAX_RUN_NOTES),
      ...(args.error ? { error: args.error } : {}),
    });
    return null;
  },
});

// ── Payout detection (internal) ──────────────────────────────────────────────

/**
 * Upsert one detected payout. Idempotent on the `po_…` id; never downgrades
 * `processState` (an `allocated` payout stays allocated on redelivery — only
 * its `stripeStatus` refreshes). Returns the row's current processing state so
 * the action knows whether allocation is still owed. A payout whose Stripe
 * status flips to failed/canceled AFTER we allocated gets an automatic audit
 * flag — its booked pairs likely need offsetting entries.
 */
export const upsertDetectedPayout = internalMutation({
  args: {
    stripePayoutId: v.string(),
    amountCents: v.number(),
    currency: v.string(),
    stripeStatus: v.string(),
    arrivalDate: v.number(),
  },
  returns: v.object({
    processState: v.union(
      ...STRIPE_PAYOUT_PROCESS_STATES.map((s) => v.literal(s)),
    ),
    stripeStatus: v.string(),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("stripePayouts")
      .withIndex("by_stripe_payout", (q) =>
        q.eq("stripePayoutId", args.stripePayoutId),
      )
      .unique();
    if (!existing) {
      await ctx.db.insert("stripePayouts", {
        stripePayoutId: args.stripePayoutId,
        amountCents: args.amountCents,
        currency: args.currency,
        stripeStatus: args.stripeStatus,
        arrivalDate: args.arrivalDate,
        processState: "pending",
        createdAt: now,
        updatedAt: now,
      });
      return { processState: "pending" as const, stripeStatus: args.stripeStatus };
    }
    const failedAfterAllocation =
      existing.processState === "allocated" &&
      (args.stripeStatus === "failed" || args.stripeStatus === "canceled") &&
      existing.stripeStatus !== args.stripeStatus;
    await ctx.db.patch(existing._id, {
      amountCents: args.amountCents,
      currency: args.currency,
      stripeStatus: args.stripeStatus,
      arrivalDate: args.arrivalDate,
      updatedAt: now,
    });
    if (failedAfterAllocation) {
      // Loud: the transfers we booked distribute money that never arrived.
      // A system flag (createdBy absent isn't allowed — flags are FM-authored;
      // use the run notes instead) would be nicer, but the flag table requires
      // an author, so the payout row itself carries the error and the
      // accounts page surfaces any `failed`-status Stripe payout prominently.
      await ctx.db.patch(existing._id, {
        error: `Stripe reports this payout ${args.stripeStatus} AFTER its allocation transfers were booked — record offsetting entries (docs/plans/transfers-ops-notes.md).`,
      });
    }
    return {
      processState: existing.processState,
      stripeStatus: args.stripeStatus,
    };
  },
});

export const markPayoutFailed = internalMutation({
  args: { stripePayoutId: v.string(), error: v.string() },
  returns: v.null(),
  handler: async (ctx, { stripePayoutId, error }) => {
    const row = await ctx.db
      .query("stripePayouts")
      .withIndex("by_stripe_payout", (q) =>
        q.eq("stripePayoutId", stripePayoutId),
      )
      .unique();
    // Never downgrade an allocated payout to failed — a late error (e.g. a
    // deposit-match hiccup) is not an allocation failure.
    if (row && row.processState !== "allocated") {
      await ctx.db.patch(row._id, {
        processState: "failed",
        error,
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

// ── Payout allocation (internal — THE money math, network-free) ──────────────

/** The deterministic transfer group id for one payout × one chapter — the
 *  idempotency key that makes re-allocation impossible to double-book. */
function payoutAllocationGroupId(
  stripePayoutId: string,
  scope: FinanceScope,
): string {
  return `payoutalloc-${stripePayoutId}-${scope}`;
}

/** Resolve one payout item to the book that earned it. Returns the item kind
 *  (for the audit rollup) and the scope — or `null` scope for items that stay
 *  on central's book (repayments, unmapped). */
async function resolvePayoutItemScope(
  ctx: MutationCtx,
  item: PayoutItem,
): Promise<{ kind: PayoutItemKind; scope: FinanceScope | null }> {
  const meta = item.metadata ?? {};
  const reversal = item.isReversal === true;
  const asKind = (kind: PayoutItemKind): PayoutItemKind =>
    reversal ? "refund" : kind;

  // A subscription (backer pledge) cycle: the charge carries its invoice, and
  // `invoice.paid` recorded exactly one gift per invoice (`gifts.by_stripeInvoice`).
  if (item.invoiceId) {
    const gift = await ctx.db
      .query("gifts")
      .withIndex("by_stripeInvoice", (q) =>
        q.eq("stripeInvoiceId", item.invoiceId),
      )
      .first();
    if (gift) return { kind: asKind("pledge_cycle"), scope: gift.scope };
  }

  // A ticket order (the session's `metadata.orderId` is our own doc id).
  if (meta.orderId) {
    const orderId = ctx.db.normalizeId("ticketOrders", meta.orderId);
    const order = orderId ? await ctx.db.get(orderId) : null;
    if (order) return { kind: asKind("ticket_order"), scope: order.chapterId };
  }

  // An event-page donation.
  if (meta.donationId) {
    const donationId = ctx.db.normalizeId("donations", meta.donationId);
    const donation = donationId ? await ctx.db.get(donationId) : null;
    if (donation) {
      return { kind: asKind("event_donation"), scope: donation.chapterId };
    }
  }

  // A one-time /give gift: settle wrote a gift keyed `give:<sessionId>`
  // (`givingDonations.recordGiveDonationPaid`); its scope is the book that
  // gift belongs to. Fall back to the donor's scope when the gift is missing
  // (e.g. the webhook was dropped and only the charge exists).
  if (meta.giveDonation === "1") {
    if (item.sessionId) {
      const gift = await ctx.db
        .query("gifts")
        .withIndex("by_externalRef", (q) =>
          q.eq("externalRef", `give:${item.sessionId}`),
        )
        .first();
      if (gift) return { kind: asKind("give_donation"), scope: gift.scope };
    }
    const donorId = meta.giveDonorId
      ? ctx.db.normalizeId("donors", meta.giveDonorId)
      : null;
    const donor = donorId ? await ctx.db.get(donorId) : null;
    if (donor) return { kind: asKind("give_donation"), scope: donor.scope };
  }

  // A backer's FIRST subscription charge sometimes reaches us with the
  // session metadata (pledgeId) rather than an invoice id.
  if (meta.pledgeId) {
    const pledgeId = ctx.db.normalizeId("pledges", meta.pledgeId);
    const pledge = pledgeId ? await ctx.db.get(pledgeId) : null;
    if (pledge) return { kind: asKind("pledge_cycle"), scope: pledge.scope };
  }

  // A personal-charge repayment: cash returning to the org. The chapter's
  // book was ALREADY credited at settle (`cards.ts`'s offsetting
  // `source:"repayment"` credit), so allocating this again would double-count
  // — it stays on central's book (where the cash physically lands) and is
  // reported in `repaymentNetCents`.
  if (meta.repaymentIds) {
    return { kind: "repayment", scope: null };
  }

  return { kind: "unmapped", scope: null };
}

/**
 * THE payout money math — pure DB, driven by the action with fetched items
 * (tests drive it with fixtures). Resolves every item to its book, aggregates
 * per-scope nets, books one transfer pair per chapter with a nonzero net
 * (positive → central_to_chapter, negative → chapter_to_central), attempts
 * the deposit match, and stamps the `stripePayouts` row `allocated`.
 *
 * Idempotent: deterministic group ids + the ALREADY_RECORDED guard mean a
 * re-run (crashed action, webhook redelivery, FM "run now") books nothing
 * twice — it just refreshes the payout row's summary from the same math.
 */
export const applyPayoutAllocation = internalMutation({
  args: {
    stripePayoutId: v.string(),
    items: v.array(payoutItemValidator),
  },
  returns: v.object({
    transfersBooked: v.number(),
    allocatedCents: v.number(),
    depositMatched: v.boolean(),
    unmappedNetCents: v.number(),
  }),
  handler: async (ctx, { stripePayoutId, items }) => {
    const payout = await ctx.db
      .query("stripePayouts")
      .withIndex("by_stripe_payout", (q) =>
        q.eq("stripePayoutId", stripePayoutId),
      )
      .unique();
    if (!payout) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: `No detected payout ${stripePayoutId} — upsert it first.`,
      });
    }

    // Resolve + aggregate. Map key is the scope string (chapter id or the
    // central sentinel) — bounded by the number of scopes, not payout size.
    const byScope = new Map<
      FinanceScope,
      { grossCents: number; feeCents: number; netCents: number; itemCount: number }
    >();
    const kindCounts: Record<string, number> = {};
    for (const kind of PAYOUT_ITEM_KINDS) kindCounts[kind] = 0;
    let unmappedNetCents = 0;
    let repaymentNetCents = 0;

    for (const item of items) {
      const { kind, scope } = await resolvePayoutItemScope(ctx, item);
      kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
      if (scope == null) {
        if (kind === "repayment") repaymentNetCents += item.netCents;
        else unmappedNetCents += item.netCents;
        continue;
      }
      const bucket = byScope.get(scope) ?? {
        grossCents: 0,
        feeCents: 0,
        netCents: 0,
        itemCount: 0,
      };
      bucket.grossCents += item.grossCents;
      bucket.feeCents += item.feeCents;
      bucket.netCents += item.netCents;
      bucket.itemCount += 1;
      byScope.set(scope, bucket);
    }

    // Book one pair per CHAPTER with a nonzero net. Central's own share needs
    // no pair — the deposit already lands on central's book.
    let transfersBooked = 0;
    let allocatedCents = 0;
    const allocation: (typeof allocationEntryValidator.type)[] = [];
    for (const [scope, bucket] of byScope) {
      const entry = { scope, ...bucket } as typeof allocationEntryValidator.type;
      if (scope !== CENTRAL && bucket.netCents !== 0) {
        const direction: TransferDirection =
          bucket.netCents > 0 ? "central_to_chapter" : "chapter_to_central";
        const { sourceScope, destScope } = transferScopes(
          scope as Id<"chapters">,
          direction,
        );
        const transferGroupId = payoutAllocationGroupId(stripePayoutId, scope);
        const amountCents = Math.abs(bucket.netCents);
        try {
          await recordTransferPair(ctx, {
            sourceScope,
            destScope,
            amountCents,
            transferGroupId,
            postedAt: payout.arrivalDate,
            note: `Auto: allocation of Stripe payout ${stripePayoutId} (${bucket.itemCount} item${bucket.itemCount === 1 ? "" : "s"}, net of fees)`,
            transferDirection: direction,
            transferOrigin: "payout_allocation",
          });
          transfersBooked += 1;
          allocatedCents += amountCents;
        } catch (err) {
          // ALREADY_RECORDED = an earlier run booked this exact allocation —
          // the idempotent re-run case, not an error. Anything else is real.
          if (!(err instanceof ConvexError) || err.data?.code !== "ALREADY_RECORDED") {
            throw err;
          }
        }
        entry.transferGroupId = transferGroupId;
      }
      allocation.push(entry);
    }
    // Stable order for display: central first, then by scope key.
    allocation.sort((a, b) =>
      a.scope === CENTRAL ? -1 : b.scope === CENTRAL ? 1 : a.scope < b.scope ? -1 : 1,
    );

    // Deposit match — see the module doc. Skipped once matched.
    let depositMatched = payout.matchedTransactionId != null;
    if (!depositMatched) {
      const matched = await matchPayoutDeposit(ctx, payout);
      depositMatched = matched != null;
      if (matched) {
        await ctx.db.patch(payout._id, { matchedTransactionId: matched });
      }
    }

    await ctx.db.patch(payout._id, {
      processState: "allocated",
      allocation,
      itemKindCounts: kindCounts,
      unmappedNetCents,
      repaymentNetCents,
      error: undefined,
      updatedAt: Date.now(),
    });

    return { transfersBooked, allocatedCents, depositMatched, unmappedNetCents };
  },
});

/**
 * Find the central bank deposit row for a payout: an ingested inflow on
 * central's book (increase_ach / stripe_fc / relay_csv — the three bank
 * feeds), same amount, posted within the arrival window, STRIPE in the
 * statement text, not already claimed by another payout. Labels it exactly
 * like `finances.markAsPayout` would (`payoutProcessor:"stripe"`, LABEL only
 * — the row stays `flow:"inflow"`; see `PAYOUT_PROCESSORS`' doc) plus the
 * `stripePayoutId` link, and lifts an `unreviewed` row to `categorized`
 * (machine-coded; a human still owns Reconciled). Returns the matched row id
 * or null.
 */
async function matchPayoutDeposit(
  ctx: MutationCtx,
  payout: Doc<"stripePayouts">,
): Promise<Id<"transactions"> | null> {
  const BANK_FEEDS = new Set(["increase_ach", "stripe_fc", "relay_csv"]);
  const candidates = await ctx.db
    .query("transactions")
    .withIndex("by_chapter_and_postedAt", (q) =>
      q
        .eq("chapterId", CENTRAL)
        .gte("postedAt", payout.arrivalDate - DEPOSIT_MATCH_BEFORE_MS)
        .lte("postedAt", payout.arrivalDate + DEPOSIT_MATCH_AFTER_MS),
    )
    .collect();
  const looksLikeStripe = (tr: Doc<"transactions">): boolean => {
    const text = `${tr.merchantName ?? ""} ${tr.description ?? ""}`.toLowerCase();
    return text.includes("stripe");
  };
  const match = candidates.find(
    (tr) =>
      tr.flow === "inflow" &&
      BANK_FEEDS.has(tr.source) &&
      tr.amountCents === payout.amountCents &&
      tr.stripePayoutId == null &&
      looksLikeStripe(tr),
  );
  if (!match) return null;
  await ctx.db.patch(match._id, {
    payoutProcessor: "stripe",
    stripePayoutId: payout.stripePayoutId,
    ...(match.status === "unreviewed" ? { status: "categorized" as const } : {}),
  });
  return match._id;
}

// ── Auto settlement (internal — network-free) ────────────────────────────────

/**
 * Book the day's `auto_settlement` pair for every chapter whose
 * `interScopeBalances` net is nonzero — the same math the query shows,
 * settled by the engine instead of waiting for a human (owner request; see
 * the consent-semantics note on `transfers.ts#interScopeBalances`).
 * Deterministic per Eastern day: at most one settlement pair per chapter per
 * day, and a re-run recomputes a net the earlier booking already zeroed, so
 * it books nothing.
 */
export const runAutoSettlement = internalMutation({
  args: { dateStr: v.string() },
  returns: v.object({
    settlementsBooked: v.number(),
    settledCents: v.number(),
  }),
  handler: async (ctx, { dateStr }) => {
    const sandboxMode = await readSandbox(ctx);
    const { centralBudgetIds, chapters } = await loadInterScopeContext(ctx);
    const chapterOwesCentralRowsByChapter = await loadChapterOwesCentralRows(
      ctx,
      centralBudgetIds,
      sandboxMode,
    );

    let settlementsBooked = 0;
    let settledCents = 0;
    for (const chapter of chapters) {
      const chapterTxns = await ctx.db
        .query("transactions")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapter._id))
        .take(ROLLUP_SCAN_LIMIT);
      if (chapterTxns.length === ROLLUP_SCAN_LIMIT) {
        // A truncated read could compute a WRONG net — booking a transfer on
        // it would corrupt the books, so skip the chapter loudly instead.
        console.warn(
          `[reconciliation] auto-settlement skipped chapter ${chapter._id}: transaction scan hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}).`,
        );
        continue;
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
      if (netCents === 0) continue;

      const direction: TransferDirection =
        netCents > 0 ? "central_to_chapter" : "chapter_to_central";
      const { sourceScope, destScope } = transferScopes(chapter._id, direction);
      const transferGroupId = `autosettle-${chapter._id}-${dateStr}`;
      try {
        await recordTransferPair(ctx, {
          sourceScope,
          destScope,
          amountCents: Math.abs(netCents),
          transferGroupId,
          postedAt: Date.now(),
          note: `Auto: settlement of cross-book card spend through ${dateStr}`,
          transferDirection: direction,
          transferOrigin: "auto_settlement",
        });
        settlementsBooked += 1;
        settledCents += Math.abs(netCents);
      } catch (err) {
        // Already settled today (manual re-run after the cron) — fine.
        if (!(err instanceof ConvexError) || err.data?.code !== "ALREADY_RECORDED") {
          throw err;
        }
      }
    }
    return { settlementsBooked, settledCents };
  },
});

// ── Bank-balance snapshot (internal) ─────────────────────────────────────────

/** Provisioned Increase accounts with their row ids, for the snapshot step. */
export const listAccountsForSnapshot = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      accountRowId: v.id("increaseAccounts"),
      increaseAccountId: v.string(),
    }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db.query("increaseAccounts").collect();
    return rows
      .filter((a) => a.onboardingStatus === "active" && !!a.increaseAccountId)
      .map((a) => ({
        accountRowId: a._id,
        increaseAccountId: a.increaseAccountId!,
      }));
  },
});

export const saveAccountBalance = internalMutation({
  args: {
    accountRowId: v.id("increaseAccounts"),
    balanceCents: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { accountRowId, balanceCents }) => {
    await ctx.db.patch(accountRowId, {
      balanceCents,
      balanceAsOf: Date.now(),
      updatedAt: Date.now(),
    });
    return null;
  },
});

// ── Stripe fetch helpers (action-side) ───────────────────────────────────────

interface StripePayoutObject {
  id: string;
  amount?: number;
  currency?: string;
  status?: string;
  arrival_date?: number; // unix seconds
}

interface StripeBalanceTxn {
  id: string;
  type?: string;
  amount?: number;
  fee?: number;
  net?: number;
  source?:
    | string
    | {
        id?: string;
        object?: string; // "charge" | "refund" | ...
        invoice?: string | null;
        payment_intent?: string | null;
        charge?: string | null; // on refunds
        metadata?: Record<string, string> | null;
      }
    | null;
}

async function stripeGet(
  key: string,
  path: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[reconciliation] Stripe GET ${path} failed:`, text);
    throw new ConvexError({
      code: "STRIPE_ERROR",
      message: `Stripe request failed (${res.status}).`,
    });
  }
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Build the allocation items for one payout by paging its balance
 * transactions. Network-heavy half of the seam: charges/refunds are traced to
 * their Checkout Session (memoized `GET /checkout/sessions?payment_intent=…`)
 * so the DB mutation can resolve our own record from the session metadata —
 * the SAME keys the `/stripe/webhook` fan-out routes on. Throws when the
 * payout is too large to page within bounds (all-or-nothing allocation).
 */
async function fetchPayoutItems(
  key: string,
  stripePayoutId: string,
): Promise<PayoutItem[]> {
  // Memoized session lookups: many items can share a charge's session shape.
  const sessionByPaymentIntent = new Map<
    string,
    { id: string; metadata: Record<string, string> } | null
  >();
  const chargeById = new Map<
    string,
    { invoice?: string | null; payment_intent?: string | null; metadata?: Record<string, string> | null } | null
  >();

  const lookupSession = async (
    paymentIntentId: string,
  ): Promise<{ id: string; metadata: Record<string, string> } | null> => {
    if (sessionByPaymentIntent.has(paymentIntentId)) {
      return sessionByPaymentIntent.get(paymentIntentId) ?? null;
    }
    let resolved: { id: string; metadata: Record<string, string> } | null = null;
    try {
      const body = await stripeGet(
        key,
        `/checkout/sessions?payment_intent=${encodeURIComponent(paymentIntentId)}&limit=1`,
      );
      const data = (body.data ?? []) as Array<{
        id?: string;
        metadata?: Record<string, string> | null;
      }>;
      const session = data[0];
      if (session?.id) {
        resolved = { id: session.id, metadata: session.metadata ?? {} };
      }
    } catch (err) {
      // Best-effort: an unresolvable session leaves the item unmapped (loud
      // in the payout summary) rather than failing the whole payout.
      console.error(
        `[reconciliation] session lookup failed for ${paymentIntentId}`,
        err,
      );
    }
    sessionByPaymentIntent.set(paymentIntentId, resolved);
    return resolved;
  };

  const lookupCharge = async (chargeId: string) => {
    if (chargeById.has(chargeId)) return chargeById.get(chargeId) ?? null;
    let resolved: {
      invoice?: string | null;
      payment_intent?: string | null;
      metadata?: Record<string, string> | null;
    } | null = null;
    try {
      resolved = (await stripeGet(
        key,
        `/charges/${encodeURIComponent(chargeId)}`,
      )) as unknown as {
        invoice?: string | null;
        payment_intent?: string | null;
        metadata?: Record<string, string> | null;
      };
    } catch (err) {
      console.error(`[reconciliation] charge lookup failed for ${chargeId}`, err);
    }
    chargeById.set(chargeId, resolved);
    return resolved;
  };

  const items: PayoutItem[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= MAX_BALANCE_TXN_PAGES) {
      throw new ConvexError({
        code: "PAYOUT_TOO_LARGE",
        message: `Payout ${stripePayoutId} has more than ${MAX_BALANCE_TXN_PAGES * STRIPE_PAGE_SIZE} balance transactions — refusing to half-allocate.`,
      });
    }
    const params = new URLSearchParams();
    params.set("payout", stripePayoutId);
    params.set("limit", String(STRIPE_PAGE_SIZE));
    params.set("expand[]", "data.source");
    if (startingAfter) params.set("starting_after", startingAfter);
    const body = await stripeGet(key, `/balance_transactions?${params.toString()}`);
    const rows = (body.data ?? []) as StripeBalanceTxn[];

    for (const bt of rows) {
      // The payout's own (negative) balance transaction — not revenue.
      if (bt.type === "payout") continue;
      const grossCents = Math.round(bt.amount ?? 0);
      const feeCents = Math.round(bt.fee ?? 0);
      const netCents = Math.round(bt.net ?? grossCents - feeCents);
      if (netCents === 0 && grossCents === 0) continue;

      const source = typeof bt.source === "object" && bt.source ? bt.source : null;
      const isCharge = source?.object === "charge";
      const isRefund = source?.object === "refund" || bt.type === "refund" || bt.type === "payment_refund";

      let invoiceId: string | undefined;
      let paymentIntentId: string | undefined;
      let metadata: Record<string, string> | undefined;

      if (isCharge) {
        invoiceId = source?.invoice ?? undefined;
        paymentIntentId = source?.payment_intent ?? undefined;
        metadata = source?.metadata ?? undefined;
      } else if (isRefund) {
        // A refund's source object names its charge; trace through it.
        paymentIntentId = source?.payment_intent ?? undefined;
        const chargeId =
          typeof source?.charge === "string" ? source.charge : undefined;
        if (chargeId) {
          const charge = await lookupCharge(chargeId);
          invoiceId = charge?.invoice ?? undefined;
          paymentIntentId = paymentIntentId ?? charge?.payment_intent ?? undefined;
          metadata = charge?.metadata ?? metadata;
        }
      }

      // Trace non-invoice charges to their Checkout Session — our own ids
      // (orderId / donationId / giveDonation / repaymentIds / pledgeId) live
      // in the session's metadata.
      let sessionId: string | undefined;
      const hasOwnKeys =
        metadata &&
        (metadata.orderId ||
          metadata.donationId ||
          metadata.giveDonation ||
          metadata.repaymentIds ||
          metadata.pledgeId);
      if (!invoiceId && !hasOwnKeys && paymentIntentId) {
        const session = await lookupSession(paymentIntentId);
        if (session) {
          sessionId = session.id;
          metadata = { ...(metadata ?? {}), ...session.metadata };
        }
      }

      items.push({
        grossCents,
        feeCents,
        netCents,
        ...(invoiceId ? { invoiceId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
        ...(isRefund ? { isReversal: true } : {}),
      });
    }

    const hasMore = body.has_more === true && rows.length > 0;
    if (!hasMore) break;
    startingAfter = rows[rows.length - 1]?.id;
    if (!startingAfter) break;
  }
  return items;
}

// ── The engine core (shared by cron, webhook, and manual runs) ───────────────

async function runEngine(
  ctx: ActionCtx,
  trigger: "cron" | "manual" | "webhook",
  onlyPayoutId?: string,
): Promise<void> {
  const settings: { paused: boolean; sinceMs: number | null } =
    await ctx.runQuery(internal.reconciliation.engineSettings, {});
  const key = process.env.STRIPE_SECRET_KEY;

  const runId: Id<"reconciliationRuns"> | null = await ctx.runMutation(
    internal.reconciliation.beginRun,
    { trigger },
  );
  if (runId === null) {
    console.log("[reconciliation] another run is live; skipping");
    return;
  }

  const notes: string[] = [];
  let payoutsProcessed = 0;
  let transfersBooked = 0;
  let settlementsBooked = 0;
  let allocatedCents = 0;

  const finish = async (
    status: "ok" | "error" | "skipped",
    error?: string,
  ): Promise<void> => {
    await ctx.runMutation(internal.reconciliation.finishRun, {
      runId,
      status,
      payoutsProcessed,
      transfersBooked,
      settlementsBooked,
      allocatedCents,
      notes,
      ...(error ? { error } : {}),
    });
  };

  if (settings.paused) {
    notes.push("Engine is paused (accounts page toggle) — nothing was booked.");
    await finish("skipped");
    return;
  }
  if (!key) {
    notes.push("STRIPE_SECRET_KEY is not configured — payout detection skipped.");
    // Settlement doesn't need Stripe — still run it below.
  }

  try {
    const sinceMs: number = await ctx.runMutation(
      internal.reconciliation.ensureSince,
      {},
    );

    // ── 1+2+3: detect + allocate payouts ────────────────────────────────────
    if (key) {
      const payouts: StripePayoutObject[] = [];
      if (onlyPayoutId) {
        const po = (await stripeGet(
          key,
          `/payouts/${encodeURIComponent(onlyPayoutId)}`,
        )) as unknown as StripePayoutObject;
        payouts.push(po);
      } else {
        let startingAfter: string | undefined;
        for (let page = 0; page < MAX_PAYOUT_PAGES; page++) {
          const params = new URLSearchParams();
          params.set("limit", String(STRIPE_PAGE_SIZE));
          params.set("arrival_date[gte]", String(Math.floor(sinceMs / 1000)));
          if (startingAfter) params.set("starting_after", startingAfter);
          const body = await stripeGet(key, `/payouts?${params.toString()}`);
          const rows = (body.data ?? []) as StripePayoutObject[];
          payouts.push(...rows);
          if (body.has_more !== true || rows.length === 0) break;
          startingAfter = rows[rows.length - 1]?.id;
        }
      }

      for (const po of payouts) {
        if (!po?.id) continue;
        const arrivalMs = (po.arrival_date ?? 0) * 1000;
        if (arrivalMs < sinceMs) continue; // pre-start-date payout (webhook path)
        const { processState } = await ctx.runMutation(
          internal.reconciliation.upsertDetectedPayout,
          {
            stripePayoutId: po.id,
            amountCents: Math.round(po.amount ?? 0),
            currency: (po.currency ?? "usd").toLowerCase(),
            stripeStatus: po.status ?? "unknown",
            arrivalDate: arrivalMs,
          },
        );
        // Allocate paid payouts that still owe allocation; re-visit allocated
        // ones only to retry an unmatched deposit (cheap — the mutation
        // short-circuits the transfer booking via ALREADY_RECORDED).
        if (po.status !== "paid") continue;
        if (processState === "allocated" && trigger === "webhook") continue;
        try {
          const items = await fetchPayoutItems(key, po.id);
          const result: {
            transfersBooked: number;
            allocatedCents: number;
            depositMatched: boolean;
            unmappedNetCents: number;
          } = await ctx.runMutation(
            internal.reconciliation.applyPayoutAllocation,
            { stripePayoutId: po.id, items },
          );
          payoutsProcessed += 1;
          transfersBooked += result.transfersBooked;
          allocatedCents += result.allocatedCents;
          if (result.transfersBooked > 0) {
            notes.push(
              `Payout ${po.id}: booked ${result.transfersBooked} allocation transfer(s).`,
            );
          }
          if (result.unmappedNetCents !== 0) {
            notes.push(
              `Payout ${po.id}: ${result.unmappedNetCents} cents could not be traced — left on central's book (review on the accounts page).`,
            );
          }
          if (!result.depositMatched) {
            notes.push(
              `Payout ${po.id}: bank deposit not found yet — will retry next run.`,
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[reconciliation] payout ${po.id} failed:`, err);
          notes.push(`Payout ${po.id} FAILED: ${message}`);
          await ctx.runMutation(internal.reconciliation.markPayoutFailed, {
            stripePayoutId: po.id,
            error: message,
          });
        }
      }
    }

    // ── 4: auto settlement (skipped on webhook fast-path — the morning run
    // owns it, so a burst of payout webhooks doesn't book intra-day pairs) ──
    if (trigger !== "webhook") {
      const settlement: { settlementsBooked: number; settledCents: number } =
        await ctx.runMutation(internal.reconciliation.runAutoSettlement, {
          dateStr: easternDateStr(Date.now()),
        });
      settlementsBooked = settlement.settlementsBooked;
      allocatedCents += settlement.settledCents;
      if (settlement.settlementsBooked > 0) {
        notes.push(
          `Settled cross-book card spend for ${settlement.settlementsBooked} chapter(s).`,
        );
      }
    }

    // ── 5: bank-balance snapshot (best-effort, display only) ────────────────
    if (trigger !== "webhook") {
      const accounts: {
        accountRowId: Id<"increaseAccounts">;
        increaseAccountId: string;
      }[] = await ctx.runQuery(
        internal.reconciliation.listAccountsForSnapshot,
        {},
      );
      for (const account of accounts) {
        const { key: incKey, base } = increaseEnvForObjectId(
          account.increaseAccountId,
        );
        if (!incKey) continue;
        try {
          const balance = await increaseGet(
            incKey,
            base,
            `/accounts/${encodeURIComponent(account.increaseAccountId)}/balance`,
          );
          const cents =
            typeof balance.available_balance === "number"
              ? balance.available_balance
              : typeof balance.current_balance === "number"
                ? balance.current_balance
                : null;
          if (cents != null) {
            await ctx.runMutation(internal.reconciliation.saveAccountBalance, {
              accountRowId: account.accountRowId,
              balanceCents: cents,
            });
          }
        } catch (err) {
          // Display-only data — log and move on.
          console.error(
            `[reconciliation] balance snapshot failed for ${account.increaseAccountId}`,
            err,
          );
        }
      }
    }

    await finish("ok");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[reconciliation] run failed:", err);
    await finish("error", message);
  }
}

/** The morning cron entry (see `crons.ts`) — full sweep: detect, allocate,
 *  settle, snapshot. No-ops per part when its vendor key is unset. */
export const runMorningReconciliation = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await runEngine(ctx, "cron");
    return null;
  },
});

/** Webhook fast-path (`payout.paid` etc. — see `http.ts`): detect + allocate
 *  ONE payout as soon as Stripe announces it, so the books don't wait for
 *  morning. Settlement + snapshots stay with the morning run. */
export const processPayoutEvent = internalAction({
  args: { stripePayoutId: v.string() },
  returns: v.null(),
  handler: async (ctx, { stripePayoutId }) => {
    await runEngine(ctx, "webhook", stripePayoutId);
    return null;
  },
});

// ── Public surface (accounts page; gated on the reconciliation-audit power) ──

/** Action-facing gate check (actions have no `ctx.db`). */
export const assertAuditAccess = internalQuery({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await requireReconciliationAudit(ctx);
    return null;
  },
});

/** FM "Run now" — the manual trigger on the accounts page. */
export const runReconciliationNow = action({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.runQuery(internal.reconciliation.assertAuditAccess, {});
    await runEngine(ctx, "manual");
    return null;
  },
});

/** Pause/resume the engine (the kill switch — ledger writes only, so this is
 *  an audit-control, not a money-movement gate). */
export const setReconciliationPaused = mutation({
  args: { paused: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { paused }) => {
    await requireReconciliationAudit(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const existing = await ctx.db.query("financeSettings").first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        autoReconciliationPaused: paused,
        updatedBy: userId,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("financeSettings", {
        sandboxMode: false,
        autoReconciliationPaused: paused,
        updatedBy: userId,
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

/**
 * Move the engine's start date. BACKDATING IS DELIBERATE: payouts arriving
 * before the current start were presumably hand-coded the old way — check
 * those deposits weren't already manually settled (an allocation transfer on
 * top of a manual one double-counts; the fix is an offsetting entry) before
 * moving this back. The next run picks up everything at/after the new date.
 */
export const setReconciliationStart = mutation({
  args: { sinceMs: v.number() },
  returns: v.null(),
  handler: async (ctx, { sinceMs }) => {
    await requireReconciliationAudit(ctx);
    if (!Number.isFinite(sinceMs) || sinceMs <= 0) {
      throw new ConvexError({
        code: "INVALID_PERIOD",
        message: "Start date must be a valid date.",
      });
    }
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const existing = await ctx.db.query("financeSettings").first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        autoReconciliationSinceMs: sinceMs,
        updatedBy: userId,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("financeSettings", {
        sandboxMode: false,
        autoReconciliationSinceMs: sinceMs,
        updatedBy: userId,
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

/** Flag an engine artifact for audit ("this needs a human decision"). */
export const flagReconciliationEntry = mutation({
  args: {
    kind: v.union(...RECONCILIATION_FLAG_KINDS.map((k) => v.literal(k))),
    refKey: v.string(),
    note: v.string(),
  },
  returns: v.id("reconciliationFlags"),
  handler: async (ctx, args) => {
    await requireReconciliationAudit(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const note = args.note.trim();
    if (!note) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Say what needs review — the note is the audit trail.",
      });
    }
    // One OPEN flag per artifact; a second flag on the same ref is a no-op
    // returning the existing one (double-tap safe).
    const existing = await ctx.db
      .query("reconciliationFlags")
      .withIndex("by_refKey", (q) => q.eq("refKey", args.refKey))
      .collect();
    const open = existing.find((f) => f.status === "open");
    if (open) return open._id;
    return await ctx.db.insert("reconciliationFlags", {
      kind: args.kind,
      refKey: args.refKey,
      note,
      status: "open",
      createdBy: userId,
      createdAt: Date.now(),
    });
  },
});

/** Resolve a flag, recording what was decided. The ledger fix itself (when
 *  one is needed) is an offsetting entry per docs/plans/transfers-ops-notes.md
 *  — resolving a flag never rewrites money. */
export const resolveReconciliationFlag = mutation({
  args: {
    flagId: v.id("reconciliationFlags"),
    resolutionNote: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { flagId, resolutionNote }) => {
    await requireReconciliationAudit(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const flag = await ctx.db.get(flagId);
    if (!flag) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Flag not found." });
    }
    if (flag.status === "resolved") return null;
    const note = resolutionNote.trim();
    if (!note) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Say how it was resolved — the note is the audit trail.",
      });
    }
    await ctx.db.patch(flagId, {
      status: "resolved",
      resolvedBy: userId,
      resolvedAt: Date.now(),
      resolutionNote: note,
    });
    return null;
  },
});

// ── Public reads (accounts page) ─────────────────────────────────────────────

const overviewPayoutValidator = v.object({
  stripePayoutId: v.string(),
  amountCents: v.number(),
  stripeStatus: v.string(),
  arrivalDate: v.number(),
  processState: v.union(
    ...STRIPE_PAYOUT_PROCESS_STATES.map((s) => v.literal(s)),
  ),
  allocation: v.array(
    v.object({
      scope: financeScopeValidator,
      scopeName: v.string(),
      netCents: v.number(),
      itemCount: v.number(),
    }),
  ),
  unmappedNetCents: v.number(),
  repaymentNetCents: v.number(),
  depositMatched: v.boolean(),
  error: v.union(v.string(), v.null()),
  flagged: v.boolean(),
});

/** Resolve a scope's display name (central sentinel or chapter name). */
async function scopeName(
  ctx: QueryCtx,
  cache: Map<string, string>,
  scope: FinanceScope,
): Promise<string> {
  if (scope === CENTRAL) return "Central";
  const cached = cache.get(scope);
  if (cached) return cached;
  const chapter = await ctx.db.get(scope);
  const name = chapter?.name ?? "Unknown chapter";
  cache.set(scope, name);
  return name;
}

/**
 * The accounts page's "Morning reconciliation" panel: engine state, the last
 * run, recent payouts with their allocation, and open-flag count.
 */
export const reconciliationOverview = query({
  args: {},
  returns: v.object({
    paused: v.boolean(),
    sinceMs: v.union(v.number(), v.null()),
    lastRun: v.union(
      v.object({
        trigger: v.string(),
        status: v.string(),
        startedAt: v.number(),
        finishedAt: v.union(v.number(), v.null()),
        payoutsProcessed: v.number(),
        transfersBooked: v.number(),
        settlementsBooked: v.number(),
        allocatedCents: v.number(),
        notes: v.array(v.string()),
        error: v.union(v.string(), v.null()),
      }),
      v.null(),
    ),
    openFlagCount: v.number(),
    payouts: v.array(overviewPayoutValidator),
  }),
  handler: async (ctx) => {
    await requireReconciliationAudit(ctx);
    const settings = await ctx.db.query("financeSettings").first();

    const lastRunDoc = await ctx.db
      .query("reconciliationRuns")
      .withIndex("by_startedAt")
      .order("desc")
      .first();

    const openFlags = await ctx.db
      .query("reconciliationFlags")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .take(200);

    const payoutDocs = await ctx.db
      .query("stripePayouts")
      .withIndex("by_arrival")
      .order("desc")
      .take(OVERVIEW_PAYOUT_LIMIT);

    const nameCache = new Map<string, string>();
    const flaggedKeys = new Set(openFlags.map((f) => f.refKey));
    const payouts: (typeof overviewPayoutValidator.type)[] = [];
    for (const po of payoutDocs) {
      const allocation: {
        scope: FinanceScope;
        scopeName: string;
        netCents: number;
        itemCount: number;
      }[] = [];
      for (const entry of po.allocation ?? []) {
        allocation.push({
          scope: entry.scope,
          scopeName: await scopeName(ctx, nameCache, entry.scope),
          netCents: entry.netCents,
          itemCount: entry.itemCount,
        });
      }
      payouts.push({
        stripePayoutId: po.stripePayoutId,
        amountCents: po.amountCents,
        stripeStatus: po.stripeStatus,
        arrivalDate: po.arrivalDate,
        processState: po.processState,
        allocation,
        unmappedNetCents: po.unmappedNetCents ?? 0,
        repaymentNetCents: po.repaymentNetCents ?? 0,
        depositMatched: po.matchedTransactionId != null,
        error: po.error ?? null,
        flagged: flaggedKeys.has(po.stripePayoutId),
      });
    }

    return {
      paused: settings?.autoReconciliationPaused ?? false,
      sinceMs: settings?.autoReconciliationSinceMs ?? null,
      lastRun: lastRunDoc
        ? {
            trigger: lastRunDoc.trigger,
            status: lastRunDoc.status,
            startedAt: lastRunDoc.startedAt,
            finishedAt: lastRunDoc.finishedAt ?? null,
            payoutsProcessed: lastRunDoc.payoutsProcessed,
            transfersBooked: lastRunDoc.transfersBooked,
            settlementsBooked: lastRunDoc.settlementsBooked,
            allocatedCents: lastRunDoc.allocatedCents,
            notes: lastRunDoc.notes,
            error: lastRunDoc.error ?? null,
          }
        : null,
      openFlagCount: openFlags.length,
    payouts,
    };
  },
});

/**
 * Per-book balances for the accounts page: the LEDGER ("book") balance —
 * Σ `signedBookCents` over the book's transactions, the number the engine
 * keeps true — plus the cached BANK balance where the morning snapshot has
 * one. Book vs bank differing is normal (cash pools physically in central's
 * account; the ledger states who it belongs to) — the page explains that.
 */
export const accountBalances = query({
  args: {},
  returns: v.array(
    v.object({
      scope: financeScopeValidator,
      scopeName: v.string(),
      bookBalanceCents: v.number(),
      truncated: v.boolean(),
      bankBalanceCents: v.union(v.number(), v.null()),
      bankBalanceAsOf: v.union(v.number(), v.null()),
    }),
  ),
  handler: async (ctx) => {
    await requireReconciliationAudit(ctx);
    const sandboxMode = await readSandbox(ctx);

    const rawChapters = await ctx.db.query("chapters").take(ROLLUP_SCAN_LIMIT);
    const chapters = rawChapters
      .filter((c) => c.isActive !== false)
      .sort((a, b) => a.name.localeCompare(b.name));
    const scopes: { scope: FinanceScope; scopeName: string }[] = [
      { scope: CENTRAL, scopeName: "Central" },
      ...chapters.map((c) => ({ scope: c._id as FinanceScope, scopeName: c.name })),
    ];

    const accountRows = await ctx.db
      .query("increaseAccounts")
      .take(ROLLUP_SCAN_LIMIT);

    const out: {
      scope: FinanceScope;
      scopeName: string;
      bookBalanceCents: number;
      truncated: boolean;
      bankBalanceCents: number | null;
      bankBalanceAsOf: number | null;
    }[] = [];
    for (const { scope, scopeName: name } of scopes) {
      const txns = await ctx.db
        .query("transactions")
        .withIndex("by_chapter", (q) => q.eq("chapterId", scope))
        .take(ROLLUP_SCAN_LIMIT);
      const truncated = txns.length === ROLLUP_SCAN_LIMIT;
      if (truncated) {
        console.warn(
          `[reconciliation] accountBalances hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) for ${scope}; book balance truncated.`,
        );
      }
      let bookBalanceCents = 0;
      for (const tr of txns) {
        if (!txnMatchesMode(tr, sandboxMode)) continue;
        bookBalanceCents += signedBookCents(tr);
      }
      // The account row for the current environment (mirrors
      // `getChapterAccountForMode` without an extra read per scope).
      const account =
        accountRows.find(
          (a) =>
            a.chapterId === scope &&
            (a.sandbox ?? a.increaseAccountId?.startsWith("sandbox_") ?? false) ===
              sandboxMode,
        ) ?? null;
      out.push({
        scope,
        scopeName: name,
        bookBalanceCents,
        truncated,
        bankBalanceCents: account?.balanceCents ?? null,
        bankBalanceAsOf: account?.balanceAsOf ?? null,
      });
    }
    return out;
  },
});

const historyRowValidator = v.object({
  transferGroupId: v.string(),
  postedAt: v.number(),
  amountCents: v.number(),
  direction: v.union(
    v.literal("central_to_chapter"),
    v.literal("chapter_to_central"),
  ),
  chapterId: v.union(v.id("chapters"), v.null()),
  chapterName: v.string(),
  origin: v.union(
    v.literal("manual"),
    v.literal("payout_allocation"),
    v.literal("auto_settlement"),
  ),
  note: v.union(v.string(), v.null()),
  stripePayoutId: v.union(v.string(), v.null()),
  recordedByName: v.union(v.string(), v.null()),
  flag: v.union(
    v.object({
      flagId: v.id("reconciliationFlags"),
      status: v.string(),
      note: v.string(),
    }),
    v.null(),
  ),
});

/**
 * The transfer history feed — every central↔chapter pair (manual AND engine),
 * newest first, with origin badges and flag state. Reads CENTRAL's legs
 * (every central↔chapter pair has exactly one central leg), so one bounded
 * scan sees the whole history; the chapter side + pair details resolve per
 * row. Marked same-scope bank transfers (`preMarkFlow`) are Reconcile's
 * domain and deliberately not shown here.
 */
export const listTransferHistory = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(historyRowValidator),
  handler: async (ctx, args) => {
    await requireReconciliationAudit(ctx);
    const limit = Math.min(
      Math.max(args.limit ?? HISTORY_DEFAULT_LIMIT, 1),
      HISTORY_MAX_LIMIT,
    );

    // Central's transfer legs, newest first. Over-scan (bounded) because the
    // central book also holds non-transfer rows the filter drops.
    const centralTxns = await ctx.db
      .query("transactions")
      .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", CENTRAL))
      .order("desc")
      .take(ROLLUP_SCAN_LIMIT);

    const TRANSFER_SOURCES = new Set([
      "transfer",
      "skim",
      "launch_grant",
      "settlement",
    ]);
    const legs = centralTxns
      .filter(
        (tr) => tr.transferGroupId != null && TRANSFER_SOURCES.has(tr.source),
      )
      .slice(0, limit);

    const nameCache = new Map<string, string>();
    const rows: (typeof historyRowValidator.type)[] = [];
    for (const leg of legs) {
      const groupId = leg.transferGroupId!;
      // The pair's other (chapter) leg names the counterparty.
      const pair = await ctx.db
        .query("transactions")
        .withIndex("by_transfer_group", (q) => q.eq("transferGroupId", groupId))
        .collect();
      const chapterLeg = pair.find((p) => p.chapterId !== CENTRAL) ?? null;
      const chapterId =
        chapterLeg && chapterLeg.chapterId !== CENTRAL
          ? (chapterLeg.chapterId as Id<"chapters">)
          : null;
      const chapterName = chapterId
        ? await scopeName(ctx, nameCache, chapterId)
        : "—";

      const direction =
        leg.transferDirection ??
        (leg.source === "skim"
          ? ("chapter_to_central" as const)
          : leg.source === "launch_grant"
            ? ("central_to_chapter" as const)
            : ("chapter_to_central" as const));

      // Engine payout pairs carry their payout id in the deterministic group
      // id (`payoutalloc-<po_…>-<scope>`).
      const payoutMatch = groupId.match(/^payoutalloc-(po_[^-]+)-/);

      const flags = await ctx.db
        .query("reconciliationFlags")
        .withIndex("by_refKey", (q) => q.eq("refKey", groupId))
        .collect();
      const flag =
        flags.find((f) => f.status === "open") ??
        flags.sort((a, b) => b.createdAt - a.createdAt)[0] ??
        null;

      let recordedByName: string | null = null;
      if (leg.createdBy) {
        const user = await ctx.db.get(leg.createdBy);
        recordedByName = (user?.email as string | undefined) ?? null;
      }

      rows.push({
        transferGroupId: groupId,
        postedAt: leg.postedAt,
        amountCents: leg.amountCents,
        direction,
        chapterId,
        chapterName,
        origin: leg.transferOrigin ?? "manual",
        note: leg.description ?? null,
        stripePayoutId: payoutMatch ? payoutMatch[1] : null,
        recordedByName,
        flag: flag
          ? { flagId: flag._id, status: flag.status, note: flag.note }
          : null,
      });
    }
    return rows;
  },
});

/** Non-throwing visibility check for the accounts page (mirrors
 *  `financeRoles.canViewAccounts` — same seats today via the resolver). */
export const canViewReconciliation = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    try {
      return await hasReconciliationAudit(ctx);
    } catch {
      return false;
    }
  },
});
