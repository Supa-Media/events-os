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
 * REAL MONEY moves only when the FM has explicitly turned
 * `financeSettings.autoTransferRealMovement` ON (default OFF — a merge alone
 * never moves cash, honoring the money-gating rule; the toggle is the
 * standing human authorization). When on, step 5 executes each engine-booked
 * pair as one Increase account-to-account transfer between PRODUCTION
 * accounts (Idempotency-Key = the pair's transferGroupId) and stamps the
 * legs' `externalId` with the transfer id — which is also what makes
 * `increaseLedger`'s already-booked guard skip the bank feed's two
 * settlement entries. Manual `recordTransfer` pairs are never executed (they
 * record movements that already happened outside the app). With the toggle
 * off, every write is a ledger entry and the LEDGER alone states each book's
 * true value.
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
  easternParts,
  formatCents,
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
import {
  getChapterAccountForMode,
  requireCentralEdOrFm,
  type FinanceScope,
} from "./lib/finance";
import { fetchGivebutterUndepositedCents } from "./givebutterSync";
import {
  hasReconciliationAudit,
  requireReconciliationAudit,
} from "./lib/reconciliationAccess";
import { signedBookCents } from "./lib/bookBalance";
import { reconcileOrgMoney } from "./lib/reconciliationGap";
import {
  increaseEnvForMode,
  increaseEnvForObjectId,
  increaseGet,
  increasePost,
} from "./lib/increaseApi";
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
 *  deterministic daily settlement group id. Built from the shared
 *  `easternParts` (rather than a third copy of the `toLocaleDateString`
 *  one-liner in `finances.ts`/`transfers.ts`) so the org's day rule has one
 *  timezone source. */
function easternDateStr(ts: number): string {
  const { year, month, day } = easternParts(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
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
    realMovement: v.boolean(),
  }),
  handler: async (ctx) => {
    const settings = await ctx.db.query("financeSettings").first();
    return {
      paused: settings?.autoReconciliationPaused ?? false,
      sinceMs: settings?.autoReconciliationSinceMs ?? null,
      realMovement: settings?.autoTransferRealMovement ?? false,
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
    /** Stripe's `automatic` flag — false when a human pressed "pay out now".
     *  Optional so a caller that didn't read it leaves the stored value alone
     *  rather than overwriting a known value with a guess. */
    automatic: v.optional(v.boolean()),
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
        ...(args.automatic !== undefined ? { automatic: args.automatic } : {}),
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
    // ── HEAL AN OBSOLETE ALLOCATION FAILURE ──────────────────────────────────
    // "failed" only ever meant "the per-payout allocation step errored", and
    // #553 deleted that step: attribution comes from the revenue layer now, and
    // a payout's only remaining job is to have its bank deposit labelled. So a
    // stored `failed` describes work that is no longer attempted, cannot be
    // retried, and does not need to be — yet it kept rendering as a red badge
    // over a raw Stripe error blob, on a page whose entire purpose is telling a
    // treasurer whether something needs their attention.
    //
    // The concrete case: po_1U1qk8Qv9S5xW6eKsjkeLJvv was initiated by hand in
    // the Stripe dashboard, and Stripe will not itemise a manual payout
    // ("Balance transaction history can only be filtered on automatic
    // transfers, not manual"). Correct refusal, obsolete requirement.
    //
    // Cleared here rather than by a migration so it heals wherever it exists —
    // including any deployment that acquires one before the code that could
    // create it is finally deleted. A payout Stripe itself reports as failed or
    // canceled is left alone; that is a real problem and keeps its record.
    const healingObsoleteFailure =
      existing.processState === "failed" &&
      args.stripeStatus !== "failed" &&
      args.stripeStatus !== "canceled";
    await ctx.db.patch(existing._id, {
      amountCents: args.amountCents,
      currency: args.currency,
      stripeStatus: args.stripeStatus,
      arrivalDate: args.arrivalDate,
      ...(args.automatic !== undefined ? { automatic: args.automatic } : {}),
      ...(healingObsoleteFailure
        ? { processState: "pending" as const, error: undefined }
        : {}),
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
      processState: healingObsoleteFailure
        ? ("pending" as const)
        : existing.processState,
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
    const driftNotes: string[] = [];
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
            // Show the arithmetic, not just the conclusion (owner request,
            // 2026-08-07: transfer rows need "comments on how the transfer was
            // calculated"). A settled pair carries no category and no budget —
            // a transfer isn't spend — so this sentence is the ONLY explanation
            // a reader gets, and "net of fees" without the gross and the fee
            // asks them to take the number on faith.
            note:
              `Auto: allocation of Stripe payout ${stripePayoutId} — ` +
              `${bucket.itemCount} item${bucket.itemCount === 1 ? "" : "s"} earned by this book, ` +
              `${formatCents(bucket.grossCents)} gross less ${formatCents(bucket.feeCents)} Stripe fees ` +
              `= ${formatCents(Math.abs(bucket.netCents))} ${direction === "central_to_chapter" ? "owed to it" : "owed back to central"}. ` +
              `The payout itself landed in central's account.`,
            transferDirection: direction,
            transferOrigin: "payout_allocation",
          });
          transfersBooked += 1;
          allocatedCents += amountCents;
        } catch (err) {
          // ALREADY_RECORDED = an earlier run booked this allocation — the
          // idempotent re-run case. But a re-run can RESOLVE items the first
          // pass couldn't (e.g. a gift row that arrived late), recomputing a
          // DIFFERENT net than the booked pair moved. Never silently display
          // a number the ledger didn't book: compare and surface the drift
          // loudly (the fix is a human offsetting entry, not an auto-edit —
          // transfer pairs are append-only per transfers-ops-notes).
          if (!(err instanceof ConvexError) || err.data?.code !== "ALREADY_RECORDED") {
            throw err;
          }
          const bookedLeg = await ctx.db
            .query("transactions")
            .withIndex("by_transfer_group", (q) =>
              q.eq("transferGroupId", transferGroupId),
            )
            .first();
          if (
            bookedLeg &&
            (bookedLeg.amountCents !== amountCents ||
              bookedLeg.transferDirection !== direction)
          ) {
            driftNotes.push(
              `${scope}: booked pair moved ${bookedLeg.amountCents} cents (${bookedLeg.transferDirection}) but this run recomputes ${amountCents} cents (${direction}) — record an offsetting transfer for the difference (docs/plans/transfers-ops-notes.md).`,
            );
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
      // Drift stays visible until a human clears it via offsetting entries
      // (re-runs keep recomputing it); a clean run clears any stale error.
      error: driftNotes.length > 0 ? driftNotes.join(" ") : undefined,
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
      // LIVE rows only (#163 precedent): a sandbox-account test deposit must
      // never be claimed as a real payout's arrival — the match is one-shot,
      // so a wrong claim would leave the real deposit unlabeled forever.
      txnMatchesMode(tr, false) &&
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

/**
 * Fetch-free deposit-match retry for an ALLOCATED payout whose bank deposit
 * hadn't synced in yet — the cheap path the morning run uses instead of
 * re-paging the payout's balance transactions (which never change once
 * allocated). No-op once matched.
 */
export const retryDepositMatch = internalMutation({
  args: { stripePayoutId: v.string() },
  returns: v.object({ depositMatched: v.boolean() }),
  handler: async (ctx, { stripePayoutId }) => {
    const payout = await ctx.db
      .query("stripePayouts")
      .withIndex("by_stripe_payout", (q) =>
        q.eq("stripePayoutId", stripePayoutId),
      )
      .unique();
    if (!payout) return { depositMatched: false };
    if (payout.matchedTransactionId != null) return { depositMatched: true };
    const matched = await matchPayoutDeposit(ctx, payout);
    if (matched) {
      await ctx.db.patch(payout._id, {
        matchedTransactionId: matched,
        updatedAt: Date.now(),
      });
    }
    return { depositMatched: matched != null };
  },
});

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
/**
 * Move each chapter the cash its book says it is owed.
 *
 * ── WHY THIS REPLACED PER-PAYOUT ALLOCATION ─────────────────────────────────
 * Every payout lands in central's account, so central perpetually holds money
 * the chapters earned. The old answer was to itemise each payout — trace every
 * balance transaction back to the ticket order, donation or gift that produced
 * it, then book one central→chapter pair per chapter per payout.
 *
 * That was the hard way round for no gain. Chapter attribution is already
 * SOLVED at the revenue layer: gifts, ticket orders and sales are chapter-
 * scoped and dated before a payout exists. Re-deriving it from Stripe's side
 * was fragile (a manually-initiated payout can't be itemised at all — Stripe
 * returns "Balance transaction history can only be filtered on automatic
 * transfers"), impossible for Givebutter (no API, so its payouts were
 * allocated by hand), and produced legs that contributed ZERO to book value.
 * All that machinery made no number correct.
 *
 * So: a payout is now just cash arriving at central. Once a run, this compares
 * each chapter's BOOK to its BANK and moves the difference.
 *
 * ── WHY IT CONVERGES INSTEAD OF SOLVING EXACTLY ─────────────────────────────
 * Book and the right cash balance are not the same number at any instant:
 * revenue can be earned but still clearing at the processor, and card
 * authorizations leave the bank before they reach the ledger. Rather than
 * model both, this aims at book value and lets the next run correct what has
 * moved since. The settlement legs contribute 0 to book value, so the target
 * never chases itself — crediting a chapter for its own top-up would raise the
 * number the top-up aims at and the engine would never settle.
 *
 * BOUNDED BY WHAT CENTRAL ACTUALLY HOLDS. A chapter is owed what it earned, but
 * central can only send what it has; the remainder is picked up next run once
 * more has cleared. Without this the engine would book transfers that then fail
 * to execute, leaving pairs the ledger claims happened and the bank denies.
 *
 * `MIN_SETTLEMENT_CENTS` stops the engine booking a pair every morning to chase
 * a few cents of rounding — a ledger row costs a reader's attention, and $5 of
 * drift is not worth one.
 */
export const settleChapterBalances = internalMutation({
  args: { dateStr: v.string() },
  returns: v.object({
    settlementsBooked: v.number(),
    movedCents: v.number(),
    notes: v.array(v.string()),
  }),
  handler: async (ctx, { dateStr }) => {
    const notes: string[] = [];
    let settlementsBooked = 0;
    let movedCents = 0;

    const balances = await computeBookBalances(ctx);
    const accountRows = await ctx.db
      .query("increaseAccounts")
      .take(ROLLUP_SCAN_LIMIT);
    const bankFor = (scope: FinanceScope): number | null => {
      const row = accountRows.find(
        (a) =>
          a.chapterId === scope &&
          (a.sandbox ?? a.increaseAccountId?.startsWith("sandbox_") ?? false) === false,
      );
      return row?.balanceCents ?? null;
    };

    const centralBank = bankFor(CENTRAL);
    if (centralBank == null) {
      notes.push("Balance settlement skipped — no central bank balance yet.");
      return { settlementsBooked, movedCents, notes };
    }
    // Only cash central is actually free to send. Reduced as each chapter is
    // funded so two chapters can't both be promised the same dollar.
    let centralAvailable = centralBank;

    // Largest shortfall first: if central can't cover everyone, the chapter
    // furthest from its book gets made whole before a chapter that's nearly
    // there. Arbitrary order would fund whoever happened to be read first.
    const shortfalls = balances
      .filter((b) => b.scope !== CENTRAL)
      .map((b) => ({ ...b, bank: bankFor(b.scope) }))
      .filter((b): b is typeof b & { bank: number } => b.bank != null)
      .map((b) => ({ ...b, owed: b.bookBalanceCents - b.bank }))
      .sort((a, b) => b.owed - a.owed);

    for (const chapter of shortfalls) {
      if (Math.abs(chapter.owed) < MIN_SETTLEMENT_CENTS) continue;

      // A chapter holding MORE than its book returns the excess — the same
      // true-up in reverse, and central is where the surplus belongs.
      const direction: TransferDirection =
        chapter.owed > 0 ? "central_to_chapter" : "chapter_to_central";
      let amountCents = Math.abs(chapter.owed);

      if (direction === "central_to_chapter") {
        if (centralAvailable < MIN_SETTLEMENT_CENTS) {
          notes.push(
            `${chapter.scopeName}: owed ${formatCents(chapter.owed)} but central has nothing free — next run.`,
          );
          continue;
        }
        if (amountCents > centralAvailable) {
          notes.push(
            `${chapter.scopeName}: owed ${formatCents(chapter.owed)}, sending ${formatCents(centralAvailable)} — the rest once more clears.`,
          );
          amountCents = centralAvailable;
        }
        centralAvailable -= amountCents;
      }

      const { sourceScope, destScope } = transferScopes(
        chapter.scope as Id<"chapters">,
        direction,
      );
      // One settlement per chapter per Eastern day, deterministic so a re-run
      // (a manual "Run now" after the cron) books nothing twice.
      const transferGroupId = `balsettle-${chapter.scope}-${dateStr}`;
      try {
        await recordTransferPair(ctx, {
          sourceScope,
          destScope,
          amountCents,
          transferGroupId,
          postedAt: Date.now(),
          note:
            `Auto: ${chapter.scopeName}'s cash brought to its book. Book ` +
            `${formatCents(chapter.bookBalanceCents)} against ${formatCents(chapter.bank)} in the bank ` +
            `= ${formatCents(chapter.owed)} ${chapter.owed > 0 ? "owed to it" : "held above its book"}. ` +
            `Every payout lands in central's account, so central holds what the chapters earn.`,
          transferDirection: direction,
          transferOrigin: "balance_settlement",
        });
        settlementsBooked += 1;
        movedCents += amountCents;
      } catch (err) {
        // Already settled today (a manual re-run after the cron) — fine.
        if (!(err instanceof ConvexError) || err.data?.code !== "ALREADY_RECORDED") {
          throw err;
        }
      }
    }
    return { settlementsBooked, movedCents, notes };
  },
});

export const runAutoSettlement = internalMutation({
  args: { dateStr: v.string() },
  returns: v.object({
    settlementsBooked: v.number(),
    settledCents: v.number(),
  }),
  handler: async (ctx, { dateStr }) => {
    // ALWAYS the LIVE balance, never the current toggle. `financeSettings.
    // sandboxMode` is a superuser demo state — if the engine computed nets
    // from sandbox card spend it would book mode-NEUTRAL settling legs (a
    // `recordTransferPair` leg has no `externalId`) that permanently corrupt
    // live balances after the toggle flips back. Sandbox imbalances are demo
    // artifacts; only real money gets auto-settled.
    const sandboxMode = false;
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
          // The four sums the net came from, spelled out. Same reasoning as the
          // payout-allocation note above: a transfer pair carries no category
          // and no budget, so this sentence is the whole audit trail. Someone
          // asked to justify a $224.53 movement should be able to read it off
          // the row instead of re-deriving `chapterInterScopeRows` by hand.
          note:
            `Auto: settlement of cross-book card spend through ${dateStr}. ` +
            `${chapter.name}'s spend on central's cards ${formatCents(sumAllCents(grouped.centralOwesChapterRows))} ` +
            `(${grouped.centralOwesChapterRows.length} row${grouped.centralOwesChapterRows.length === 1 ? "" : "s"}) ` +
            `less ${formatCents(sumAllCents(grouped.settledCentralToChapterRows))} already settled; ` +
            `central's spend on ${chapter.name}'s cards ${formatCents(sumAllCents(grouped.chapterOwesCentralRows))} ` +
            `(${grouped.chapterOwesCentralRows.length} row${grouped.chapterOwesCentralRows.length === 1 ? "" : "s"}) ` +
            `less ${formatCents(sumAllCents(grouped.settledChapterToCentralRows))} already settled. ` +
            `Net ${formatCents(Math.abs(netCents))} ` +
            `${direction === "central_to_chapter" ? `central → ${chapter.name}` : `${chapter.name} → central`}.`,
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

// ── Real cash movement (internal) ────────────────────────────────────────────
// When `financeSettings.autoTransferRealMovement` is ON, the engine EXECUTES
// each engine-booked pair as a real Increase account-to-account transfer so
// the cash physically follows the books (founder, 2026-08-07: payouts now
// land in the central Increase account). Manual `recordTransfer` pairs are
// never executed — they record movements that already happened outside the
// app. Execution always targets PRODUCTION accounts: a live-booked pair
// "executed" against sandbox accounts would stamp a `sandbox_…` transfer id
// on live legs and make `interScopeBalances`' mode filter drop them.

/** Engine pairs cash hasn't moved for per run — keeps one morning's API calls
 *  bounded; the backlog drains across runs. */
const REAL_MOVES_PER_RUN = 25;

/**
 * Engine-booked pairs (`transferOrigin` set) whose cash hasn't moved yet
 * (legs carry no `externalId`) AND that are SAFE to execute:
 *
 *  - BOOKED AT/AFTER the enable stamp (`autoTransferRealMovementSinceMs`) —
 *    the historical backlog never auto-moves. Pairs booked while the toggle
 *    was off include pre-Increase-era allocations whose cash never reached
 *    the central Increase account; executing those would drain central for
 *    money it never physically held.
 *  - THE UNDERLYING CASH IS AT INCREASE, per kind: an `autosettle-…` pair
 *    settles spend across the org's own Increase accounts (safe by
 *    construction); a `payoutalloc-po_…` pair requires its Stripe payout's
 *    MATCHED DEPOSIT to be an `increase_ach` row (the deposit really landed
 *    at central's Increase account — not the legacy bank); a
 *    `payoutalloc-manual-…` pair requires the same of the deposit it
 *    allocates. Unknown shapes are skipped.
 *
 * Central's leg of every pair makes one bounded scan sufficient — NEWEST
 * first so fresh pairs are never starved by an old remainder, with a loud
 * warning if the scan window truncates.
 */
export const listUnexecutedEnginePairs = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      transferGroupId: v.string(),
      chapterId: v.id("chapters"),
      direction: v.union(
        v.literal("central_to_chapter"),
        v.literal("chapter_to_central"),
      ),
      amountCents: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const settings = await ctx.db.query("financeSettings").first();
    const enabledSinceMs = settings?.autoTransferRealMovementSinceMs;
    if (enabledSinceMs == null) return []; // never enabled — nothing executes

    /** True iff the deposit row backing an allocation is cash that actually
     *  sits in an Increase account. */
    const depositAtIncrease = (
      deposit: Doc<"transactions"> | null,
    ): boolean => deposit != null && deposit.source === "increase_ach";

    const centralTxns = await ctx.db
      .query("transactions")
      .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", CENTRAL))
      .order("desc")
      .take(ROLLUP_SCAN_LIMIT);
    if (centralTxns.length === ROLLUP_SCAN_LIMIT) {
      console.warn(
        `[reconciliation] listUnexecutedEnginePairs hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}); older unexecuted pairs may be missed this run.`,
      );
    }
    const out: {
      transferGroupId: string;
      chapterId: Id<"chapters">;
      direction: TransferDirection;
      amountCents: number;
    }[] = [];
    for (const leg of centralTxns) {
      if (out.length >= REAL_MOVES_PER_RUN) break;
      if (leg.transferOrigin == null) continue; // manual pairs never execute
      if (leg.externalId != null) continue; // cash already moved
      if (leg.transferGroupId == null || leg.transferDirection == null) continue;
      if (leg.createdAt < enabledSinceMs) continue; // pre-enable backlog

      // Kind-specific "the cash is really at Increase" checks.
      const groupId = leg.transferGroupId;
      if (groupId.startsWith("payoutalloc-po_")) {
        const payoutMatch = groupId.match(/^payoutalloc-(po_[^-]+)-/);
        const payout = payoutMatch
          ? await ctx.db
              .query("stripePayouts")
              .withIndex("by_stripe_payout", (q) =>
                q.eq("stripePayoutId", payoutMatch[1]),
              )
              .unique()
          : null;
        const deposit = payout?.matchedTransactionId
          ? await ctx.db.get(payout.matchedTransactionId)
          : null;
        if (!depositAtIncrease(deposit)) continue;
      } else if (groupId.startsWith("payoutalloc-manual-")) {
        const txnId = ctx.db.normalizeId(
          "transactions",
          groupId.slice("payoutalloc-manual-".length),
        );
        const deposit = txnId ? await ctx.db.get(txnId) : null;
        if (!depositAtIncrease(deposit)) continue;
      } else if (!groupId.startsWith("autosettle-")) {
        continue; // unknown engine-pair shape — never move cash on a guess
      }

      // The pair's chapter side names the counterparty account.
      const pair = await ctx.db
        .query("transactions")
        .withIndex("by_transfer_group", (q) =>
          q.eq("transferGroupId", groupId),
        )
        .collect();
      const chapterLeg = pair.find((p) => p.chapterId !== CENTRAL);
      if (!chapterLeg || chapterLeg.chapterId === CENTRAL) continue;
      out.push({
        transferGroupId: groupId,
        chapterId: chapterLeg.chapterId as Id<"chapters">,
        direction: leg.transferDirection,
        amountCents: leg.amountCents,
      });
    }
    return out;
  },
});

/** The PRODUCTION Increase account ids for central + one chapter — both must
 *  be active for a real movement (mirrors `transfers.transferReadiness`). */
export const productionAccountIds = internalQuery({
  args: { chapterId: v.id("chapters") },
  returns: v.object({
    centralAccountId: v.union(v.string(), v.null()),
    chapterAccountId: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { chapterId }) => {
    const ready = (a: Doc<"increaseAccounts"> | null): string | null =>
      a != null && a.onboardingStatus === "active" && a.increaseAccountId
        ? a.increaseAccountId
        : null;
    const central = await getChapterAccountForMode(ctx, CENTRAL, false);
    const chapter = await getChapterAccountForMode(ctx, chapterId, false);
    return {
      centralAccountId: ready(central),
      chapterAccountId: ready(chapter),
    };
  },
});

/**
 * Stamp both legs of an executed pair with the Increase transfer id — the
 * mark that cash moved (and the key `increaseLedger`'s already-booked guard
 * uses to skip the bank feed's two settlement entries, so the movement is
 * never double-ingested). Idempotent: legs already stamped are left alone.
 */
export const stampPairMoved = internalMutation({
  args: { transferGroupId: v.string(), increaseTransferId: v.string() },
  returns: v.null(),
  handler: async (ctx, { transferGroupId, increaseTransferId }) => {
    const legs = await ctx.db
      .query("transactions")
      .withIndex("by_transfer_group", (q) =>
        q.eq("transferGroupId", transferGroupId),
      )
      .collect();
    for (const leg of legs) {
      if (leg.externalId == null) {
        await ctx.db.patch(leg._id, { externalId: increaseTransferId });
      }
    }
    return null;
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
    /** Authorizations held but not settled — see the schema field's doc. */
    pendingCents: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, { accountRowId, balanceCents, pendingCents }) => {
    await ctx.db.patch(accountRowId, {
      balanceCents,
      ...(pendingCents !== undefined ? { pendingCents } : {}),
      balanceAsOf: Date.now(),
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** The category rollup behind one account's pending total — see the schema
 *  field's doc for why a bare total wasn't enough. */
export const savePendingBreakdown = internalMutation({
  args: {
    accountRowId: v.id("increaseAccounts"),
    breakdown: v.array(
      v.object({
        category: v.string(),
        amountCents: v.number(),
        count: v.number(),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { accountRowId, breakdown }) => {
    await ctx.db.patch(accountRowId, {
      pendingBreakdown: breakdown,
      pendingBreakdownAsOf: Date.now(),
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * How long a completed snapshot is considered fresh enough to reuse.
 *
 * The founder asked for the page to "sync every time I open" it, and this is
 * the smallest brake that honours that without letting a page load become a
 * denial-of-service on two vendors. One minute means a treasurer who opens the
 * page, reads it, and opens it again is looking at live figures, while a
 * component that remounts on every keystroke costs one call a minute.
 */
const SNAPSHOT_FRESH_MS = 60 * 1000;

/**
 * How long an in-flight snapshot blocks others before it is presumed dead.
 *
 * The lock exists so two page opens a second apart don't both call Increase and
 * Stripe. It has to expire, because an action that crashes between claiming and
 * finishing would otherwise wedge every future refresh — permanently, silently,
 * and in a way that looks exactly like "the page just isn't updating". Two
 * minutes is comfortably longer than the snapshot's worst case (a handful of
 * sequential HTTP calls) and short enough that nobody notices the recovery.
 */
const SNAPSHOT_LOCK_MS = 2 * 60 * 1000;

/**
 * Decide — transactionally — whether this caller gets to run a snapshot.
 *
 * A Convex mutation is the only place this check can honestly live. Doing it in
 * the action would read, then decide, then act, with every other caller free to
 * do the same in between; doing it on the client would forget on every remount
 * and wouldn't know about the other three people with the page open.
 */
export const claimBalanceSnapshot = internalMutation({
  args: {
    /** A human pressed Refresh. Skips the freshness check (they can see the
     *  "as of" and have decided it isn't good enough) but NOT the in-flight
     *  lock, which exists to stop concurrent callers, not impatient ones. */
    force: v.boolean(),
  },
  returns: v.object({ proceed: v.boolean() }),
  handler: async (ctx, { force }) => {
    const now = Date.now();
    const row = await ctx.db.query("financeSettings").first();
    if (!row) {
      // No settings row yet — nothing to lock against, and the snapshot's own
      // writes will create one. Let it run.
      return { proceed: true };
    }
    const running = row.balanceSnapshotRunningSince;
    if (running != null && now - running < SNAPSHOT_LOCK_MS) {
      return { proceed: false };
    }
    const last = row.balanceSnapshotAt;
    if (!force && last != null && now - last < SNAPSHOT_FRESH_MS) {
      return { proceed: false };
    }
    await ctx.db.patch(row._id, {
      balanceSnapshotRunningSince: now,
      updatedAt: now,
    });
    return { proceed: true };
  },
});

/**
 * How often opening the accounts page may ask Stripe to re-pull the Financial
 * Connections transaction feed — the live feed for the Relay bank account.
 *
 * MUCH slower than the 60-second balance window on purpose. A balance read is
 * one cheap GET per vendor and its answer is instant, so re-reading it on demand
 * is reasonable. An FC refresh is a heavyweight operation Stripe rate-limits on
 * its own budget, and it is ASYNCHRONOUS — it POSTs a request, Stripe pulls the
 * history in the background, and the rows land seconds to minutes later via a
 * webhook or the bounded fallback re-syncs. Asking twice in quick succession
 * cannot make them arrive sooner; it only spends rate limit.
 *
 * Which is also why `force` does NOT skip this one. "I pressed Refresh" is a
 * good reason to re-read a number that will be current the moment it returns; it
 * is not a reason to re-issue a request whose result is already in flight.
 */
const FC_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Decide — transactionally, for the same reasons as `claimBalanceSnapshot` —
 * whether this page open gets to kick off an FC transaction refresh.
 *
 * Stamps optimistically (before the refresh is known to have succeeded) so a
 * vendor outage can't turn every subsequent page open into another attempt. The
 * scheduled cron sweep is the backstop that recovers a missed window.
 */
export const claimFcRefresh = internalMutation({
  args: {},
  returns: v.object({ proceed: v.boolean() }),
  handler: async (ctx) => {
    const now = Date.now();
    const row = await ctx.db.query("financeSettings").first();
    if (!row) return { proceed: true };
    const last = row.fcRefreshAt;
    if (last != null && now - last < FC_REFRESH_INTERVAL_MS) {
      return { proceed: false };
    }
    await ctx.db.patch(row._id, { fcRefreshAt: now, updatedAt: now });
    return { proceed: true };
  },
});

/** Release the lock and stamp "we last looked at" — the page's "as of". */
export const finishBalanceSnapshot = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const row = await ctx.db.query("financeSettings").first();
    if (row) {
      await ctx.db.patch(row._id, {
        balanceSnapshotAt: now,
        balanceSnapshotRunningSince: undefined,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("financeSettings", {
        sandboxMode: false,
        balanceSnapshotAt: now,
        updatedAt: now,
      });
    }
    return null;
  },
});

/** Org-level Stripe balance snapshot — one Stripe account, so not per-book. */
export const saveStripeBalance = internalMutation({
  args: { availableCents: v.number(), pendingCents: v.number() },
  returns: v.null(),
  handler: async (ctx, { availableCents, pendingCents }) => {
    const row = await ctx.db.query("financeSettings").first();
    const patch = {
      stripeAvailableCents: availableCents,
      stripePendingCents: pendingCents,
      stripeBalanceAsOf: Date.now(),
      updatedAt: Date.now(),
    };
    if (row) await ctx.db.patch(row._id, patch);
    else await ctx.db.insert("financeSettings", { sandboxMode: false, ...patch });
    return null;
  },
});

/**
 * Org-level Givebutter balance snapshot. Same shape and spirit as
 * `saveStripeBalance` — one Givebutter account, so not per-book, and display /
 * reconciliation only. The figure is DERIVED rather than read; see
 * `givebutterSync.ts#fetchGivebutterUndepositedCents`.
 */
export const saveGivebutterBalance = internalMutation({
  args: { undepositedCents: v.number() },
  returns: v.null(),
  handler: async (ctx, { undepositedCents }) => {
    const row = await ctx.db.query("financeSettings").first();
    const patch = {
      givebutterUndepositedCents: undepositedCents,
      givebutterBalanceAsOf: Date.now(),
      updatedAt: Date.now(),
    };
    if (row) await ctx.db.patch(row._id, patch);
    else
      await ctx.db.insert("financeSettings", { sandboxMode: false, ...patch });
    return null;
  },
});

/**
 * Record what the Relay account holds — the one balance on this page a human
 * types rather than a machine fetches.
 *
 * Relay has no integration to read (it reaches this codebase only as a
 * `relay_csv` import source and a `legacy` card label), and it still holds real
 * money while the org migrates off it. The alternatives were to leave a genuine
 * pile out of a panel whose whole job is to locate every pile, or to call it
 * zero. Both are worse than a stated figure with a name and a date on it, which
 * is what this writes.
 *
 * `asOf` is when the person says the figure was TRUE, not when they typed it —
 * they may be reading yesterday's statement — and it defaults to now when
 * omitted. It is stored separately from the singleton's `updatedAt` because that
 * field moves whenever any unrelated finance policy is edited, which would make
 * a months-old Relay figure look freshly confirmed.
 *
 * Passing `null` CLEARS the figure (back to "never recorded") rather than
 * setting zero — the right move once Relay is finally drained and closed, and
 * distinct from asserting it holds nothing.
 *
 * Gated on a central ED/FM, the same gate as every other org-wide finance lever;
 * this is deployment-wide money, not a chapter's.
 */
export const setRelayBalance = mutation({
  args: {
    balanceCents: v.union(v.number(), v.null()),
    asOf: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, { balanceCents, asOf }) => {
    await requireCentralEdOrFm(ctx);
    const setBy = (await requireUserId(ctx)) as Id<"users">;
    const now = Date.now();

    if (balanceCents !== null) {
      if (!Number.isInteger(balanceCents)) {
        throw new ConvexError({
          code: "INVALID_ARGUMENT",
          message: "The Relay balance must be a whole number of cents.",
        });
      }
      // A negative bank balance is a real thing (an overdrawn account), so it is
      // allowed. A figure dated in the FUTURE is not — it would sort as the
      // freshest number on the page forever and never go stale.
      if (asOf != null && asOf > now) {
        throw new ConvexError({
          code: "INVALID_ARGUMENT",
          message: "The Relay balance can't be dated in the future.",
        });
      }
    }

    const patch =
      balanceCents === null
        ? {
            relayBalanceCents: undefined,
            relayBalanceAsOf: undefined,
            relayBalanceSetBy: undefined,
          }
        : {
            relayBalanceCents: balanceCents,
            relayBalanceAsOf: asOf ?? now,
            relayBalanceSetBy: setBy,
          };

    const row = await ctx.db.query("financeSettings").first();
    if (row) {
      await ctx.db.patch(row._id, {
        ...patch,
        updatedBy: setBy,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("financeSettings", {
        sandboxMode: false,
        ...patch,
        updatedBy: setBy,
        updatedAt: now,
      });
    }
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
  /** False when a human pressed "pay out now" in the Stripe dashboard rather
   *  than the payout schedule producing it. See `stripePayouts.automatic`. */
  automatic?: boolean;
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
    // Carry Stripe's OWN message into the error, not just the status. A payout
    // allocation that fails writes this string to `stripePayouts.error`, and
    // "Stripe request failed (400)" told a reader nothing they could act on —
    // the reason was only ever in the logs, which had rotated by the time
    // anyone looked (po_1U1qk8Qv9S5xW6eKsjkeLJvv, 2026-08-07).
    let detail = "";
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; param?: string } };
      const msg = parsed.error?.message;
      const param = parsed.error?.param;
      if (msg) detail = ` ${msg}${param ? ` (param: ${param})` : ""}`;
    } catch {
      if (text) detail = ` ${text.slice(0, 200)}`;
    }
    throw new ConvexError({
      code: "STRIPE_ERROR",
      message: `Stripe request failed (${res.status}).${detail}`,
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

// ── Balance snapshot (shared by the morning engine and the page's refresh) ───

/** Pages of `GET /pending_transactions` to read per account. 100 per page, so
 *  this covers 300 open pending items — far past anything a chapter produces,
 *  and a hard stop on an account that somehow has thousands. */
const PENDING_TXN_PAGES = 3;

/**
 * Read each Increase account's balance + Stripe's, and cache them.
 *
 * Extracted from `runEngine` so the accounts page can refresh the SAME figures
 * on open without running the engine. That separation is the point, not a
 * convenience: the engine books ledger rows and (when real movement is on)
 * moves actual cash between bank accounts, and opening a page must never do
 * either. This function only reads — every write it makes is to a cached
 * display figure.
 *
 * ALL BEST-EFFORT. A processor being down is not a reason to fail a
 * reconciliation run, and a stale balance is visibly stale (`balanceAsOf`)
 * rather than silently wrong. A failed fetch leaves the previous value alone.
 *
 * One caller-visible caveat: `settleChapterBalances` settles against
 * `increaseAccounts.balanceCents`, which this writes. That is deliberate and
 * safe — the morning run snapshots immediately before settling precisely so it
 * settles against a fresh figure, and a page-open refresh can only make that
 * figure fresher.
 */
async function snapshotBalances(ctx: ActionCtx): Promise<void> {
  const accounts: {
    accountRowId: Id<"increaseAccounts">;
    increaseAccountId: string;
  }[] = await ctx.runQuery(internal.reconciliation.listAccountsForSnapshot, {});

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
      const available =
        typeof balance.available_balance === "number"
          ? balance.available_balance
          : null;
      const current =
        typeof balance.current_balance === "number"
          ? balance.current_balance
          : null;
      const cents = available ?? current;
      // ── WHAT `current − available` ACTUALLY IS ───────────────────────────
      // Increase: "The available balance […] is calculated as the current
      // balance minus the sum of all negative Pending Transactions." So the
      // difference is EVERY pending item, of which `card_authorization` is one
      // category among roughly sixteen — outbound ACH/wire/check instructions
      // and inbound-funds holds land here too. This code called it "card
      // authorizations" until 2026-08-08; the total was right, the name was
      // not, and `pendingBreakdown` below now itemises it so nobody has to
      // take either on trust.
      //
      // Non-negative by construction: a POSITIVE pending transaction (an
      // unsettled card refund) does not raise the available balance, so
      // available can never exceed current. The clamp is belt-and-braces
      // against a provider surprise, not a case we expect.
      const pendingCents =
        available != null && current != null
          ? Math.max(0, current - available)
          : undefined;
      if (cents != null) {
        await ctx.runMutation(internal.reconciliation.saveAccountBalance, {
          accountRowId: account.accountRowId,
          balanceCents: cents,
          ...(pendingCents !== undefined ? { pendingCents } : {}),
        });
      }
    } catch (err) {
      // Display-only data — log and move on.
      console.error(
        `[reconciliation] balance snapshot failed for ${account.increaseAccountId}`,
        err,
      );
    }

    // What the pending total is MADE OF. A separate, separately-failing call:
    // the total above is the one the reconciliation arithmetic depends on, and
    // it must not be lost because the itemisation endpoint had a bad minute.
    try {
      const byCategory = new Map<string, { amountCents: number; count: number }>();
      let cursor: string | undefined;
      for (let page = 0; page < PENDING_TXN_PAGES; page++) {
        const params = new URLSearchParams();
        params.set("account_id", account.increaseAccountId);
        // `status.in`, NOT `status.in[]`. Increase encodes a nested parameter by
        // joining the path with a dot and rejects the bracket form outright:
        // "Nested parameters should be encoded in the query string by joining
        // them with the '.' character". The bracket version 400s on every call,
        // and because this whole block is best-effort the failure only ever
        // reached a log line — the itemisation silently returned nothing from
        // the day it shipped. Verified against the live API: the dotted form
        // returns the three rows totalling $184.08 that the cached balance
        // already implied.
        //
        // `complete` pending transactions have already become real transactions
        // and are no longer held against the available balance, so including
        // them would overstate the total.
        params.set("status.in", "pending");
        params.set("limit", "100");
        if (cursor) params.set("cursor", cursor);
        const body = await increaseGet(
          incKey,
          base,
          `/pending_transactions?${params.toString()}`,
        );
        const rows = (body.data ?? []) as Array<{
          amount?: number;
          /** The kind lives on `source`, NOT at the top level — a Pending
           *  Transaction's top level carries only `type`, `route_type` and the
           *  money. Reading `row.category` (which is simply absent) put every
           *  row in "other", so the itemisation existed but said nothing. */
          source?: { category?: string };
        }>;
        for (const row of rows) {
          if (typeof row.amount !== "number") continue;
          // Real values seen in production: `card_authorization` and
          // `ach_transfer_instruction`. That second one is the reason this
          // rollup is worth having — an outbound ACH the org initiated is
          // pending money that is NOT card spend, and calling the whole figure
          // "card authorizations" (as this panel once did) sends a reader
          // hunting for a card charge that does not exist.
          const category = row.source?.category ?? "other";
          const entry = byCategory.get(category) ?? { amountCents: 0, count: 0 };
          entry.amountCents += row.amount;
          entry.count += 1;
          byCategory.set(category, entry);
        }
        const next = body.next_cursor;
        if (typeof next !== "string" || next.length === 0) break;
        cursor = next;
      }
      await ctx.runMutation(internal.reconciliation.savePendingBreakdown, {
        accountRowId: account.accountRowId,
        breakdown: [...byCategory.entries()]
          .map(([category, e]) => ({ category, ...e }))
          // Biggest absolute mover first — a reader scanning this wants the
          // line that explains most of the total, not alphabetical order.
          .sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents)),
      });
    } catch (err) {
      console.error(
        `[reconciliation] pending itemisation failed for ${account.increaseAccountId}`,
        err,
      );
    }
  }

  // Stripe's own balance, in the same best-effort spirit. Money sitting at the
  // processor is real money the org holds and the accounts page could not see
  // it — every figure there was either a book total or an Increase balance, so
  // funds in transit looked like they had vanished.
  const key = process.env.STRIPE_SECRET_KEY;
  if (key) {
    try {
      const bal = await stripeGet(key, "/balance");
      const sumUsd = (arr: unknown): number =>
        Array.isArray(arr)
          ? arr
              .filter(
                (b): b is { amount: number; currency: string } =>
                  typeof (b as { amount?: unknown })?.amount === "number" &&
                  (b as { currency?: unknown })?.currency === "usd",
              )
              .reduce((sum, b) => sum + b.amount, 0)
          : 0;
      await ctx.runMutation(internal.reconciliation.saveStripeBalance, {
        availableCents: sumUsd(bal.available),
        pendingCents: sumUsd(bal.pending),
      });
    } catch (err) {
      console.error("[reconciliation] Stripe balance snapshot failed", err);
    }
  }

  // Givebutter's balance, same best-effort spirit again. The second processor
  // holds real money the accounts page could not see, for the identical reason
  // Stripe's did: revenue is counted at the ticket/gift days before Givebutter
  // remits it.
  //
  // Unlike the other two this one is DERIVED from the transaction feed rather
  // than read from a balance endpoint (Givebutter publishes none), so it costs a
  // handful of paged calls instead of one — see
  // `givebutterSync.ts#fetchGivebutterUndepositedCents`. It stays inside the
  // same throttle as everything else here, and it self-selects: no API key
  // configured returns null and writes nothing at all.
  try {
    const undepositedCents = await fetchGivebutterUndepositedCents(ctx);
    if (undepositedCents != null) {
      await ctx.runMutation(internal.reconciliation.saveGivebutterBalance, {
        undepositedCents,
      });
    }
  } catch (err) {
    console.error("[reconciliation] Givebutter balance snapshot failed", err);
  }

  // Stamped LAST and unconditionally: this is "when we last went and looked",
  // which is the honest thing to show beside figures that are individually
  // best-effort. A run where Stripe was down still looked.
  await ctx.runMutation(internal.reconciliation.finishBalanceSnapshot, {});
}

// ── The engine core (shared by cron, webhook, and manual runs) ───────────────

async function runEngine(
  ctx: ActionCtx,
  trigger: "cron" | "manual" | "webhook",
  onlyPayoutId?: string,
): Promise<void> {
  const settings: {
    paused: boolean;
    sinceMs: number | null;
    realMovement: boolean;
  } = await ctx.runQuery(internal.reconciliation.engineSettings, {});
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
    // Stripe's `arrival_date` is midnight UTC of the arrival DAY, while
    // `sinceMs` is stamped mid-day — compare at day granularity or payouts
    // arriving on the activation day itself would be silently unreachable
    // forever (midnight < mid-day, every run).
    const sinceDayMs = Math.floor(sinceMs / DAY_MS) * DAY_MS;

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
          params.set("arrival_date[gte]", String(Math.floor(sinceDayMs / 1000)));
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
        if (arrivalMs < sinceDayMs) continue; // pre-start-date payout (webhook path)
        const { processState } = await ctx.runMutation(
          internal.reconciliation.upsertDetectedPayout,
          {
            stripePayoutId: po.id,
            amountCents: Math.round(po.amount ?? 0),
            currency: (po.currency ?? "usd").toLowerCase(),
            stripeStatus: po.status ?? "unknown",
            arrivalDate: arrivalMs,
            ...(typeof po.automatic === "boolean"
              ? { automatic: po.automatic }
              : {}),
          },
        );
        if (po.status !== "paid") continue;
        // An ALLOCATED payout never re-fetches Stripe — its balance
        // transactions don't change, and re-paging every historical payout
        // each morning would grow the run without bound. Only the (fetch-free)
        // deposit match retries until the bank feed syncs the arrival in.
        // ── NO PER-PAYOUT ALLOCATION ANY MORE ─────────────────────────────
        // A payout is now just cash arriving at central. Its only job here is
        // to find its bank deposit and label it, so `signedBookCents` returns 0
        // for that row instead of counting already-counted revenue twice.
        // `settleChapterBalances` moves the money to the chapters afterwards,
        // from what their books say they're owed.
        //
        // The itemisation this replaced could not survive contact with real
        // payouts: Stripe refuses to itemise a manually-initiated one
        // ("Balance transaction history can only be filtered on automatic
        // transfers"), Givebutter has no API to itemise at all, and the legs it
        // produced contributed ZERO to book value. It was elaborate machinery
        // for a number that was already correct.
        const matched: { depositMatched: boolean } = await ctx.runMutation(
          internal.reconciliation.retryDepositMatch,
          { stripePayoutId: po.id },
        );
        payoutsProcessed += 1;
        if (!matched.depositMatched) {
          notes.push(
            `Payout ${po.id}: bank deposit not found yet — will retry next run.`,
          );
        }
        continue;
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

    // ── 5: real cash movement (only when the FM has turned it on) ───────────
    // Runs AFTER settlement so the day's freshly-booked pairs move the same
    // morning. Production accounts only; each pair executes as ONE Increase
    // account-to-account transfer with Idempotency-Key = the pair's
    // transferGroupId, so a crashed run re-sending the same movement is a
    // provider-side no-op. Skipped entirely on the webhook fast-path — cash
    // moves once a day, under the morning run's full audit trail.
    if (trigger !== "webhook" && settings.realMovement) {
      const { key: incKey, base: incBase } = increaseEnvForMode(false);
      if (!incKey) {
        notes.push(
          "Real movement is ON but the production Increase key isn't configured — no cash moved.",
        );
      } else {
        const pending: {
          transferGroupId: string;
          chapterId: Id<"chapters">;
          direction: "central_to_chapter" | "chapter_to_central";
          amountCents: number;
        }[] = await ctx.runQuery(
          internal.reconciliation.listUnexecutedEnginePairs,
          {},
        );
        let moved = 0;
        const notReady = new Set<string>();
        // One account lookup per distinct chapter, not per pair.
        const accountsByChapter = new Map<
          string,
          { centralAccountId: string | null; chapterAccountId: string | null }
        >();
        for (const pair of pending) {
          let accounts = accountsByChapter.get(pair.chapterId);
          if (!accounts) {
            accounts = await ctx.runQuery(
              internal.reconciliation.productionAccountIds,
              { chapterId: pair.chapterId },
            );
            accountsByChapter.set(pair.chapterId, accounts);
          }
          if (!accounts.centralAccountId || !accounts.chapterAccountId) {
            notReady.add(pair.chapterId);
            continue;
          }
          const [sourceId, destId] =
            pair.direction === "central_to_chapter"
              ? [accounts.centralAccountId, accounts.chapterAccountId]
              : [accounts.chapterAccountId, accounts.centralAccountId];
          try {
            // Idempotency-Key = the pair's transferGroupId, STABLE across
            // runs on purpose: the failure mode that must be impossible is a
            // double-send (a crashed run that DID create the transfer but
            // died before stamping retries next morning and gets the same
            // transfer back, not a second one). The accepted cost: if the
            // provider caches an ERROR response under the key, that pair can
            // wedge — it stays visibly "Cash not moved" with a FAILED note
            // every run, and the human fix is a manual bank transfer.
            const transfer = await increasePost(
              incKey,
              incBase,
              "/account_transfers",
              {
                account_id: sourceId,
                destination_account_id: destId,
                amount: pair.amountCents,
                description: `Chapter OS ${pair.transferGroupId}`.slice(0, 80),
              },
              pair.transferGroupId,
            );
            const transferId =
              typeof transfer.id === "string" ? transfer.id : null;
            const status =
              typeof transfer.status === "string" ? transfer.status : "unknown";
            if (transferId && status !== "pending_approval" && status !== "canceled") {
              // Stamped only once the transfer is actually underway — a
              // pending-approval transfer that later gets DECLINED must not
              // read as "cash moved" forever.
              await ctx.runMutation(internal.reconciliation.stampPairMoved, {
                transferGroupId: pair.transferGroupId,
                increaseTransferId: transferId,
              });
              moved += 1;
            } else if (transferId && status === "pending_approval") {
              notes.push(
                `Real movement for ${pair.transferGroupId} needs APPROVAL in the Increase dashboard (${transferId}) — not marked moved until it completes.`,
              );
            } else {
              notes.push(
                `Real movement for ${pair.transferGroupId}: unexpected Increase response (status ${status}) — will retry next run.`,
              );
            }
          } catch (err) {
            // Leave the pair unstamped — next morning retries under the same
            // idempotency key, so no double-send is possible.
            console.error(
              `[reconciliation] real movement failed for ${pair.transferGroupId}`,
              err,
            );
            notes.push(
              `Real movement FAILED for ${pair.transferGroupId} — will retry next run.`,
            );
          }
        }
        if (moved > 0) {
          notes.push(`Moved real cash for ${moved} transfer pair(s).`);
        }
        if (notReady.size > 0) {
          notes.push(
            `Real movement waiting on active production Increase accounts for ${notReady.size} chapter(s).`,
          );
        }
      }
    }

    // ── 6: bank-balance snapshot (best-effort, display only) ────────────────
    if (trigger !== "webhook") {
      await snapshotBalances(ctx);

      // ── 7: processor fees (best-effort) ──────────────────────────────────
      // Nothing ran the fee sweep automatically, so the still-running month's
      // fee row sat wherever the last manual run left it — on 2026-08-08 the
      // August row was still dated Aug 31, a transaction in the future, and it
      // would have stayed there until somebody remembered. It self-corrects the
      // moment the sweep runs, so the fix is to run it every morning.
      //
      // BEFORE the settlement below, for the same reason the balance snapshot
      // is: fees are an expense, so booking them moves BOOK value, and settling
      // first would move real cash against a book that is about to change.
      //
      // Best-effort like the snapshots — a bookkeeping line must never take the
      // rest of the morning's run (including cash movement) down with it.
      //
      // The sweep re-reads the WHOLE Stripe ledger each time (it is what makes
      // the sync idempotent), which at this org's volume is a few hundred
      // balance transactions and a handful of pages. If that ever grows to the
      // point where a daily full sweep is the wrong shape, bound it by date
      // HERE — the manual `syncStripeFees` should keep re-reading everything.
      if (key) {
        try {
          const fees: {
            created: number;
            updated: number;
            marked: number;
          } = await ctx.runAction(internal.processorFees.syncStripeFeesOps, {
            execute: true,
          });
          if (fees.created > 0 || fees.updated > 0) {
            notes.push(
              `Refreshed Stripe processor fees (${fees.created} new, ${fees.updated} updated monthly row(s)).`,
            );
          }
          // The old fee-budget notes are gone with the fee budgets themselves.
          // They existed to nag a human into approving a draft budget the cron
          // had proposed to itself — a note that fired every morning about a
          // decision nobody should have been asked to make.
        } catch (err) {
          console.error("[reconciliation] processor fee sync failed", err);
          notes.push(
            "Stripe processor fee sync FAILED — fee rows may be stale; will retry next run.",
          );
        }
      }

      // ── 7b: Givebutter's fee, same step and same reasoning ────────────────
      // OUTSIDE the `if (key)` above deliberately — that gate is Stripe's key,
      // and Givebutter resolves its own (returning a no-op when there isn't
      // one). Gating a Givebutter read on a Stripe secret is the kind of
      // coupling that goes unnoticed until one of them is rotated.
      //
      // Runs even though Givebutter is being wound down: it holds money and
      // takes a cut for as long as it does, and a fee that stops being booked
      // is indistinguishable from a fee that was never charged.
      try {
        const gbFees: {
          created: number;
          updated: number;
          totalFeeCents: number;
        } = await ctx.runAction(internal.processorFees.syncGivebutterFeesOps, {
          execute: true,
        });
        if (gbFees.created > 0 || gbFees.updated > 0) {
          notes.push(
            `Refreshed Givebutter processor fees (${gbFees.created} new, ${gbFees.updated} updated monthly row(s)).`,
          );
        }
      } catch (err) {
        console.error("[reconciliation] Givebutter fee sync failed", err);
        notes.push(
          "Givebutter processor fee sync FAILED — fee rows may be stale; will retry next run.",
        );
      }

      // ── In-person sales, same best-effort spirit ─────────────────────────
      // `syncStripeSales` was manual-only from the day it shipped, so the Sales
      // tab silently froze at whatever the last hand-run imported — the owner
      // sold PW Tees at an event and found none of them there (2026-08-09).
      // Nothing in the product said the data was stale, which is the same shape
      // as the fee row that sat future-dated for want of a run.
      //
      // Idempotent on the Stripe charge id, so a daily full sweep re-imports
      // nothing. Runs AFTER the fee sweep and BEFORE the balance settlement for
      // the same reason fees do: a sale is revenue, and settling cash against a
      // book that is about to gain $150 of tee sales moves the wrong amount.
      if (key) {
        try {
          const sales: {
            created: number;
            alreadyPresent: number;
            enriched: number;
            unresolved: number;
            grossCents: number;
          } = await ctx.runAction(internal.salesSync.syncStripeSalesOps, {
            execute: true,
          });
          if (sales.created > 0) {
            notes.push(
              `Imported ${sales.created} in-person sale(s), ${formatCents(sales.grossCents)} gross` +
                (sales.unresolved > 0
                  ? ` — ${sales.unresolved} banked without an item breakdown.`
                  : "."),
            );
          }
          // Reported separately from `created` BECAUSE IT MOVES NO MONEY. An
          // enrichment patches `items`/`itemSource` on a sale already in the
          // books, so it must never read as an import — a reader who saw these
          // folded into the count above would think revenue had grown.
          if (sales.enriched > 0) {
            notes.push(
              `Filled in the item breakdown on ${sales.enriched} sale(s) already imported — no revenue change.`,
            );
          }
        } catch (err) {
          console.error("[reconciliation] sales sync failed", err);
          notes.push(
            "In-person sales sync FAILED — the Sales tab may be stale; will retry next run.",
          );
        }
      }

      // ── 8: bring each chapter's CASH to its BOOK ─────────────────────────
      // Deliberately the LAST step, and deliberately after BOTH the balance
      // snapshot and the fee sweep. It compares book against bank, so it needs
      // the bank figure fetched moments ago rather than yesterday's — and it
      // needs the book figure to have stopped moving. Fees are an expense, so
      // booking them changes book value; settling before they land moves cash
      // against a book that is about to change. Either ordering mistake is the
      // one class of bug here that reaches real money.
      const balSettle: {
        settlementsBooked: number;
        movedCents: number;
        notes: string[];
      } = await ctx.runMutation(
        internal.reconciliation.settleChapterBalances,
        { dateStr: easternDateStr(Date.now()) },
      );
      settlementsBooked += balSettle.settlementsBooked;
      allocatedCents += balSettle.movedCents;
      notes.push(...balSettle.notes);
      if (balSettle.settlementsBooked > 0) {
        notes.push(
          `Brought ${balSettle.settlementsBooked} chapter(s) to their book value.`,
        );
      }
    }

    await finish("ok");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[reconciliation] run failed:", err);
    await finish("error", message);
  }
}

/** The morning cron entry (see `crons.ts`) — full sweep, in this order and for
 *  the reasons spelled out at each step: label payout deposits, settle
 *  cross-book card spend, move cash, snapshot balances, book processor fees,
 *  then bring each chapter's cash to its book. ("Allocate" is gone: #553
 *  replaced per-payout allocation with settling chapters against their books.)
 *  No-ops per part when its vendor key is unset. */
export const runMorningReconciliation = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await runEngine(ctx, "cron");
    return null;
  },
});

/** Webhook fast-path (`payout.paid` etc. — see `http.ts`): detect ONE payout
 *  and label its deposit as soon as Stripe announces it, so the books don't
 *  wait for morning. Settlement, snapshots and fees stay with the morning run. */
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

/**
 * Ask Stripe to re-pull the Financial Connections transaction feeds — the live
 * feed for the org's Relay bank account.
 *
 * The founder, 2026-08-08: "there is also transactions from relay that either
 * havent been synced or is still pending, we need to make sure relay is synced
 * when we open the page." A balance refresh alone could not answer that: FC rows
 * arrive on Stripe's schedule, so the reconcile queue could be missing days of
 * Relay activity while the page confidently reported a gap caused by exactly
 * those missing rows.
 *
 * FIRE-AND-FORGET, THREE WAYS, and each one matters:
 *
 *  · It SCHEDULES rather than awaits. `refreshAllActiveFcAccounts` only asks
 *    Stripe to start fetching; the rows land later via the FC webhook or the
 *    bounded fallback re-syncs in `stripeFinance.ts`. Blocking the page on it
 *    would buy a slower render and not one extra row.
 *  · It CANNOT fail the caller. Everything is inside a catch that logs, so a
 *    Stripe outage leaves the balances that did refresh intact and the panel
 *    renders exactly as before. Looking at the books must never break the page.
 *  · It is IDEMPOTENT downstream. FC rows dedup on
 *    `transactions.externalId` (`"stripe_fc:"+<id>`), so overlapping with the
 *    webhook, the nightly `syncAllAccounts` cron, or another viewer's page open
 *    can never double-record a transaction. Re-syncing is also how a PENDING row
 *    becomes posted, which is the other half of what was asked for.
 *
 * SCOPE — every ACTIVE legacy account, not a Relay-specific lookup. Today those
 * are the same thing (production holds exactly one active `legacyAccounts` row:
 * Relay Financial, ••4207), and "any connected legacy bank should be current
 * when I open the reconciliation page" is the rule that stays right if a second
 * one is ever connected. Bounded by the same `ACCOUNT_SCAN_LIMIT` sweep the ops
 * escape hatch uses, so the cost cannot run away with the account list.
 */
async function refreshLegacyTransactionFeeds(ctx: ActionCtx): Promise<void> {
  try {
    const { proceed }: { proceed: boolean } = await ctx.runMutation(
      internal.reconciliation.claimFcRefresh,
      {},
    );
    if (!proceed) return;
    await ctx.scheduler.runAfter(
      0,
      internal.stripeFinance.refreshAllActiveFcAccounts,
      {},
    );
  } catch (err) {
    // Never rethrow: the balance refresh this rides along with must still run.
    console.error(
      "[reconciliation] could not start the legacy (Relay) feed refresh",
      err,
    );
  }
}

/**
 * Bring the page's inputs up to date — READ-ONLY, and nothing beyond that.
 *
 * Two jobs, on two separate throttles:
 *   1. Re-read every balance (Increase per account, Stripe, Givebutter).
 *   2. Ask Stripe to re-pull the Financial Connections transaction feeds — the
 *      live Relay feed. See `refreshLegacyTransactionFeeds`.
 *
 * The accounts page calls this when it opens. The founder, 2026-08-08: "I need
 * it to sync every time I open the page." Before this the only thing that ever
 * refreshed a balance was the morning cron, so an FM opening the page at 4pm
 * was asked whether the books matched the bank using a bank figure from 5am.
 *
 * DELIBERATELY NOT `runEngine`. That books ledger rows, settles chapters
 * against their books, and — when real cash movement is on — executes real
 * bank transfers. Wiring any of that to a page load would mean the act of
 * LOOKING at the books could change them, and a burst of tab-switching could
 * move money.
 *
 * The FC refresh is the one thing here that WRITES rows rather than updating a
 * cached figure, so it is worth being precise about why that is still read-only
 * in the sense that matters: it imports the bank's own record of what already
 * happened, into `status:"unreviewed"`, deduped on `externalId`. It records no
 * decision, moves no money, and books nothing — it is the same import the
 * nightly cron performs, just triggered by someone opening the page.
 *
 * Throttled server-side (see `claimBalanceSnapshot`) rather than in the
 * component, because the thing being protected is a rate limit at Increase and
 * Stripe, and client state doesn't survive a remount or know about the other
 * people with this page open.
 *
 * Returns whether it actually went out, so the UI can distinguish "refreshed"
 * from "already fresh" instead of claiming a sync it didn't do.
 */
export const refreshBalancesNow = action({
  args: {
    /** A human pressed Refresh — bypass the freshness window (not the lock). */
    force: v.optional(v.boolean()),
  },
  returns: v.object({ refreshed: v.boolean() }),
  handler: async (ctx, { force }) => {
    await ctx.runQuery(internal.reconciliation.assertAuditAccess, {});

    // The Relay transaction feed, on its own much slower clock. Claimed BEFORE
    // the balance throttle's early return on purpose: the two protect different
    // vendors on different budgets, and a page opened inside the 60-second
    // balance window should still be allowed to start an FC pull that is
    // fifteen minutes overdue.
    await refreshLegacyTransactionFeeds(ctx);

    const { proceed }: { proceed: boolean } = await ctx.runMutation(
      internal.reconciliation.claimBalanceSnapshot,
      { force: force ?? false },
    );
    if (!proceed) return { refreshed: false };
    // `snapshotBalances` releases the lock on its own last line. It swallows
    // every vendor error internally, so the only way out without releasing is a
    // crash of the action host — which `SNAPSHOT_LOCK_MS` is there to recover
    // from.
    await snapshotBalances(ctx);
    return { refreshed: true };
  },
});

/**
 * Turn real cash movement on/off. THE money-movement gate: with this off
 * (the default) the engine only ever writes ledger entries; turning it on is
 * the Financial Manager's standing authorization for the morning run to
 * execute engine-booked pairs as real Increase account-to-account transfers.
 */
export const setRealMovementEnabled = mutation({
  args: { enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { enabled }) => {
    await requireReconciliationAudit(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const existing = await ctx.db.query("financeSettings").first();
    // Enabling (re)stamps the cutoff: only pairs booked FROM THIS MOMENT
    // execute. The backlog booked while the toggle was off never auto-moves
    // — moving older cash is a deliberate manual bank transfer.
    const stamp = enabled ? { autoTransferRealMovementSinceMs: Date.now() } : {};
    if (existing) {
      await ctx.db.patch(existing._id, {
        autoTransferRealMovement: enabled,
        ...stamp,
        updatedBy: userId,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("financeSettings", {
        sandboxMode: false,
        autoTransferRealMovement: enabled,
        ...stamp,
        updatedBy: userId,
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

/** Pause/resume the engine — THE kill switch: a paused run books nothing and
 *  (since real movement runs inside the morning run) moves no cash either.
 *  Pausing is deliberately one friction-free tap. */
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
  /** Stripe's `automatic` flag; null for payouts detected before we recorded
   *  it. `false` is the whole explanation for the one scary error this list has
   *  ever shown — see `stripePayouts.automatic`. */
  automatic: v.union(v.boolean(), v.null()),
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
    realMovement: v.boolean(),
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
        automatic: po.automatic ?? null,
        // An `error` is only meaningful alongside a Stripe status that says
        // something went wrong. Nothing has written this field since #553
        // removed the allocation step, so anything still stored on a healthy
        // payout describes work the engine no longer attempts — showing it
        // reads as a live problem and is not one. `upsertDetectedPayout` clears
        // those on sight; this makes sure one never renders in the meantime.
        error:
          po.stripeStatus === "failed" || po.stripeStatus === "canceled"
            ? (po.error ?? null)
            : null,
        flagged: flaggedKeys.has(po.stripePayoutId),
      });
    }

    return {
      paused: settings?.autoReconciliationPaused ?? false,
      sinceMs: settings?.autoReconciliationSinceMs ?? null,
      realMovement: settings?.autoTransferRealMovement ?? false,
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
 * Per-book balances for the accounts page — the founder's model (2026-08-07):
 * "we should be using donations and ticket sales to calculate the money we
 * have, and then use transactions from reconcile to determine money going
 * out."
 *
 *   bookBalance = revenue (gifts + paid ticket orders, per scope, GROSS of
 *                 processor fees)
 *               + ledger net (Σ `signedBookCents` — spend, corrections,
 *                 settlements; payout deposits and payout-allocation pairs
 *                 contribute ZERO there so revenue is never counted twice —
 *                 see `lib/bookBalance.ts`)
 *
 * plus the cached BANK balance where the morning snapshot has one. Book vs
 * bank differing is normal (cash pools where processors pay out; the book
 * states what each scope is worth) — the page explains that.
 */
/** A settlement smaller than this isn't worth a ledger row — the engine would
 *  book a pair every morning to chase rounding, and each row costs a reader's
 *  attention. */
const MIN_SETTLEMENT_CENTS = 500;

export type BookBalanceRow = {
  scope: FinanceScope;
  scopeName: string;
  bookBalanceCents: number;
  revenueCents: number;
  /** The slice of `revenueCents` that is in-kind — goods and services, never
   *  cash. Its offset is the expense it paid for, already in the ledger. */
  inKindRevenueCents: number;
  ledgerNetCents: number;
  truncated: boolean;
  bankBalanceCents: number | null;
  bankBalanceAsOf: number | null;
  pendingCents: number | null;
};

/**
 * Every book's value, in one place.
 *
 * Extracted so `accountBalances` (what the page shows) and
 * `settleChapterBalances` (what the engine moves money against) run the SAME
 * arithmetic. A settlement computed from its own copy could drift from the
 * number a treasurer is reading and move real cash on the difference — the one
 * way this engine could do damage that isn't visible until the bank statement.
 *
 * Ungated: both callers gate themselves (the query on the reconciliation-audit
 * power, the mutation by being internal to the engine).
 */
async function computeBookBalances(
  ctx: QueryCtx,
): Promise<BookBalanceRow[]> {

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

    const truncatedScopes = new Set<string>();
    const warnTruncated = (scope: FinanceScope, what: string) => {
      truncatedScopes.add(scope);
      console.warn(
        `[reconciliation] accountBalances hit ROLLUP_SCAN_LIMIT (${ROLLUP_SCAN_LIMIT}) reading ${what} for ${scope}; book value truncated.`,
      );
    };

    // ── Phase 1 — money in, all scopes in parallel: EVERY gift to the book
    // (all channels dual-write into `gifts`) + the book's paid ticket orders.
    //
    // IN-KIND GIFTS ARE INCLUDED (founder decision, 2026-08-07). They used to be
    // excluded on the reasoning that no cash arrives — but the expense they paid
    // for IS in the ledger, so excluding only the revenue side counted the cost
    // and not the contribution, and pushed a book negative for being given
    // things. Someone buying $500 of gear for the org is a $500 gift and a $500
    // expense; the pair nets to zero on book value, which is the honest answer.
    // The books this most affects are the genesis-era ones, where nearly every
    // expense was a founder's personal card.
    //
    // Book value is therefore NOT a cash figure and will not track the bank —
    // that is the point of having both columns. Also collects the
    // bank rows that CONFIRMED gifts link to (`gifts.transactionId`,
    // `givingCandidates.confirmExternalGift`) — a donor wiring directly to
    // the account produces a gift AND a plain-inflow bank row for the same
    // dollars, and phase 2 must skip that row or the money counts twice.
    // Collected ACROSS scopes before any ledger sum so a cross-book link
    // still excludes. Revenue is a REAL-money figure; in the sandbox demo
    // state it reads 0 so demo books stay pure sandbox-ledger numbers. ─────
    const linkedGiftTxnIds = new Set<string>();
    const revenueByScope = new Map<FinanceScope, number>();
    // IN-KIND, tracked separately for the reconciliation panel. It is a slice of
    // the revenue above, NOT an addition to it: goods and services given to the
    // org, with no cash behind them at any point. The org-wide gap has to be
    // able to say so, because in-kind revenue is the one thing on the books
    // side that legitimately has no counterpart on the cash side (its offset is
    // the expense it paid for, which is already in the ledger). Free to collect
    // — the gift scan is happening anyway.
    const inKindByScope = new Map<FinanceScope, number>();
    await Promise.all(
      scopes.map(async ({ scope }) => {
        let revenueCents = 0;
        let inKindCents = 0;
        const gifts = await ctx.db
          .query("gifts")
          .withIndex("by_scope", (q) => q.eq("scope", scope))
          .take(ROLLUP_SCAN_LIMIT);
        if (gifts.length === ROLLUP_SCAN_LIMIT) warnTruncated(scope, "gifts");
        for (const gift of gifts) {
          if (gift.transactionId != null) {
            linkedGiftTxnIds.add(gift.transactionId);
          }
          revenueCents += gift.amountCents;
          if (gift.method === "in_kind") inKindCents += gift.amountCents;
        }
        // SALES — merch, snacks, drinks (founder model 2026-08-07: "revenue = gift
        // rows, tickets, and sales"). Counted GROSS like the other two; Stripe's fee
        // is a separate expense, not a haircut on revenue. Chapter-scoped, same as
        // ticket orders — central sells nothing directly.
        if (scope !== CENTRAL) {
          const salesRows = await ctx.db
            .query("sales")
            .withIndex("by_chapter_and_soldAt", (q) => q.eq("chapterId", scope))
            .take(ROLLUP_SCAN_LIMIT);
          if (salesRows.length === ROLLUP_SCAN_LIMIT) warnTruncated(scope, "sales");
          for (const sale of salesRows) revenueCents += sale.grossCents;
        }
        if (scope !== CENTRAL) {
          const orders = await ctx.db
            .query("ticketOrders")
            .withIndex("by_chapter", (q) =>
              q.eq("chapterId", scope as Id<"chapters">),
            )
            .take(ROLLUP_SCAN_LIMIT);
          if (orders.length === ROLLUP_SCAN_LIMIT) {
            warnTruncated(scope, "ticket orders");
          }
          for (const order of orders) {
            // `totalCents` is the ticket subtotal only — an order's bundled
            // add-on donation settles as a `donations` row → gift, already
            // counted above.
            if (order.status === "paid") revenueCents += order.totalCents;
          }
        }
        revenueByScope.set(scope, sandboxMode ? 0 : revenueCents);
        inKindByScope.set(scope, sandboxMode ? 0 : inKindCents);
      }),
    );

    // ── Phase 2 — money out (and corrections): the reconcile ledger. ────────
    const out: {
      scope: FinanceScope;
      scopeName: string;
      bookBalanceCents: number;
      revenueCents: number;
      inKindRevenueCents: number;
      ledgerNetCents: number;
      truncated: boolean;
      bankBalanceCents: number | null;
      bankBalanceAsOf: number | null;
      pendingCents: number | null;
    }[] = [];
    await Promise.all(
      scopes.map(async ({ scope, scopeName: name }) => {
        const txns = await ctx.db
          .query("transactions")
          .withIndex("by_chapter", (q) => q.eq("chapterId", scope))
          .take(ROLLUP_SCAN_LIMIT);
        if (txns.length === ROLLUP_SCAN_LIMIT) {
          warnTruncated(scope, "transactions");
        }
        let ledgerNetCents = 0;
        for (const tr of txns) {
          if (!txnMatchesMode(tr, sandboxMode)) continue;
          // A bank credit a confirmed gift links to IS that gift's cash —
          // already counted in phase 1.
          if (linkedGiftTxnIds.has(tr._id)) continue;
          ledgerNetCents += signedBookCents(tr);
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
        const revenueCents = revenueByScope.get(scope) ?? 0;
        out.push({
          scope,
          scopeName: name,
          bookBalanceCents: revenueCents + ledgerNetCents,
          revenueCents,
          inKindRevenueCents: inKindByScope.get(scope) ?? 0,
          ledgerNetCents,
          truncated: truncatedScopes.has(scope),
          bankBalanceCents: account?.balanceCents ?? null,
          bankBalanceAsOf: account?.balanceAsOf ?? null,
          pendingCents: account?.pendingCents ?? null,
        });
      }),
    );
    // Parallel pushes land in arbitrary order — restore the scope order.
    const orderIndex = new Map(scopes.map((s, i) => [s.scope, i]));
    out.sort(
      (a, b) => (orderIndex.get(a.scope) ?? 0) - (orderIndex.get(b.scope) ?? 0),
    );
    return out;
}

export const accountBalances = query({
  args: {},
  returns: v.array(
    v.object({
      scope: financeScopeValidator,
      scopeName: v.string(),
      bookBalanceCents: v.number(),
      revenueCents: v.number(),
      inKindRevenueCents: v.number(),
      ledgerNetCents: v.number(),
      truncated: v.boolean(),
      bankBalanceCents: v.union(v.number(), v.null()),
      bankBalanceAsOf: v.union(v.number(), v.null()),
      /** Everything the bank has set aside but not posted — card
       *  authorizations, outbound transfers in flight, inbound-funds holds.
       *  None of it reaches Reconcile or book value, but the bank figure
       *  already excludes it, so without this the two differ with nothing on
       *  screen to say why. */
      pendingCents: v.union(v.number(), v.null()),
    }),
  ),
  handler: async (ctx) => {
    await requireReconciliationAudit(ctx);
    return computeBookBalances(ctx);
  },
});

/**
 * DOES IT ADD UP? — the org-wide answer, in one query.
 *
 * The accounts page has always shown book value, bank, pending and a Stripe
 * footnote, and has never once said whether they agree. The founder,
 * 2026-08-08: "if we take all the pending, all the stuff in payout, and all the
 * stuff in Stripe, and all the stuff in the account, we're still missing $50.
 * […] right now it's just very abstract to get that information."
 *
 * The arithmetic — and every reason each term sits on the side it does — lives
 * in `lib/reconciliationGap.ts`. This query's job is to assemble the inputs
 * honestly and to hand the UI the leads that make a non-zero gap actionable
 * rather than merely alarming.
 *
 * ── WHY THE BANK SIDE IS SUMMED FROM ACCOUNTS, NOT FROM BOOK ROWS ────────────
 * `computeBookBalances` attaches each book's account balance to its row, which
 * is right for the per-book table and WRONG for a total: an Increase account
 * belonging to a chapter that has since been deactivated has real cash in it
 * and no row to hang it on. Summing the account table directly means no dollar
 * the org holds can go missing from the "money we can point at" side just
 * because its chapter left. Anything found that way is reported separately, by
 * account, so it reads as the anomaly it is rather than padding the total.
 */
export const reconciliationSummary = query({
  args: {},
  returns: v.object({
    bookValueCents: v.number(),
    bankAvailableCents: v.number(),
    bankPendingCents: v.number(),
    stripeAvailableCents: v.union(v.number(), v.null()),
    stripePendingCents: v.union(v.number(), v.null()),
    /** Givebutter's derived undeposited balance; null = never snapshotted. */
    givebutterUndepositedCents: v.union(v.number(), v.null()),
    givebutterBalanceAsOf: v.union(v.number(), v.null()),
    /** True when a Givebutter key is configured — i.e. a null balance above is
     *  a gap in what we know rather than "this org has no Givebutter". */
    givebutterConfigured: v.boolean(),
    /** The hand-entered Relay balance; null = nobody has ever recorded one. */
    relayBalanceCents: v.union(v.number(), v.null()),
    /** When the person said that figure was TRUE (not when they typed it). */
    relayBalanceAsOf: v.union(v.number(), v.null()),
    /** Who recorded it, for the audit trail the panel shows. */
    relayBalanceSetByName: v.union(v.string(), v.null()),
    /** When Relay's TRANSACTION feed (Stripe FC) last synced. A different fact
     *  from `relayBalanceAsOf` and it goes stale on its own clock — a fresh feed
     *  is not evidence for an old balance. */
    relayFeedSyncedAt: v.union(v.number(), v.null()),
    locatedCents: v.number(),
    differenceCents: v.number(),
    verdict: v.union(
      v.literal("balanced"),
      v.literal("cash_exceeds_books"),
      v.literal("books_exceed_cash"),
    ),
    /** Expected machine-fetched piles we have never read, by name. */
    missingTerms: v.array(v.union(v.literal("stripe"), v.literal("givebutter"))),
    /** `missingTerms` is non-empty — the cash side is knowably short. */
    incomplete: v.boolean(),
    /** In-kind revenue inside book value — no cash exists for it, by design. */
    inKindRevenueCents: v.number(),
    /** When the balances were last fetched (any vendor), for the "as of". */
    balancesAsOf: v.union(v.number(), v.null()),
    /** A snapshot is in flight right now (the page opened moments ago). */
    refreshing: v.boolean(),
    /** Any book whose bank balance has never synced — the cash side is missing
     *  that account entirely, which is not the same as it holding zero. */
    booksWithoutBankBalance: v.array(v.string()),
    /** Cash in Increase accounts that no listed book claims. Included in the
     *  bank total (it IS the org's money) and named so it can be explained. */
    unattributedBankCents: v.number(),
    /** Payouts Stripe says are paid whose bank deposit we never found. Each is
     *  a candidate double count: the deposit lands in the ledger as a plain
     *  credit while the revenue is already counted at the gift/ticket. */
    unmatchedPayoutCount: v.number(),
    unmatchedPayoutCents: v.number(),
    /** A book's scan hit the read limit, so its figure is approximate and the
     *  gap cannot be trusted to the cent. */
    truncated: v.boolean(),
  }),
  handler: async (ctx) => {
    await requireReconciliationAudit(ctx);
    const sandboxMode = await readSandbox(ctx);
    const books = await computeBookBalances(ctx);
    const settings = await ctx.db.query("financeSettings").first();

    const bookValueCents = books.reduce((s, b) => s + b.bookBalanceCents, 0);
    const inKindRevenueCents = books.reduce(
      (s, b) => s + b.inKindRevenueCents,
      0,
    );

    // Every account in the CURRENT environment, whether or not a live book
    // claims it. Mirrors `computeBookBalances`' mode filter exactly — mixing a
    // sandbox account's balance into a production reconciliation would invent a
    // gap out of demo data.
    const accountRows = await ctx.db
      .query("increaseAccounts")
      .take(ROLLUP_SCAN_LIMIT);
    const liveAccounts = accountRows.filter(
      (a) =>
        (a.sandbox ?? a.increaseAccountId?.startsWith("sandbox_") ?? false) ===
        sandboxMode,
    );
    const bookScopes = new Set(books.map((b) => String(b.scope)));

    let bankAvailableCents = 0;
    let bankPendingCents = 0;
    let unattributedBankCents = 0;
    let balancesAsOf: number | null = null;
    for (const account of liveAccounts) {
      const available = account.balanceCents ?? 0;
      bankAvailableCents += available;
      bankPendingCents += account.pendingCents ?? 0;
      if (!bookScopes.has(String(account.chapterId))) {
        unattributedBankCents += available;
      }
      if (
        account.balanceAsOf != null &&
        (balancesAsOf == null || account.balanceAsOf > balancesAsOf)
      ) {
        balancesAsOf = account.balanceAsOf;
      }
    }

    const stripeAvailableCents = settings?.stripeAvailableCents ?? null;
    const stripePendingCents = settings?.stripePendingCents ?? null;
    const givebutterUndepositedCents =
      settings?.givebutterUndepositedCents ?? null;
    const relayBalanceCents = settings?.relayBalanceCents ?? null;

    // Whether Givebutter is configured AT ALL, which is what separates "we
    // haven't read the balance yet" from "this org doesn't use Givebutter".
    // Reading the settings row directly rather than through
    // `integrationSettings.readGivebutterApiKey` is the documented discipline
    // for a caller that only needs to know a key EXISTS — the raw secret never
    // leaves that module, and it must not start leaking into a query's return
    // value just to compute a boolean.
    const integrations = await ctx.db.query("integrationSettings").first();
    const givebutterConfigured =
      (integrations?.givebutterApiKey ?? "").length > 0 ||
      (process.env.GIVEBUTTER_API_KEY ?? "").length > 0;

    const gap = reconcileOrgMoney({
      bookValueCents,
      bankAvailableCents,
      bankPendingCents,
      stripeAvailableCents,
      stripePendingCents,
      givebutterUndepositedCents,
      givebutterConfigured,
      relayBalanceCents,
    });

    // Who last stated the Relay figure. `people` is where display names live;
    // the stored id is a `users` id, so this is the same user→person hop the
    // rest of the finance UI makes. A name we can't resolve degrades to null
    // rather than an id nobody can read.
    const relayBalanceSetByName = settings?.relayBalanceSetBy
      ? ((
          await ctx.db
            .query("people")
            .withIndex("by_user", (q) =>
              q.eq("userId", settings.relayBalanceSetBy),
            )
            .first()
        )?.name ?? null)
      : null;

    // When Relay's transaction feed last landed. Newest across active legacy
    // accounts — today that is exactly one (Relay Financial).
    const legacyAccounts = await ctx.db
      .query("legacyAccounts")
      .take(ROLLUP_SCAN_LIMIT);
    let relayFeedSyncedAt: number | null = null;
    for (const account of legacyAccounts) {
      if (account.status !== "active") continue;
      if (
        account.lastSyncedAt != null &&
        (relayFeedSyncedAt == null || account.lastSyncedAt > relayFeedSyncedAt)
      ) {
        relayFeedSyncedAt = account.lastSyncedAt;
      }
    }


    // The completed-snapshot stamp is the honest "as of" when we have one: it
    // says when we last went and LOOKED, including the runs where a vendor was
    // down. Falling back to the newest per-account stamp keeps the line
    // populated on deployments whose last snapshot predates that field.
    const snapshotAt = settings?.balanceSnapshotAt ?? null;
    const running = settings?.balanceSnapshotRunningSince ?? null;

    // Payouts Stripe considers delivered whose deposit we never matched. Bounded
    // by the same window the overview uses — a payout old enough to have fallen
    // off that list is not a live lead.
    const payoutDocs = await ctx.db
      .query("stripePayouts")
      .withIndex("by_arrival")
      .order("desc")
      .take(OVERVIEW_PAYOUT_LIMIT);
    const unmatched = payoutDocs.filter(
      (p) => p.stripeStatus === "paid" && p.matchedTransactionId == null,
    );

    return {
      bookValueCents,
      bankAvailableCents,
      bankPendingCents,
      stripeAvailableCents,
      stripePendingCents,
      givebutterUndepositedCents,
      givebutterBalanceAsOf: settings?.givebutterBalanceAsOf ?? null,
      givebutterConfigured,
      relayBalanceCents,
      relayBalanceAsOf: settings?.relayBalanceAsOf ?? null,
      relayBalanceSetByName,
      relayFeedSyncedAt,
      locatedCents: gap.locatedCents,
      differenceCents: gap.differenceCents,
      verdict: gap.verdict,
      missingTerms: gap.missingTerms,
      incomplete: gap.incomplete,
      inKindRevenueCents,
      balancesAsOf: snapshotAt ?? balancesAsOf,
      refreshing: running != null && Date.now() - running < SNAPSHOT_LOCK_MS,
      booksWithoutBankBalance: books
        .filter((b) => b.bankBalanceCents == null)
        .map((b) => b.scopeName),
      unattributedBankCents,
      unmatchedPayoutCount: unmatched.length,
      unmatchedPayoutCents: unmatched.reduce((s, p) => s + p.amountCents, 0),
      truncated: books.some((b) => b.truncated),
    };
  },
});

/**
 * Money sitting at Stripe — org-level, because there is one Stripe account and
 * its balance cannot be attributed to a chapter until it pays out.
 *
 * Exists so the accounts page can show the WHOLE picture. Before this, every
 * figure there was either a book total or an Increase balance, so funds in
 * transit at the processor simply weren't anywhere — the founder could hold
 * thousands at Stripe and see no trace of it.
 *
 * Refreshed by the morning engine's snapshot step. Null until its first
 * successful run, which the UI renders as "not yet" rather than as zero.
 */
export const stripeBalance = query({
  args: {},
  returns: v.object({
    availableCents: v.union(v.number(), v.null()),
    pendingCents: v.union(v.number(), v.null()),
    asOf: v.union(v.number(), v.null()),
  }),
  handler: async (ctx) => {
    await requireReconciliationAudit(ctx);
    const row = await ctx.db.query("financeSettings").first();
    return {
      availableCents: row?.stripeAvailableCents ?? null,
      pendingCents: row?.stripePendingCents ?? null,
      asOf: row?.stripeBalanceAsOf ?? null,
    };
  },
});

/**
 * ONE BOOK'S BOOK VALUE, ITEMISED — the drill-down behind an Account Balances row.
 *
 * `accountBalances` gives two numbers per book and no way to interrogate them.
 * When the founder's reaction to New York's $9,639.16 was "that doesn't seem
 * right", there was no way to answer it from the app: the only route was
 * exporting the tables and re-implementing `signedBookCents` offline. This
 * query is that investigation, in the product.
 *
 * It re-derives the SAME arithmetic `accountBalances` uses — deliberately, so
 * the two can never quietly disagree — and returns the components instead of
 * the total:
 *   - REVENUE, split by gift method plus tickets and sales;
 *   - LEDGER OUT, grouped by budget category;
 *   - LEDGER IN, listed individually, because a book's inflows are few and each
 *     one is a judgement call worth eyeballing;
 *   - what contributed NOTHING and why (payout deposits, allocation legs,
 *     excluded rows, bank credits already counted as a linked gift) — the
 *     zero-contributors are where a wrong number usually hides, and they are
 *     invisible in any total.
 *
 * ── THE DOUBLE-COUNT DETECTOR ────────────────────────────────────────────────
 * `suspectedDoubleCounts` is the part that earns its keep. Revenue is counted
 * at the gifts layer, so when the same money ALSO lands as a plain bank inflow
 * it is counted twice — unless the gift carries `transactionId` linking it to
 * that bank row, which is the only signal `accountBalances` skips on.
 *
 * At the time of writing exactly 3 of 180 gifts carry that link, and the two
 * `genesis:truist:*` gifts do not: their $500 + $500 sits in this book as
 * $1,000 of gifts AND $1,000 of unlinked bank inflow. Processor money is safe
 * (a Stripe/Givebutter deposit is labelled a payout and contributes 0), so this
 * only ever bites gifts that arrived as direct bank credits — wires, ACH pulls,
 * transfers from another of the org's own accounts.
 *
 * Matching on amount + a ±3 day window is a HEURISTIC and is reported as a
 * suspicion, never acted on. Two genuinely separate $500 deposits on one day
 * are a real thing that happens — treating that pattern as proof is what
 * deleted a real deposit from this deployment on 2026-08-07 — so this surfaces
 * the pair and leaves the judgement to a person.
 */
export const bookValueBreakdown = query({
  args: { scope: financeScopeValidator },
  returns: v.object({
    scope: financeScopeValidator,
    scopeName: v.string(),
    bookBalanceCents: v.number(),
    revenueCents: v.number(),
    ledgerNetCents: v.number(),
    revenue: v.object({
      gifts: v.array(
        v.object({ method: v.string(), amountCents: v.number(), count: v.number() }),
      ),
      ticketCents: v.number(),
      ticketCount: v.number(),
      saleCents: v.number(),
      saleCount: v.number(),
    }),
    outflowsByCategory: v.array(
      v.object({ category: v.string(), amountCents: v.number(), count: v.number() }),
    ),
    inflows: v.array(
      v.object({
        transactionId: v.id("transactions"),
        postedAt: v.number(),
        amountCents: v.number(),
        description: v.string(),
        source: v.string(),
        status: v.string(),
      }),
    ),
    zeroContributors: v.object({
      payoutDeposits: v.number(),
      allocationLegs: v.number(),
      excluded: v.number(),
      linkedGiftCredits: v.number(),
      unknownTransferShape: v.number(),
    }),
    suspectedDoubleCounts: v.array(
      v.object({
        transactionId: v.id("transactions"),
        postedAt: v.number(),
        amountCents: v.number(),
        description: v.string(),
        giftId: v.id("gifts"),
        giftMethod: v.string(),
        giftExternalRef: v.union(v.string(), v.null()),
      }),
    ),
    /**
     * THE CASH SIDE, for the same book — added 2026-08-08 because the two
     * figures the accounts-page table shows next to book value simply weren't
     * in here. The founder: "Is the pending and held at Stripe even accurate?
     * It doesn't really show up in the breakdown when I click on it, and it's a
     * little confusing." A drill-down that omits the numbers it is drilling
     * into can't answer that, and a reader with no way to check a figure has to
     * either trust it or ignore it.
     *
     * `pendingBreakdown` is the itemisation behind the Pending column, by
     * Increase Pending Transaction category. Empty until a snapshot has read
     * it; that is not the same as "nothing is pending", so the UI distinguishes
     * them.
     */
    cash: v.object({
      bankBalanceCents: v.union(v.number(), v.null()),
      bankBalanceAsOf: v.union(v.number(), v.null()),
      pendingCents: v.union(v.number(), v.null()),
      pendingBreakdown: v.array(
        v.object({
          category: v.string(),
          amountCents: v.number(),
          count: v.number(),
        }),
      ),
      pendingBreakdownAsOf: v.union(v.number(), v.null()),
    }),
    truncated: v.boolean(),
  }),
  handler: async (ctx, { scope }) => {
    await requireReconciliationAudit(ctx);
    const sandboxMode = await readSandbox(ctx);

    let scopeName = "Central";
    if (scope !== CENTRAL) {
      const chapter = await ctx.db.get(scope as Id<"chapters">);
      scopeName = chapter?.name ?? "Unknown book";
    }

    // The book's own Increase account, for the cash side of the drill-down —
    // the same row (and therefore the same numbers) the accounts-page table
    // reads, so the two can never disagree.
    const account = await getChapterAccountForMode(ctx, scope, sandboxMode);

    // ── Revenue, mirroring accountBalances phase 1 ───────────────────────────
    const gifts = await ctx.db
      .query("gifts")
      .withIndex("by_scope", (q) => q.eq("scope", scope))
      .take(ROLLUP_SCAN_LIMIT);
    let truncated = gifts.length === ROLLUP_SCAN_LIMIT;

    const byMethod = new Map<string, { amountCents: number; count: number }>();
    const linkedGiftTxnIds = new Set<string>();
    let revenueCents = 0;
    for (const gift of gifts) {
      if (gift.transactionId != null) linkedGiftTxnIds.add(gift.transactionId);
      revenueCents += gift.amountCents;
      const slot = byMethod.get(gift.method) ?? { amountCents: 0, count: 0 };
      slot.amountCents += gift.amountCents;
      slot.count += 1;
      byMethod.set(gift.method, slot);
    }

    let ticketCents = 0;
    let ticketCount = 0;
    let saleCents = 0;
    let saleCount = 0;
    if (scope !== CENTRAL) {
      const salesRows = await ctx.db
        .query("sales")
        .withIndex("by_chapter_and_soldAt", (q) => q.eq("chapterId", scope))
        .take(ROLLUP_SCAN_LIMIT);
      if (salesRows.length === ROLLUP_SCAN_LIMIT) truncated = true;
      for (const sale of salesRows) {
        saleCents += sale.grossCents;
        saleCount += 1;
      }
      const orders = await ctx.db
        .query("ticketOrders")
        .withIndex("by_chapter", (q) => q.eq("chapterId", scope as Id<"chapters">))
        .take(ROLLUP_SCAN_LIMIT);
      if (orders.length === ROLLUP_SCAN_LIMIT) truncated = true;
      for (const order of orders) {
        if (order.status !== "paid") continue;
        ticketCents += order.totalCents;
        ticketCount += 1;
      }
      revenueCents += ticketCents + saleCents;
    }
    if (sandboxMode) revenueCents = 0;

    // ── Ledger, mirroring accountBalances phase 2 ────────────────────────────
    const txns = await ctx.db
      .query("transactions")
      .withIndex("by_chapter", (q) => q.eq("chapterId", scope))
      .take(ROLLUP_SCAN_LIMIT);
    if (txns.length === ROLLUP_SCAN_LIMIT) truncated = true;

    const categories = await ctx.db.query("budgetCategories").take(ROLLUP_SCAN_LIMIT);
    const categoryName = new Map(categories.map((c) => [c._id as string, c.name]));

    const outByCategory = new Map<string, { amountCents: number; count: number }>();
    const inflows: {
      transactionId: Id<"transactions">;
      postedAt: number;
      amountCents: number;
      description: string;
      source: string;
      status: string;
    }[] = [];
    const zero = {
      payoutDeposits: 0,
      allocationLegs: 0,
      excluded: 0,
      linkedGiftCredits: 0,
      unknownTransferShape: 0,
    };
    let ledgerNetCents = 0;
    const countedInflowRows: Doc<"transactions">[] = [];

    for (const tr of txns) {
      if (!txnMatchesMode(tr, sandboxMode)) continue;
      if (linkedGiftTxnIds.has(tr._id)) {
        zero.linkedGiftCredits += 1;
        continue;
      }
      if (tr.status === "excluded") {
        zero.excluded += 1;
        continue;
      }
      if (tr.payoutProcessor != null || tr.stripePayoutId != null) {
        zero.payoutDeposits += 1;
        continue;
      }
      if (tr.transferOrigin === "payout_allocation") {
        zero.allocationLegs += 1;
        continue;
      }
      const signed = signedBookCents(tr);
      ledgerNetCents += signed;
      if (signed === 0) {
        zero.unknownTransferShape += 1;
      } else if (signed < 0) {
        const key = tr.categoryId
          ? (categoryName.get(tr.categoryId) ?? "Unknown category")
          : "Uncategorised";
        const slot = outByCategory.get(key) ?? { amountCents: 0, count: 0 };
        slot.amountCents += signed;
        slot.count += 1;
        outByCategory.set(key, slot);
      } else {
        countedInflowRows.push(tr);
        inflows.push({
          transactionId: tr._id,
          postedAt: tr.postedAt,
          amountCents: signed,
          description: tr.description ?? "",
          source: tr.source ?? "",
          status: tr.status,
        });
      }
    }

    // ── The detector ────────────────────────────────────────────────────────
    // Only UNLINKED gifts can double-count, and only against an inflow that
    // actually contributed. A gift already consumed by one inflow is not
    // offered against a second, so two $500 deposits and two $500 gifts pair
    // off cleanly rather than reporting four suspicions.
    const WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
    const unlinkedGifts = gifts.filter((g) => g.transactionId == null);
    const claimed = new Set<string>();
    const suspectedDoubleCounts: {
      transactionId: Id<"transactions">;
      postedAt: number;
      amountCents: number;
      description: string;
      giftId: Id<"gifts">;
      giftMethod: string;
      giftExternalRef: string | null;
    }[] = [];
    for (const tr of countedInflowRows) {
      const twin = unlinkedGifts.find(
        (g) =>
          !claimed.has(g._id) &&
          g.amountCents === tr.amountCents &&
          Math.abs(g.receivedAt - tr.postedAt) <= WINDOW_MS,
      );
      if (!twin) continue;
      claimed.add(twin._id);
      suspectedDoubleCounts.push({
        transactionId: tr._id,
        postedAt: tr.postedAt,
        amountCents: tr.amountCents,
        description: tr.description ?? "",
        giftId: twin._id,
        giftMethod: twin.method,
        giftExternalRef: twin.externalRef ?? null,
      });
    }

    return {
      scope,
      scopeName,
      bookBalanceCents: revenueCents + ledgerNetCents,
      revenueCents,
      ledgerNetCents,
      revenue: {
        gifts: [...byMethod.entries()]
          .map(([method, v2]) => ({ method, ...v2 }))
          .sort((a, b) => b.amountCents - a.amountCents),
        ticketCents,
        ticketCount,
        saleCents,
        saleCount,
      },
      outflowsByCategory: [...outByCategory.entries()]
        .map(([category, v2]) => ({ category, ...v2 }))
        .sort((a, b) => a.amountCents - b.amountCents),
      inflows: inflows.sort((a, b) => b.amountCents - a.amountCents),
      zeroContributors: zero,
      suspectedDoubleCounts: suspectedDoubleCounts.sort(
        (a, b) => b.amountCents - a.amountCents,
      ),
      cash: {
        bankBalanceCents: account?.balanceCents ?? null,
        bankBalanceAsOf: account?.balanceAsOf ?? null,
        pendingCents: account?.pendingCents ?? null,
        pendingBreakdown: account?.pendingBreakdown ?? [],
        pendingBreakdownAsOf: account?.pendingBreakdownAsOf ?? null,
      },
      truncated,
    };
  },
});

/**
 * EVERY LINE BEHIND A BOOK'S VALUE — the audit view.
 *
 * `bookValueBreakdown` groups: revenue by gift method, spend by category. That
 * answers "what shape is this number", and the founder's next question was the
 * one grouping can't answer — "show me the line items, because there has to be
 * a duplicate or an undercount in here somewhere."
 *
 * This returns every individual row on both sides, plus every row that
 * contributed NOTHING and the reason it didn't. A grouped view can hide the
 * same $500 counted twice inside a category subtotal; a list can't.
 *
 * ── THE DUPLICATE SCAN ──────────────────────────────────────────────────────
 * `sameAmountSameDay` groups every contributing line — revenue and ledger
 * alike — by (amount, UTC day) and returns the groups with more than one
 * member. That is deliberately a WIDE net: most groups it surfaces are
 * innocent, because a $20 ticket price generates dozens of legitimate matches.
 * It is a place to look, not a verdict, and the UI says so.
 *
 * Narrowing it would be the wrong instinct. The two real double-counts found in
 * this deployment — the Truist gifts and the Pop The Balloon payout — were both
 * exactly this shape, and both were only distinguishable from an innocent match
 * by a human who knew what the money was. A filter tight enough to have
 * excluded the noise would have excluded them too.
 *
 * Bounded by `ROLLUP_SCAN_LIMIT` per collection, and `truncated` says so rather
 * than quietly returning a short list — a partial audit that looks complete is
 * worse than one that admits its edge.
 */
export const bookValueLines = query({
  args: { scope: financeScopeValidator },
  returns: v.object({
    scope: financeScopeValidator,
    scopeName: v.string(),
    revenueCents: v.number(),
    ledgerNetCents: v.number(),
    bookBalanceCents: v.number(),
    earned: v.array(
      v.object({
        kind: v.union(v.literal("gift"), v.literal("ticket"), v.literal("sale")),
        id: v.string(),
        at: v.number(),
        amountCents: v.number(),
        label: v.string(),
        detail: v.string(),
        /** A gift matched to the bank row its cash arrived on — that row is
         *  skipped on the ledger side, so the money counts once. */
        linkedToBankRow: v.boolean(),
      }),
    ),
    ledger: v.array(
      v.object({
        id: v.id("transactions"),
        at: v.number(),
        /** Signed exactly as it lands in book value. */
        amountCents: v.number(),
        description: v.string(),
        category: v.string(),
        source: v.string(),
        status: v.string(),
      }),
    ),
    ignored: v.array(
      v.object({
        id: v.id("transactions"),
        at: v.number(),
        amountCents: v.number(),
        description: v.string(),
        reason: v.string(),
      }),
    ),
    sameAmountSameDay: v.array(
      v.object({
        amountCents: v.number(),
        day: v.string(),
        members: v.array(v.string()),
      }),
    ),
    truncated: v.boolean(),
  }),
  handler: async (ctx, { scope }) => {
    await requireReconciliationAudit(ctx);
    const sandboxMode = await readSandbox(ctx);

    let scopeName = "Central";
    if (scope !== CENTRAL) {
      const chapter = await ctx.db.get(scope as Id<"chapters">);
      scopeName = chapter?.name ?? "Unknown book";
    }
    let truncated = false;
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

    const earned: {
      kind: "gift" | "ticket" | "sale";
      id: string;
      at: number;
      amountCents: number;
      label: string;
      detail: string;
      linkedToBankRow: boolean;
    }[] = [];

    const gifts = await ctx.db
      .query("gifts")
      .withIndex("by_scope", (q) => q.eq("scope", scope))
      .take(ROLLUP_SCAN_LIMIT);
    if (gifts.length === ROLLUP_SCAN_LIMIT) truncated = true;
    const linkedGiftTxnIds = new Set<string>();
    // One read for the donor names rather than one per gift.
    const donorIds = [...new Set(gifts.map((g) => g.donorId))];
    const donors = await Promise.all(donorIds.map((id) => ctx.db.get(id)));
    const donorName = new Map<string, string>();
    for (const d of donors) if (d) donorName.set(d._id as string, d.name);

    let revenueCents = 0;
    for (const g of gifts) {
      if (g.transactionId != null) linkedGiftTxnIds.add(g.transactionId);
      revenueCents += g.amountCents;
      earned.push({
        kind: "gift",
        id: g._id,
        at: g.receivedAt,
        amountCents: g.amountCents,
        label: donorName.get(g.donorId as string) ?? "Unknown donor",
        detail: [g.method, g.externalRef].filter(Boolean).join(" · "),
        linkedToBankRow: g.transactionId != null,
      });
    }

    if (scope !== CENTRAL) {
      const salesRows = await ctx.db
        .query("sales")
        .withIndex("by_chapter_and_soldAt", (q) => q.eq("chapterId", scope))
        .take(ROLLUP_SCAN_LIMIT);
      if (salesRows.length === ROLLUP_SCAN_LIMIT) truncated = true;
      for (const s of salesRows) {
        revenueCents += s.grossCents;
        earned.push({
          kind: "sale",
          id: s._id,
          at: s.soldAt,
          amountCents: s.grossCents,
          label:
            s.items.length > 0
              ? s.items.map((i) => `${i.quantity}× ${i.label}`).join(" + ")
              : "Unresolved item",
          // Whichever rail carried the payment — a Stripe charge id, or the
          // namespaced `externalRef` a non-Stripe sale is keyed on.
          detail: s.stripeChargeId ?? s.externalRef ?? "",
          linkedToBankRow: false,
        });
      }
      const orders = await ctx.db
        .query("ticketOrders")
        .withIndex("by_chapter", (q) => q.eq("chapterId", scope as Id<"chapters">))
        .take(ROLLUP_SCAN_LIMIT);
      if (orders.length === ROLLUP_SCAN_LIMIT) truncated = true;
      for (const o of orders) {
        if (o.status !== "paid") continue;
        revenueCents += o.totalCents;
        earned.push({
          kind: "ticket",
          id: o._id,
          at: o.createdAt,
          amountCents: o.totalCents,
          label: o.name,
          detail: o.items
            .map((i) => `${i.quantity}× ${i.name}`)
            .join(" + "),
          linkedToBankRow: false,
        });
      }
    }
    if (sandboxMode) revenueCents = 0;

    const txns = await ctx.db
      .query("transactions")
      .withIndex("by_chapter", (q) => q.eq("chapterId", scope))
      .take(ROLLUP_SCAN_LIMIT);
    if (txns.length === ROLLUP_SCAN_LIMIT) truncated = true;
    const categories = await ctx.db.query("budgetCategories").take(ROLLUP_SCAN_LIMIT);
    const categoryName = new Map(categories.map((c) => [c._id as string, c.name]));

    const ledger: {
      id: Id<"transactions">;
      at: number;
      amountCents: number;
      description: string;
      category: string;
      source: string;
      status: string;
    }[] = [];
    const ignored: {
      id: Id<"transactions">;
      at: number;
      amountCents: number;
      description: string;
      reason: string;
    }[] = [];
    let ledgerNetCents = 0;

    for (const tr of txns) {
      if (!txnMatchesMode(tr, sandboxMode)) continue;
      const push = (reason: string) =>
        ignored.push({
          id: tr._id,
          at: tr.postedAt,
          amountCents: tr.amountCents,
          description: tr.description ?? "",
          reason,
        });
      if (linkedGiftTxnIds.has(tr._id)) {
        push("Already counted as the gift it belongs to");
        continue;
      }
      if (tr.status === "excluded") {
        push("Excluded by hand");
        continue;
      }
      if (tr.payoutProcessor != null || tr.stripePayoutId != null) {
        push(
          `Processor payout — the revenue is already counted at the gift, ticket or sale`,
        );
        continue;
      }
      if (tr.transferOrigin === "payout_allocation") {
        push("Allocation leg — moves money already counted");
        continue;
      }
      const signed = signedBookCents(tr);
      if (signed === 0) {
        push("Transfer with no recorded direction — contributes nothing rather than guess");
        continue;
      }
      ledgerNetCents += signed;
      ledger.push({
        id: tr._id,
        at: tr.postedAt,
        amountCents: signed,
        description: tr.description ?? "",
        category: tr.categoryId
          ? (categoryName.get(tr.categoryId) ?? "Unknown category")
          : tr.flow === "transfer"
            ? "Internal transfer"
            : "Uncategorised",
        source: tr.source ?? "",
        status: tr.status,
      });
    }

    // ── The wide net ────────────────────────────────────────────────────────
    const buckets = new Map<string, string[]>();
    const add = (cents: number, at: number, label: string) => {
      const key = `${Math.abs(cents)}|${day(at)}`;
      const arr = buckets.get(key);
      if (arr) arr.push(label);
      else buckets.set(key, [label]);
    };
    for (const e of earned) add(e.amountCents, e.at, `${e.kind}: ${e.label}`);
    for (const l of ledger) {
      add(l.amountCents, l.at, `ledger: ${l.description || "(no description)"}`);
    }
    const sameAmountSameDay = [...buckets.entries()]
      .filter(([, members]) => members.length > 1)
      .map(([key, members]) => {
        const [cents, d] = key.split("|");
        return { amountCents: Number(cents), day: d, members };
      })
      .sort((a, b) => b.amountCents - a.amountCents);

    return {
      scope,
      scopeName,
      revenueCents,
      ledgerNetCents,
      bookBalanceCents: revenueCents + ledgerNetCents,
      earned: earned.sort((a, b) => b.at - a.at),
      ledger: ledger.sort((a, b) => b.at - a.at),
      ignored: ignored.sort((a, b) => b.at - a.at),
      sameAmountSameDay,
      truncated,
    };
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
    v.literal("balance_settlement"),
  ),
  note: v.union(v.string(), v.null()),
  stripePayoutId: v.union(v.string(), v.null()),
  // Whether real cash has moved for this pair: true/false for engine pairs
  // (stamped externalId = an executed Increase transfer), null for manual
  // pairs (they record cash that already moved outside the app).
  cashMoved: v.union(v.boolean(), v.null()),
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
        cashMoved:
          leg.transferOrigin == null ? null : leg.externalId != null,
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
