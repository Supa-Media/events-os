/**
 * Recover backer giving that Stripe took but the ledger never recorded.
 *
 * ── THE INCIDENT ────────────────────────────────────────────────────────────
 * Every backer's money enters the giving ledger through exactly one door: the
 * `invoice.paid` webhook → `recordPledgeInvoice` → a `gifts` row. Nothing else
 * writes it. A subscription checkout only ACTIVATES the pledge; it records no
 * gift, deliberately, because the money is not ours until the invoice is paid.
 *
 * That door was reading `invoice.subscription`, a top-level field newer Stripe
 * API versions moved under `parent.subscription_details.subscription`. When the
 * field a payload actually carries is the other one, the handler's guard was
 * false, the branch did nothing, no log was written, and the endpoint answered
 * 200 — so Stripe recorded a successful delivery and considered the matter
 * closed. The result is the worst shape a bug can have: real money, taken from
 * real people, completely invisible, with every system reporting health.
 * (2026-08-15, owner: "the gifts I and other people gave through backers is not
 * registering as a gift in the ledger.")
 *
 * `http.ts#invoiceSubscriptionId` now reads both shapes and shouts when it can
 * resolve neither. This file repairs what was lost while it didn't.
 *
 * ── STRIPE IS THE SOURCE OF TRUTH, NOT OUR WEBHOOK LOG ─────────────────────
 * The sweep does not replay webhooks or trust anything we stored at the time —
 * both are exactly what failed. For every pledge that has a subscription it
 * ASKS STRIPE for that subscription's invoices and records any PAID one with no
 * matching gift. What Stripe says it charged is the only account of this money
 * that was never in doubt.
 *
 * ── WHAT IT WRITES, AND WHAT IT REFUSES TO ─────────────────────────────────
 * It writes the gift, dated to the invoice's own `status_transitions.paid_at` —
 * a payment taken in May belongs in May's ledger, and dating recovered money
 * "today" would misstate every month it skipped and every monthly report
 * already published.
 *
 * It sends NOTHING (`suppressEmails`). No receipt ("your monthly gift came
 * through", about May), no welcome, no desk notification. The money is news to
 * the ledger; it is not news to the person who paid it, and a burst of
 * back-dated receipts would read as a billing error to every backer at once.
 *
 * ── HOW IT IS RUN ──────────────────────────────────────────────────────────
 * Deliberately, by a maintainer, via `run-convex-function.yml` — the same
 * maintainer-only, production-gated dispatch every other backfill here uses:
 *
 *   gh workflow run run-convex-function.yml \
 *     -f function=backerInvoiceRecovery:recoverBackerInvoices \
 *     -f args='{}'                  # DRY RUN — reports the gap, writes nothing
 *
 *   gh workflow run run-convex-function.yml \
 *     -f function=backerInvoiceRecovery:recoverBackerInvoices \
 *     -f args='{"execute":true}'    # records the missing gifts
 *
 * IDEMPOTENT by construction, with no stamp of its own: `recordPledgeInvoice`
 * is already idempotent on `stripeInvoiceId` (the giving ledger's own uniqueness
 * rule), so a second run finds every gift present and writes nothing. That also
 * makes it safe to leave in place and re-run whenever a gap is suspected —
 * which is the point, because the next Stripe field rename will be silent too.
 *
 * BOUNDED: pledges are read one page at a time and each subscription's invoices
 * are fetched with a hard page limit. A pledge with hundreds of cycles is a
 * decade-old backer, and the cap is stated in the log rather than hidden.
 */
import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const STRIPE_API = "https://api.stripe.com/v1";

/** Pledges read per invocation. */
const PAGE_SIZE = 25;

/** Invoices fetched per subscription. 100 monthly cycles is eight years of
 *  backing; anything past it is logged rather than silently dropped. */
const INVOICE_LIMIT = 100;

/** One pledge with a Stripe subscription to check. */
type PledgeRow = {
  pledgeId: Id<"pledges">;
  subscriptionId: string;
  donorName: string;
  scopeLabel: string;
};

interface PledgePage {
  due: PledgeRow[];
  scanned: number;
  isDone: boolean;
  continueCursor: string | null;
}

interface Progress {
  /** Pledge rows read. */
  scanned: number;
  /** Pledges carrying a Stripe subscription — the ones actually checkable. */
  withSubscription: number;
  /** Paid invoices Stripe reported across those subscriptions. */
  invoicesFound: number;
  /** Paid invoices with NO gift in our ledger — the gap. */
  missing: number;
  /** Missing invoices this run actually recorded. */
  recorded: number;
  /** Cents behind `missing` — the money that was invisible. */
  missingCents: number;
}

const progressValidator = v.object({
  scanned: v.number(),
  withSubscription: v.number(),
  invoicesFound: v.number(),
  missing: v.number(),
  recorded: v.number(),
  missingCents: v.number(),
});

/** One page of pledges that have a Stripe subscription to check.
 *
 *  EVERY status, deliberately — a `canceled` pledge still had paid cycles while
 *  it ran, and those gifts are exactly as missing as an active backer's. */
export const listPledgesWithSubscriptions = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), numItems: v.number() },
  handler: async (ctx, { cursor, numItems }): Promise<PledgePage> => {
    const page = await ctx.db.query("pledges").paginate({ numItems, cursor });
    const due: PledgeRow[] = [];
    for (const pledge of page.page) {
      if (!pledge.stripeSubscriptionId) continue;
      const donor = await ctx.db.get(pledge.donorId);
      let scopeLabel = "Central";
      if (pledge.scope !== "central") {
        const chapter = await ctx.db.get(pledge.scope as Id<"chapters">);
        scopeLabel = chapter?.name ?? "Unknown chapter";
      }
      due.push({
        pledgeId: pledge._id,
        subscriptionId: pledge.stripeSubscriptionId,
        donorName: donor?.name ?? "Unknown",
        scopeLabel,
      });
    }
    return {
      due,
      scanned: page.page.length,
      isDone: page.isDone,
      continueCursor: page.isDone ? null : page.continueCursor,
    };
  },
});

/** Is this invoice already in the giving ledger? The same `by_stripeInvoice`
 *  uniqueness `recordPledgeInvoice` enforces — asked first so a DRY RUN can
 *  report the gap without writing anything. */
export const giftExistsForInvoice = internalQuery({
  args: { invoiceId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { invoiceId }) => {
    const gift = await ctx.db
      .query("gifts")
      .withIndex("by_stripeInvoice", (q) => q.eq("stripeInvoiceId", invoiceId))
      .first();
    return gift !== null;
  },
});

type StripeInvoice = {
  id: string;
  status?: string;
  amount_paid?: number;
  created?: number;
  status_transitions?: { paid_at?: number | null } | null;
};

/** Every PAID invoice on one subscription, newest first. */
async function paidInvoicesFor(
  secretKey: string,
  subscriptionId: string,
): Promise<StripeInvoice[]> {
  const url =
    `${STRIPE_API}/invoices?subscription=${encodeURIComponent(subscriptionId)}` +
    `&status=paid&limit=${INVOICE_LIMIT}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  if (!res.ok) {
    console.error(
      `[backer-invoice-recovery] could not list invoices for ${subscriptionId}:`,
      await res.text(),
    );
    return [];
  }
  const body = (await res.json()) as { data?: StripeInvoice[]; has_more?: boolean };
  if (body.has_more) {
    console.warn(
      `[backer-invoice-recovery] ${subscriptionId} has more than ${INVOICE_LIMIT} ` +
        "paid invoices; only the newest were checked.",
    );
  }
  return body.data ?? [];
}

/**
 * Sweep every backer subscription and record the gifts the ledger is missing.
 *
 * DRY RUN BY DEFAULT: with `execute` omitted it writes nothing and returns the
 * exact gap — how many paid invoices Stripe has, how many have no gift, and
 * what that is worth in cents. That report IS the diagnosis; run it first.
 */
export const recoverBackerInvoices = internalAction({
  args: {
    execute: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    progress: v.optional(progressValidator),
  },
  handler: async (
    ctx,
    args,
  ): Promise<Progress & { isDone: boolean; continueCursor: string | null }> => {
    const execute = args.execute ?? false;
    const secretKey = process.env.STRIPE_SECRET_KEY;

    const page: PledgePage = await ctx.runQuery(
      internal.backerInvoiceRecovery.listPledgesWithSubscriptions,
      { cursor: args.cursor ?? null, numItems: PAGE_SIZE },
    );

    const total: Progress = {
      scanned: (args.progress?.scanned ?? 0) + page.scanned,
      withSubscription: (args.progress?.withSubscription ?? 0) + page.due.length,
      invoicesFound: args.progress?.invoicesFound ?? 0,
      missing: args.progress?.missing ?? 0,
      recorded: args.progress?.recorded ?? 0,
      missingCents: args.progress?.missingCents ?? 0,
    };

    if (!secretKey) {
      // Nothing can be checked without Stripe — and saying so is the whole
      // point, because a run that quietly reported "0 missing" would read as a
      // clean bill of health.
      console.error(
        "[backer-invoice-recovery] STRIPE_SECRET_KEY is not set — nothing was checked.",
      );
      return { ...total, isDone: true, continueCursor: null };
    }

    for (const row of page.due) {
      const invoices = await paidInvoicesFor(secretKey, row.subscriptionId);
      total.invoicesFound += invoices.length;

      for (const inv of invoices) {
        const amountPaidCents = inv.amount_paid ?? 0;
        if (amountPaidCents <= 0) continue; // a $0 proration is not a gift

        const exists: boolean = await ctx.runQuery(
          internal.backerInvoiceRecovery.giftExistsForInvoice,
          { invoiceId: inv.id },
        );
        if (exists) continue;

        total.missing += 1;
        total.missingCents += amountPaidCents;
        // NAMED, so a dry run's log is a list a human can check against Stripe
        // rather than a bare count they have to take on faith.
        console.log(
          `[backer-invoice-recovery] MISSING ${inv.id} ${amountPaidCents}c ` +
            `${row.donorName} · ${row.scopeLabel}`,
        );

        if (!execute) continue;

        const paidAt = inv.status_transitions?.paid_at ?? inv.created;
        const ok: boolean = await ctx.runMutation(
          internal.givingPledges.recordPledgeInvoice,
          {
            subscriptionId: row.subscriptionId,
            invoiceId: inv.id,
            amountPaidCents,
            // The date the money moved — see this file's header.
            ...(paidAt ? { receivedAt: paidAt * 1000 } : {}),
            // No receipt, no welcome, no desk bell.
            suppressEmails: true,
            // Never re-enter the out-of-order recovery path: the pledge is
            // right here and already linked, so a `false` return means
            // something genuinely unexpected and should be visible.
            attemptRecovery: false,
          },
        );
        if (ok) total.recorded += 1;
        else {
          console.error(
            `[backer-invoice-recovery] could not record ${inv.id} for pledge ${row.pledgeId}`,
          );
        }
      }
    }

    console.log(
      `[backer-invoice-recovery] ${execute ? "EXECUTE" : "DRY RUN"} ` +
        `scanned=${total.scanned} withSubscription=${total.withSubscription} ` +
        `invoicesFound=${total.invoicesFound} missing=${total.missing} ` +
        `recorded=${total.recorded} missingCents=${total.missingCents} done=${page.isDone}`,
    );

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.backerInvoiceRecovery.recoverBackerInvoices,
        { execute, cursor: page.continueCursor, progress: total },
      );
    }

    return { ...total, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});
