/**
 * Processor fees as an expense.
 *
 * Revenue is counted GROSS — a $100 gift is $100 of giving, which is what the donor
 * gave and what their acknowledgement letter must say. But only ~$97 reaches the bank.
 * Until now that difference went nowhere: it wasn't revenue, wasn't an expense, and so
 * quietly inflated book value against cash by every fee ever charged. The founder asked
 * for the fee to be a real expense line rather than a haircut on revenue, which is also
 * the treatment that keeps gross giving reportable.
 *
 * FEES ARE READ FROM STRIPE, NEVER DERIVED. An earlier attempt at this tried to infer
 * fees by subtracting recorded revenue from banked deposits; that produced "fees MINUS
 * unrecorded sales", which is not a fee and would have written a wrong number into the
 * ledger. The Stripe read has no such ambiguity.
 *
 * EVERY FEE, not just the ones attached to a payment. The first version of this read
 * `charge.balance_transaction.fee` and so counted only Stripe's cut of each sale. It
 * missed everything Stripe bills on its own account — Terminal reader fees above all.
 * Pop The Balloon made that visible: $558.00 of card-present sales less $28.81 of
 * per-charge fees implies a $529.19 payout, and $513.99 arrived. The missing $15.20 was
 * real money the books never saw, and a month with card readers in the field produces
 * one every time. `runFeeSync` now sweeps the balance-transaction ledger, where both
 * shapes live.
 *
 * DATED AT PERIOD END, except for the month still running — that one is dated
 * TODAY, because a fee row for an unfinished month otherwise lands in the
 * future and keeps changing under you.
 *
 * ONE ROW PER MONTH PER PROCESSOR, not one per charge. 264 charges would bury the
 * reconcile grid in sub-dollar rows nobody codes or reads, and the fee is not a decision
 * anyone makes per transaction — it's a cost of the rail. A month is the smallest unit a
 * treasurer actually reasons about.
 *
 * BUT A ROLLUP WITH NOTHING UNDER IT IS A NUMBER YOU HAVE TO TAKE ON FAITH — "it
 * doesn't keep a record of which transactions have fees, so it feels like a made up
 * number" (owner, 2026-08-08). A charge count in the note is not evidence. So every
 * fee-bearing ledger entry is now KEPT, one `processorFeeEntries` row each, and the
 * month's amount is literally the sum of them (same loop, one pass — see
 * `runFeeSync`). `feeRowDetail` reads them back for the transaction-detail modal, and
 * the note carries the per-type breakdown so even the grid's note says what the figure
 * is made of. The entries are also the answer to "which of MY transactions had a fee":
 * each carries the Stripe `source` id it came off.
 *
 * AND NEVER ATTRIBUTED TO A BUDGET. A budget is a control on CHOICE; this is not
 * one. The fee is mechanically 2.9% + 30c of money the org already decided to
 * accept, and it cannot be declined without declining the gift — so a fee budget
 * could never cause anyone to spend less. It could only produce friction and
 * false alarms, and it is an INVERTED indicator besides: "over budget on fees"
 * is what a record fundraising month looks like. At $1M raised Stripe's cut is
 * ~$29,000 against a $300 ceiling.
 *
 * This module used to propose a DRAFT yearly budget per fee year and wait for a
 * human to approve it. Nobody ever did, correctly — there was no decision to
 * ratify — so 8 rows totalling $318.69 sat permanently in "Needs budget". The
 * rows now carry `feeOrigin`, which `finances.ts#needsBudget` reads, and the
 * question is never asked. Still reconciled, still in every spend total: a
 * fee is real money out, it just isn't anybody's choice. (Owner, 2026-08-09.)
 * Since 2026-08-12 the same `feeOrigin` marker also exempts fee rows from
 * CODING and from the receipt chase entirely (`finances.ts#requiresCoding` /
 * `needsDocumentation` / `isUndocumented`, and the Explain worklist via
 * `autoExplainedKind`): there is no receipt and no testimony to give — the
 * `processorFeeEntries` kept below ARE the documentation, and the public
 * ledger prints the fee's own status line (`autoExplanationLine`) in place
 * of a coding. (Owner: "since these fees increase over time and I literally
 * dont have receipts it shouldn't show up to need to be coded.")
 *
 * GIVEBUTTER IS COVERED TOO, since 2026-08-10. It did not used to be, and the reason
 * given here was wrong on the facts: this deployment DOES have a Givebutter API
 * integration (`givebutterSync.ts` pages `api.givebutter.com/v1`, and the key lives in
 * `integrationSettings.givebutterApiKey`), and every transaction it returns carries both
 * `amount` and `payout`. Their difference is Givebutter's stated cut, so there was
 * something to read all along.
 *
 * The other half of the old reasoning was sound, and is now DISCHARGED rather than
 * ignored. Givebutter's deposits did exceed recorded revenue — by $4,550.70 when that
 * note was written, by $150.00 once the Cash App and Venmo work landed — so a fee
 * inferred from the gap really would have been measuring unrecorded sales. The 2026-08-10
 * reconciliation named the last of it: three Worship Beyond The Walls student
 * registrations that succeeded and were never recorded — they had nowhere to go, since
 * the class was a `projects` row and `ticketOrders` requires an `eventId`. The
 * `registrations` table (`schema/registrations.ts`) is where they live now. With that
 * resolved, Givebutter
 * ties exactly — AS OF 2026-08-10, Σ`amount` $13,044.75 − $29.30 of fee = $13,015.45,
 * which is the $12,940.45 paid out plus the $75.00 still held.
 *
 * THE AS-OF DATE IS PART OF THE FIGURE. `givebutterSync.ts#fetchGivebutterFeeEntries`
 * quotes a Σ`amount` of $12,994.75 — $50.00 less — because it is quoting the 2026-08-07
 * export the arithmetic was verified against, and two $25.00 ticket sales landed after
 * it. Both givers covered their fee, so those tickets move `amount` and `payout` by the
 * same $50.00 and the fee is $29.30 in either reading. Two totals for one account that
 * differ by $50 look like an error and are not; neither is usable without its date.
 *
 * That tie is also the evidence that every one of these transactions IS recorded as
 * revenue. Book value is gross, so the gap can only close to zero if recorded gross
 * equals Σ`amount`: $13,015.45 of cash + $29.30 of booked fee = $13,044.75. A gift
 * missing from the books would leave its full gross sitting in the gap — which is
 * exactly how the three Worship Beyond The Walls registrations were found.
 *
 * And the fee is still not derived from that gap. `fetchGivebutterFeeEntries` reads
 * `amount` and `payout` off the SAME transaction, so our books are not an input to it —
 * see its header, which is explicit about why that subtraction is not the forbidden one.
 */
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import { NEW_YORK_CHAPTER_SLUG } from "./lib/seed/historical/mapping";
import { requireSuperuser } from "./lib/superuser";
import { requireFinanceRole } from "./lib/finance";
import { fetchGivebutterFeeEntries } from "./givebutterSync";

const STRIPE_API = "https://api.stripe.com/v1";
const PAGE = 100;
/** A generous bound on the org's one category list (dozens of rows). */
const CATEGORY_SCAN_LIMIT = 5000;

/** The rails whose fees are swept. Both write one ledger row per month. */
const FEE_RAIL = {
  stripe: {
    /** `externalId` prefix — the idempotency key is this plus `YYYY-MM`. */
    refPrefix: "stripe-fees:",
    merchantName: "Stripe",
    feeOrigin: "stripe_processing",
    /** Row description, before ` — YYYY-MM`. */
    description: "Stripe processing fees",
  },
  givebutter: {
    refPrefix: "givebutter-fees:",
    merchantName: "Givebutter",
    feeOrigin: "givebutter_processing",
    description: "Givebutter processing fees",
  },
} as const;

type FeeRail = keyof typeof FEE_RAIL;
/** Derived from `FEE_RAIL` rather than hand-listed, so a third rail added to the
 *  table above is passable to these mutations without a second edit that is easy
 *  to forget — the pattern `schema/finances.ts` uses for `feeOrigin`. */
const FEE_RAILS = Object.keys(FEE_RAIL) as [FeeRail, ...FeeRail[]];
const feeRailArg = v.union(...FEE_RAILS.map((r) => v.literal(r)));

/**
 * A month's fee-bearing ledger entries, in the shape both the entry writer and
 * the row writer consume. Kept as one validator so the two can never disagree
 * about what an entry is.
 */
const feeEntry = v.object({
  balanceTransactionId: v.string(),
  type: v.string(),
  feeCents: v.number(),
  grossCents: v.number(),
  occurredAt: v.number(),
  sourceId: v.optional(v.string()),
  description: v.optional(v.string()),
});

/**
 * Stripe's balance-transaction types in a treasurer's words. Stripe's own
 * vocabulary ("stripe_fee", "network_cost") is precise but means nothing to
 * someone checking whether $84.83 is plausible; the point of the breakdown is
 * to be READ. An unmapped type falls through to Stripe's own string rather
 * than being hidden — a type nobody anticipated is exactly the thing worth
 * seeing.
 */
export function feeTypeLabel(type: string): string {
  switch (type) {
    case "charge":
    case "payment":
      return "card processing";
    case "payment_refund":
    case "refund":
      return "refunds";
    case "stripe_fee":
      return "Stripe-billed fees";
    case "payout_fee":
      return "payout fees";
    case "application_fee":
      return "application fees";
    case "tax_fee":
      return "tax";
    case "network_cost":
      return "network costs";
    default:
      return type;
  }
}

/** `$84.83` from `8483` — for the note, which is prose, not a number field. */
function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Replace one month's stored evidence with what the sweep just read.
 *
 * ONE MONTH PER CALL, and the call is a full REPLACE of that month — upsert the
 * entries given, delete any stored entry the sweep no longer sees. That is what
 * makes `sum(processorFeeEntries WHERE month = M) === the M fee row's
 * amountCents` a fact rather than a hope: if `FEE_ONLY_TYPES` is ever narrowed,
 * or Stripe reclassifies something, the stale entries go with it instead of
 * quietly making the evidence add up to a different number than the row.
 *
 * A month is the natural batch size here — a month's fee-bearing entries number
 * in the hundreds, so one mutation comfortably holds one. (Whole-history
 * chunking would have needed an arbitrary batch size AND would have broken the
 * replace semantics, since a partial batch can't tell "gone" from "in the next
 * chunk".)
 */
export const upsertFeeEntries = internalMutation({
  args: {
    processor: feeRailArg,
    month: v.string(),
    entries: v.array(feeEntry),
    execute: v.optional(v.boolean()),
  },
  returns: v.object({ inserted: v.number(), updated: v.number(), removed: v.number() }),
  handler: async (ctx, { processor, month, entries, execute }) => {
    if (!execute) return { inserted: 0, updated: 0, removed: 0 };

    // Scoped to ONE rail as well as one month, so Givebutter's replace pass
    // never sees Stripe's entries as orphans and deletes them.
    const stored = await ctx.db
      .query("processorFeeEntries")
      .withIndex("by_processor_and_month", (q) =>
        q.eq("processor", processor).eq("month", month),
      )
      .collect();
    const byId = new Map(stored.map((e) => [e.balanceTransactionId, e]));

    let inserted = 0, updated = 0, removed = 0;
    const now = Date.now();
    for (const e of entries) {
      const prior = byId.get(e.balanceTransactionId);
      if (!prior) {
        await ctx.db.insert("processorFeeEntries", {
          processor,
          month,
          balanceTransactionId: e.balanceTransactionId,
          type: e.type,
          feeCents: e.feeCents,
          grossCents: e.grossCents,
          occurredAt: e.occurredAt,
          ...(e.sourceId ? { sourceId: e.sourceId } : {}),
          ...(e.description ? { description: e.description } : {}),
          createdAt: now,
        });
        inserted++;
        continue;
      }
      byId.delete(e.balanceTransactionId);
      // Both rails' ledgers are effectively append-only, so a re-read normally
      // matches exactly and this whole loop writes nothing. Patch anyway rather
      // than assume — the one thing worse than a fee number nobody can check is
      // a fee number whose evidence silently disagrees with it.
      if (
        prior.feeCents !== e.feeCents ||
        prior.grossCents !== e.grossCents ||
        prior.type !== e.type ||
        prior.occurredAt !== e.occurredAt
      ) {
        await ctx.db.patch(prior._id, {
          type: e.type,
          feeCents: e.feeCents,
          grossCents: e.grossCents,
          occurredAt: e.occurredAt,
        });
        updated++;
      }
    }
    for (const orphan of byId.values()) {
      await ctx.db.delete(orphan._id);
      removed++;
    }
    return { inserted, updated, removed };
  },
});

const feeTypeRow = v.object({
  type: v.string(),
  feeCents: v.number(),
  count: v.number(),
});

/**
 * The month's composition, in one sentence: `card processing $61.20 (264),
 * Stripe-billed fees $23.63 (7)`. Biggest first, because that is the line
 * someone querying the total wants to see. Capped at four kinds — beyond that
 * the note stops being a sentence, and the full list is a tap away in the
 * transaction's detail.
 */
function breakdownSentence(
  byType: { type: string; feeCents: number; count: number }[],
): string {
  const sorted = [...byType].sort((a, b) => b.feeCents - a.feeCents);
  const shown = sorted
    .slice(0, 4)
    .map((t) => `${feeTypeLabel(t.type)} ${usd(t.feeCents)} (${t.count})`);
  const rest = sorted.slice(4);
  if (rest.length > 0) {
    const restCents = rest.reduce((s, t) => s + t.feeCents, 0);
    shown.push(`${rest.length} other kinds ${usd(restCents)}`);
  }
  return shown.join(", ");
}

export const upsertFeeRows = internalMutation({
  args: {
    processor: feeRailArg,
    months: v.array(
      v.object({
        month: v.string(), // YYYY-MM
        feeCents: v.number(),
        entryCount: v.number(),
        /** Per fee type, for the note's breakdown. Stripe's balance-transaction
         *  types; Givebutter has one kind and sends a single row. */
        byType: v.array(feeTypeRow),
        /** Last day of the month, UTC noon — fees are a period cost, not a moment. */
        postedAt: v.number(),
      }),
    ),
    execute: v.optional(v.boolean()),
  },
  returns: v.object({
    created: v.number(),
    updated: v.number(),
    unchanged: v.number(),
    totalFeeCents: v.number(),
    marked: v.number(),
    /** Rows reversed to $0.00 because their month no longer carries a fee. */
    zeroed: v.number(),
  }),
  handler: async (ctx, { processor, months, execute }) => {
    const write = execute ?? false;
    const rail = FEE_RAIL[processor];
    const chapter = await ctx.db
      .query("chapters")
      .withIndex("by_slug", (q) => q.eq("slug", NEW_YORK_CHAPTER_SLUG))
      .first();
    if (!chapter) throw new ConvexError({ code: "NO_CHAPTER", message: "NY chapter not found." });

    // "Bank & Fees" off the ORG's one category list (chapter-scoped until
    // 2026-08-14). Bounded read; the table is dozens of rows.
    const category = (
      await ctx.db.query("budgetCategories").take(CATEGORY_SCAN_LIMIT)
    ).find((c) => c.name === "Bank & Fees");

    /**
     * This rail's existing row for one month, by its idempotency key.
     *
     * A POINT LOOKUP ON `by_external_id`, not a bounded scan. This used to take
     * the first 6000 rows off `by_chapter_and_postedAt` and build a map — which
     * is a latent nightly double-book: the moment NY passes 6000 transactions,
     * a fee row whose `postedAt` sorts outside that window stops being found,
     * the `insert` branch below runs instead of the patch, and the morning
     * engine books a DUPLICATE fee expense under a duplicate `externalId`. Every
     * night, forever, silently. An idempotency key deserves an index rather than
     * a scan whose correctness expires at a row count nobody is watching.
     *
     * Chapter-filtered to keep the old map's exact semantics; `externalId` is a
     * point match, so this collects one row in practice.
     */
    const priorFor = async (externalId: string) => {
      const hits = await ctx.db
        .query("transactions")
        .withIndex("by_external_id", (q) => q.eq("externalId", externalId))
        .collect();
      return hits.find((t) => t.chapterId === chapter._id) ?? null;
    };

    let created = 0, updated = 0, unchanged = 0, totalFeeCents = 0, marked = 0, zeroed = 0;
    for (const mo of months) {
      const externalId = `${rail.refPrefix}${mo.month}`;

      // ── A MONTH WHOSE FEE HAS GONE AWAY ─────────────────────────────────
      // Reached because the sweep now carries in every month it has a row for,
      // not only the months it still produces entries for (see
      // `withZeroedMonths`). Without this branch a month that stops having a
      // fee-bearing transaction — one refund is enough on Givebutter, where the
      // whole booked expense is a single gift — simply vanishes from `months`,
      // the full-REPLACE semantics never reach it, and a stale fee row and its
      // evidence sit in the ledger forever, unhealable by any number of re-runs.
      //
      // ZEROED, NOT DELETED, and that is a deliberate call on a money path.
      // Fourteen tables hold a `v.id("transactions")`, and five of them are
      // genuinely reachable for a fee row: `receiptLinks`, `receiptExceptions`,
      // `transactionCodings`, and the `candidateTransactionIds` arrays on
      // `receipts` / `inboundReceipts` (the receipt matcher filters on amount and
      // `isSpend`, and exempts nothing for `feeOrigin`). `reattributionAudit` is
      // worse still — append-only, required id array, no delete path anywhere in
      // the repo — so a delete there would dangle permanently. There is no
      // cascade-delete helper for transactions in this codebase to lean on.
      //
      // A zeroed row is also the better LEDGER answer independent of that. A row
      // a treasurer saw last month that is simply gone this month is an
      // unexplained disappearance; a $0.00 row whose note says why is auditable.
      if (mo.feeCents <= 0) {
        const prior = await priorFor(externalId);
        if (!prior) continue; // Never booked, so there is nothing to undo.
        const note =
          `${rail.merchantName} fees for ${mo.month} — $0.00. This month had a fee ` +
          `row and the sweep no longer finds a single fee-bearing transaction in ` +
          `it, so the expense has been reversed to zero. That happens when the ` +
          `transaction carrying the fee was refunded or reversed, or is no longer ` +
          `returned by the API. The row is kept at zero rather than deleted so the ` +
          `change is visible and anything referencing it still resolves. If this ` +
          `month SHOULD carry a fee, the sweep's read is what to check.`;
        // CLOSED as well as zeroed. `needsDocumentation` and `isUncoded` both
        // stop at `reconciled`, and a row left `categorized` would sit in the
        // receipt chase and the coding queue forever as a $0.00 chore nobody can
        // action. There is genuinely nothing left to reconcile on it.
        if (
          prior.amountCents === 0 &&
          prior.note === note &&
          prior.status === "reconciled"
        ) { unchanged++; continue; }
        if (write) {
          await ctx.db.patch(prior._id, {
            amountCents: 0,
            note,
            status: "reconciled",
          });
        }
        zeroed++;
        continue;
      }

      totalFeeCents += mo.feeCents;
      const note =
        processor === "stripe"
          ? `Stripe fees for ${mo.month} — ${usd(mo.feeCents)} across ${mo.entryCount} ` +
            `ledger entries: ${breakdownSentence(mo.byType)}. Every entry is kept, so this ` +
            `total can be checked line by line against Stripe (open the transaction). ` +
            `Covers both the cut taken from each payment AND the fees Stripe bills on its ` +
            `own account (Terminal readers, payout and account fees). Revenue is recorded ` +
            `gross, so this is the whole difference between what was given and what banked.`
          : `Givebutter fees for ${mo.month} — ${usd(mo.feeCents)} across ${mo.entryCount} ` +
            `${mo.entryCount === 1 ? "transaction" : "transactions"}. Each is Givebutter's ` +
            `own \`amount\` less its own \`payout\` for that transaction, kept as evidence ` +
            `so the total can be checked line by line (open the transaction). Only ` +
            `transactions whose giver did NOT cover the fee appear here — where they did, ` +
            `Givebutter remits the full amount and there is no expense. Revenue is recorded ` +
            `gross, so this is the whole difference between what was given and what banked.`;

      const prior = await priorFor(externalId);
      if (prior) {
        // A later month can still gain charges (a late capture, a refund reversal), so
        // the row is re-summed rather than assumed final. `postedAt` is re-checked
        // too: the month still running moves its date forward as it accrues, and
        // rows written before that rule existed are sitting in the FUTURE (an
        // August fee row dated Aug 31 while it was Aug 7). Comparing only the
        // amount would leave those stranded there forever.
        //
        // The NOTE is compared for the same reason: it now carries the per-type
        // breakdown, and a row whose amount happens not to have moved would
        // otherwise keep last release's note forever — the wrong explanation of a
        // right number is its own kind of untrustworthy.
        //
        // `feeOrigin` is back-filled on the same pass. Rows written before the
        // marker existed are exactly the ones stuck in "Needs budget", so the
        // sync that knows they are fees is the right thing to fix them — no
        // migration, and it self-heals if one is ever missed.
        const samePostedAt = prior.postedAt === mo.postedAt;
        const needsMark = prior.feeOrigin == null;
        // A month that was reversed to $0.00 and now carries a fee again is
        // being UN-zeroed, and has to re-enter the normal lifecycle it was
        // closed out of — otherwise a healed row keeps the `reconciled` the
        // reversal gave it while a freshly booked one starts `categorized`, and
        // the same month reads differently depending on its history.
        const healing = prior.amountCents === 0;
        if (
          prior.amountCents === mo.feeCents &&
          samePostedAt &&
          prior.note === note &&
          !needsMark
        ) { unchanged++; continue; }
        if (write) {
          await ctx.db.patch(prior._id, {
            amountCents: mo.feeCents,
            postedAt: mo.postedAt,
            note,
            ...(needsMark ? { feeOrigin: rail.feeOrigin } : {}),
            ...(healing ? { status: "categorized" as const } : {}),
          });
        }
        if (needsMark) marked++;
        updated++;
        continue;
      }
      if (write) {
        await ctx.db.insert("transactions", {
          chapterId: chapter._id,
          source: "manual",
          flow: "outflow",
          amountCents: mo.feeCents,
          currency: "usd",
          postedAt: mo.postedAt,
          description: `${rail.description} — ${mo.month}`,
          merchantName: rail.merchantName,
          note,
          status: "categorized",
          ...(category ? { categoryId: category._id } : {}),
          // NOT a budget. See this module's header and `finances.ts#needsBudget`.
          feeOrigin: rail.feeOrigin,
          externalId,
          createdAt: Date.now(),
        });
      }
      // Outside the `if (write)`, like every other counter here. A new row is
      // always `feeOrigin`-stamped, so a dry run that reports `created` without
      // the matching `marked` was under-reporting its own preview.
      marked++;
      created++;
    }
    return { created, updated, unchanged, totalFeeCents, marked, zeroed };
  },
});

/**
 * Every month this rail currently has a fee ROW booked for.
 *
 * The input to `withZeroedMonths`, and the reason a month whose fee disappears
 * can be un-booked at all: a sweep only knows about months it still finds fees
 * in, so the months it must also VISIT have to come from what is already stored.
 *
 * Read off the fee ROWS rather than off `processorFeeEntries`, and the reason is
 * boundedness alone. One row per month, a few dozen ever; collecting a rail's
 * entries would pull every fee-bearing charge Stripe has ever made, because
 * `by_processor_and_month` has no distinct support and "which months" would mean
 * reading them all and de-duping in memory — which grows without limit.
 *
 * The cost of that choice, stated honestly: an entry ORPHANED by a crash between
 * the two writes is not reachable here, so it is never cleaned up until that
 * month carries a fee again. It is not invisible in the meantime —
 * `dashboardCharts.ts#feeRateByMonth` queries `processorFeeEntries` directly
 * with no join to a fee row, so an orphan would inflate that chart's numerator
 * and the year's blended rate, which is the monitor whose whole job is noticing
 * when reality diverges. What makes this acceptable is reachability, not
 * harmlessness: it needs the action to die BETWEEN the entry write and the row
 * write AND that month to never carry a fee again, which on Stripe's append-only
 * ledger effectively cannot happen. If orphans ever do show up, sweep them from
 * a migration rather than making this query unbounded.
 */
export const feeMonthsOnRecord = internalQuery({
  args: { processor: feeRailArg },
  returns: v.array(v.string()),
  handler: async (ctx, { processor }) => {
    const prefix = FEE_RAIL[processor].refPrefix;
    // Prefix range on the `externalId` index: every `<rail>-fees:YYYY-MM` key
    // sorts between the bare prefix and the prefix plus a max code point.
    const rows = await ctx.db
      .query("transactions")
      .withIndex("by_external_id", (q) =>
        q.gte("externalId", prefix).lt("externalId", `${prefix}\uffff`),
      )
      .collect();
    const months = new Set<string>();
    for (const r of rows) {
      if (r.externalId) months.add(r.externalId.slice(prefix.length));
    }
    return [...months];
  },
});

/** One month as both writers below consume it. */
type FeeMonth = {
  month: string;
  feeCents: number;
  entryCount: number;
  byType: { type: string; feeCents: number; count: number }[];
  postedAt: number;
};

/**
 * A CLOSED month books at its last day — a period cost at period end.
 *
 * The month still running books at TODAY instead. Dating it to the month's end
 * put an August fee row on Aug 31 while it was Aug 7: a transaction in the
 * future, sorting above everything real, for a period that hasn't happened yet.
 * It also kept growing each time the sync ran, so the future-dated amount was
 * never even final. Today is the honest date — everything in the row HAS been
 * charged, and the row moves forward with the month as more accrues.
 */
function monthEndPostedAt(month: string): number {
  const [y, mo] = month.split("-").map(Number);
  return Math.min(Date.UTC(y, mo, 0, 12), Date.now());
}

/**
 * The swept months, plus a ZERO for every month this rail has a row for that
 * the sweep no longer produces anything in.
 *
 * Both rails' full-REPLACE semantics — a month's entries are replaced wholesale,
 * a month's row is re-summed — only ever applied to months the sweep still
 * EMITTED. A month that goes quiet was simply absent from the list, so nothing
 * reached it and its stale row survived every re-run. Carrying the stored months
 * back in is what makes "re-running the sweep converges on the truth" actually
 * true rather than true-only-for-months-that-still-have-fees.
 *
 * Applied to BOTH rails, not just Givebutter. Givebutter is where it is easy to
 * reach — the entire booked expense there is one gift in 263, so a single refund
 * empties a month — while Stripe's balance-transaction ledger is append-only and
 * a month with charges effectively never drops to zero fees. But "effectively
 * never" is not a guarantee, the hole is in shared code, and a sweep that
 * self-heals on only one rail is a footnote waiting to be forgotten.
 *
 * ── A READ THAT SAW NOTHING IS NOT A QUIET PERIOD ────────────────────────────
 * `scanned === 0` REFUSES to reverse anything, and that floor is the whole
 * reason `scanned` is carried this far.
 *
 * The error paths are already guarded — a non-ok response throws, a truncated
 * sweep throws, an unconfigured key returns before any of this — but "HTTP 200
 * with an empty list" is none of those, and it is the shape the realistic
 * accidents actually produce: `STRIPE_SECRET_KEY` rotated to a `sk_test_…` key
 * or repointed at another account, or a Givebutter key that still authenticates
 * against an account that has been wound down. Without this floor the morning
 * engine would take that as "every month went quiet at once", write $0.00 over
 * every historical fee row, and DELETE every stored entry underneath them —
 * entries that are not re-derivable if the source account is gone, and that
 * `dashboardCharts.ts#feeRateByMonth` reads directly.
 *
 * A repointed key does not mean the org stopped incurring 2026-07's fees. Every
 * month going quiet at once is the signature of a BROKEN READ, and this module
 * says three times over that a read it is not sure of is worse than no read at
 * all. This is that rule applied to the one write that destroys evidence.
 *
 * The floor deliberately covers only the total-silence case. A PARTIAL read —
 * some months present, others missing — is still trusted, because that is
 * indistinguishable from real reversals without a proportional guard (refuse to
 * zero more than k months in one run), and no evidence yet says which k. Total
 * silence is the dominant failure and the one with unbounded blast radius.
 */
async function withZeroedMonths(
  ctx: ActionCtx,
  processor: FeeRail,
  swept: FeeMonth[],
  scanned: number,
): Promise<FeeMonth[]> {
  if (scanned === 0) {
    console.warn(
      `[processorFees] ${processor} sweep read 0 transactions; refusing to ` +
        `reverse any month. A read that saw nothing has not observed a quiet ` +
        `period, it has failed to observe anything.`,
    );
    return swept;
  }
  const onRecord: string[] = await ctx.runQuery(
    internal.processorFees.feeMonthsOnRecord,
    { processor },
  );
  const seen = new Set(swept.map((m) => m.month));
  const zeros: FeeMonth[] = onRecord
    .filter((month) => !seen.has(month))
    .map((month) => ({
      month,
      feeCents: 0,
      entryCount: 0,
      byType: [],
      postedAt: monthEndPostedAt(month),
    }));
  return [...swept, ...zeros].sort((a, b) => a.month.localeCompare(b.month));
}

const feeReturns = v.object({
  dryRun: v.boolean(),
  chargesScanned: v.number(),
  byType: v.array(feeTypeRow),
  monthsWithFees: v.number(),
  entriesRecorded: v.number(),
  created: v.number(),
  updated: v.number(),
  unchanged: v.number(),
  totalFeeCents: v.number(),
  /** Fee rows this run stamped `feeOrigin` on (0 once they all carry it). */
  marked: v.number(),
  /** Fee rows reversed to $0.00 because their month no longer carries a fee. */
  zeroed: v.number(),
});

type FeeSyncResult = {
  dryRun: boolean;
  chargesScanned: number;
  byType: { type: string; feeCents: number; count: number }[];
  monthsWithFees: number;
  entriesRecorded: number;
  created: number;
  updated: number;
  unchanged: number;
  totalFeeCents: number;
  marked: number;
  zeroed: number;
};

/**
 * Shared body; each entry point below brings its own authorization.
 *
 * The return type is annotated explicitly rather than inferred. This function calls
 * `ctx.runMutation` on a mutation defined in THIS file, so inference would have to
 * resolve the module's own `internal` types while still building them — TypeScript
 * gives up with TS7023 and, because `_generated/api` then degrades to `any`, the
 * failure cascades into ~1300 errors across unrelated files. Annotating breaks the
 * cycle at its source.
 */
async function runFeeSync(
  ctx: ActionCtx,
  execute: boolean | undefined,
): Promise<FeeSyncResult> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new ConvexError({ code: "NO_KEY", message: "STRIPE_SECRET_KEY is not set." });

  /**
   * Per month: the total, the per-type split, and EVERY constituent entry.
   * All three come out of the one pass below, off the same `feeCents` — so the
   * month's amount is the sum of the entries by construction, not by a second
   * calculation that could drift from it.
   */
  type MonthSlot = {
    feeCents: number;
    entries: {
      balanceTransactionId: string;
      type: string;
      feeCents: number;
      grossCents: number;
      occurredAt: number;
      sourceId?: string;
      description?: string;
    }[];
    byType: Map<string, { feeCents: number; count: number }>;
  };
  const byMonth = new Map<string, MonthSlot>();
  /** Fee cents by balance-transaction type, for the dry run's report. */
  const byType = new Map<string, { feeCents: number; count: number }>();
  let startingAfter: string | undefined;
  let chargesScanned = 0;

  // ── SWEEP BALANCE TRANSACTIONS, NOT CHARGES ────────────────────────────────
  // This used to page `/v1/charges` and take each one's `balance_transaction.fee`,
  // which sees only the fee ATTACHED TO A PAYMENT and misses every fee Stripe
  // bills on its own. Pop The Balloon exposed the gap: 142 card-present sales
  // grossed $558.00 with $28.81 of per-charge fees, and the payout that landed
  // was $513.99 — $15.20 short of the $529.19 those two numbers imply. That
  // $15.20 is real money Stripe took and the books never saw, and there is one
  // of these for every month with Terminal hardware in the field.
  //
  // The balance-transaction ledger is where all of it lives, so sweep that
  // instead and take fees from BOTH shapes:
  //   - a payment's own cut, `bt.fee` (what the old sweep got), and
  //   - a STANDALONE fee row, which carries `fee: 0` and a NEGATIVE `amount`
  //     that IS the charge — Terminal reader fees, account fees, payout fees.
  //
  // `FEE_ONLY_TYPES` is an allowlist, not "any negative amount". Refunds,
  // payouts and transfers are all negative too, and counting those as expenses
  // would turn every payout into a cost. An unrecognised type contributes
  // nothing and shows up in `byType` so it can be looked at rather than guessed
  // at.
  const FEE_ONLY_TYPES = new Set([
    "stripe_fee",
    "payout_fee",
    "application_fee",
    "tax_fee",
    "network_cost",
  ]);

  for (;;) {
    const params = new URLSearchParams({ limit: String(PAGE) });
    if (startingAfter) params.set("starting_after", startingAfter);
    const res = await fetch(`${STRIPE_API}/balance_transactions?${params.toString()}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      throw new ConvexError({
        code: "STRIPE_ERROR",
        message: `Stripe balance transactions read failed (${res.status}).`,
      });
    }
    const page = (await res.json()) as { data: Array<Record<string, unknown>>; has_more: boolean };
    if (!page.data.length) break;

    for (const bt of page.data) {
      chargesScanned++;
      const type = String(bt.type ?? "unknown");
      const amount = Number(bt.amount ?? 0);
      const ownFee = Number(bt.fee ?? 0);
      // A standalone fee row's cost is its (negative) amount; a payment's is
      // its `fee`. Never both — a payment's `amount` is revenue, not a cost.
      const feeCents =
        FEE_ONLY_TYPES.has(type) && amount < 0 ? -amount + ownFee : ownFee;
      if (feeCents <= 0) continue;

      const occurredAt = (bt.created as number) * 1000;
      const month = new Date(occurredAt).toISOString().slice(0, 7);
      const slot: MonthSlot =
        byMonth.get(month) ?? { feeCents: 0, entries: [], byType: new Map() };
      slot.feeCents += feeCents;
      // The evidence, recorded in the same step that adds to the total — the
      // entry list and the month's amount cannot disagree because they are one
      // statement apart. `source` is the id a treasurer types into Stripe.
      slot.entries.push({
        balanceTransactionId: String(bt.id ?? ""),
        type,
        feeCents,
        grossCents: amount,
        occurredAt,
        ...(typeof bt.source === "string" ? { sourceId: bt.source } : {}),
        ...(typeof bt.description === "string" && bt.description
          ? { description: bt.description }
          : {}),
      });
      const mt = slot.byType.get(type) ?? { feeCents: 0, count: 0 };
      mt.feeCents += feeCents; mt.count += 1;
      slot.byType.set(type, mt);
      byMonth.set(month, slot);

      const t = byType.get(type) ?? { feeCents: 0, count: 0 };
      t.feeCents += feeCents; t.count += 1;
      byType.set(type, t);
    }
    if (!page.has_more) break;
    startingAfter = page.data[page.data.length - 1].id as string;
  }

  console.log(
    `[processorFees] fee sweep by balance-transaction type: ` +
      [...byType.entries()]
        .sort((a, b) => b[1].feeCents - a[1].feeCents)
        .map(([t, v2]) => `${t}=${v2.count} rows/${v2.feeCents}¢`)
        .join(", "),
  );

  const sorted = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b));

  // Months the sweep still finds fees in, plus a zero for any month that has a
  // row and no longer does — see `withZeroedMonths`.
  const months: FeeMonth[] = await withZeroedMonths(
    ctx,
    "stripe",
    sorted.map(([month, slot]) => ({
      month,
      feeCents: slot.feeCents,
      entryCount: slot.entries.length,
      byType: [...slot.byType.entries()].map(([type, t]) => ({ type, ...t })),
      postedAt: monthEndPostedAt(month),
    })),
    chargesScanned,
  );

  // ── The evidence goes down FIRST ───────────────────────────────────────────
  // One mutation per month, each a full replace of that month's entries, so
  // that at every instant the stored entries for a month either predate the
  // row's new amount or match it — never a row updated against evidence that
  // was never written. In a dry run this writes nothing and reports nothing;
  // the preview stays a preview. A zeroed month passes an EMPTY entry list, so
  // the same replace deletes the evidence under a row being reversed to $0.00.
  let entriesRecorded = 0;
  for (const mo of months) {
    const slot = byMonth.get(mo.month);
    await ctx.runMutation(internal.processorFees.upsertFeeEntries, {
      processor: "stripe",
      month: mo.month,
      entries: slot?.entries ?? [],
      ...(execute ? { execute: true } : {}),
    });
    entriesRecorded += slot?.entries.length ?? 0;
  }

  const r: {
    created: number;
    updated: number;
    unchanged: number;
    totalFeeCents: number;
    marked: number;
    zeroed: number;
  } = await ctx.runMutation(internal.processorFees.upsertFeeRows, {
    processor: "stripe",
    months,
    ...(execute ? { execute: true } : {}),
  });
  return {
    dryRun: !execute,
    chargesScanned,
    byType: [...byType.entries()]
      .map(([type, v2]) => ({ type, ...v2 }))
      .sort((a, b) => b.feeCents - a.feeCents),
    monthsWithFees: months.filter((m) => m.feeCents > 0).length,
    entriesRecorded,
    created: r.created,
    updated: r.updated,
    unchanged: r.unchanged,
    totalFeeCents: r.totalFeeCents,
    marked: r.marked,
    zeroed: r.zeroed,
  };
}

/**
 * The Givebutter half, same contract and same two writers as `runFeeSync`.
 *
 * Structurally simpler because Givebutter has ONE kind of fee. Stripe bills on
 * its own account as well as per payment, which is why that sweep needs an
 * allowlist of ledger types; Givebutter's cut only ever appears as the gap
 * between one transaction's `amount` and its own `payout`, so every entry is the
 * same shape and `byType` carries a single row. `feeTypeLabel` leaves the
 * unmapped `givebutter` string alone, which reads correctly in the note.
 *
 * A DEPLOYMENT WITH NO GIVEBUTTER IS A NO-OP, NOT A FAILURE. No key configured
 * returns zeroes rather than throwing, so the morning engine can call this
 * unconditionally — same treatment `fetchGivebutterUndepositedCents` already
 * gets from the balance snapshot.
 */
async function runGivebutterFeeSync(
  ctx: ActionCtx,
  execute: boolean | undefined,
): Promise<FeeSyncResult> {
  const sweep = await fetchGivebutterFeeEntries(ctx);
  if (sweep === null) {
    console.log("[processorFees] no Givebutter key configured; fee sweep skipped");
    return {
      dryRun: !execute,
      chargesScanned: 0,
      byType: [],
      monthsWithFees: 0,
      entriesRecorded: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      totalFeeCents: 0,
      marked: 0,
      zeroed: 0,
    };
  }
  const { entries, scanned } = sweep;

  const byMonth = new Map<string, { feeCents: number; entries: typeof entries }>();
  for (const e of entries) {
    const slot = byMonth.get(e.month) ?? { feeCents: 0, entries: [] };
    slot.feeCents += e.feeCents;
    slot.entries.push(e);
    byMonth.set(e.month, slot);
  }
  const sorted = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b));

  const months: FeeMonth[] = await withZeroedMonths(
    ctx,
    "givebutter",
    sorted.map(([month, slot]) => ({
      month,
      feeCents: slot.feeCents,
      entryCount: slot.entries.length,
      byType: [
        { type: "givebutter", feeCents: slot.feeCents, count: slot.entries.length },
      ],
      postedAt: monthEndPostedAt(month),
    })),
    scanned,
  );

  // Evidence first, then the row — see `runFeeSync` for why that order matters.
  let entriesRecorded = 0;
  for (const mo of months) {
    const slot = byMonth.get(mo.month);
    await ctx.runMutation(internal.processorFees.upsertFeeEntries, {
      processor: "givebutter",
      month: mo.month,
      entries: (slot?.entries ?? []).map((e) => ({
        balanceTransactionId: e.transactionId,
        type: "givebutter",
        feeCents: e.feeCents,
        grossCents: e.grossCents,
        occurredAt: e.occurredAt,
        ...(e.description ? { description: e.description } : {}),
      })),
      ...(execute ? { execute: true } : {}),
    });
    entriesRecorded += slot?.entries.length ?? 0;
  }

  const r: {
    created: number;
    updated: number;
    unchanged: number;
    totalFeeCents: number;
    marked: number;
    zeroed: number;
  } = await ctx.runMutation(internal.processorFees.upsertFeeRows, {
    processor: "givebutter",
    months,
    ...(execute ? { execute: true } : {}),
  });
  return {
    dryRun: !execute,
    // TRANSACTIONS READ, not fees found — the two are 267 and 1 on this account,
    // and reporting the second here would make "swept the whole account, one
    // gift's fee wasn't covered" and "the feed returned one row and we booked
    // off it" identical in the ops output. `entriesRecorded` is the fee-bearing
    // count, and it already exists. Matches `runFeeSync`, which counts every
    // balance transaction it scans.
    chargesScanned: scanned,
    byType: [
      {
        type: "givebutter",
        feeCents: entries.reduce((s, e) => s + e.feeCents, 0),
        count: entries.length,
      },
    ],
    monthsWithFees: months.filter((m) => m.feeCents > 0).length,
    entriesRecorded,
    created: r.created,
    updated: r.updated,
    unchanged: r.unchanged,
    totalFeeCents: r.totalFeeCents,
    marked: r.marked,
    zeroed: r.zeroed,
  };
}

/** App-facing. Superuser-gated: reads the whole payment history. */
export const syncStripeFees = action({
  args: { execute: v.optional(v.boolean()) },
  returns: feeReturns,
  handler: async (ctx, { execute }): Promise<FeeSyncResult> => {
    await requireSuperuser(ctx);
    return runFeeSync(ctx, execute);
  },
});

/** Ops entry point for the CLI, which carries the deployment admin key rather than a
 *  user session — see `salesSync.ts#syncStripeSalesOps` for the same reasoning. */
export const syncStripeFeesOps = internalAction({
  args: { execute: v.optional(v.boolean()) },
  returns: feeReturns,
  handler: async (ctx, { execute }): Promise<FeeSyncResult> => runFeeSync(ctx, execute),
});

/** App-facing Givebutter sweep. Same gate as its Stripe sibling. */
export const syncGivebutterFees = action({
  args: { execute: v.optional(v.boolean()) },
  returns: feeReturns,
  handler: async (ctx, { execute }): Promise<FeeSyncResult> => {
    await requireSuperuser(ctx);
    return runGivebutterFeeSync(ctx, execute);
  },
});

/** Ops/engine entry point for the Givebutter sweep. */
export const syncGivebutterFeesOps = internalAction({
  args: { execute: v.optional(v.boolean()) },
  returns: feeReturns,
  handler: async (ctx, { execute }): Promise<FeeSyncResult> =>
    runGivebutterFeeSync(ctx, execute),
});

/**
 * A generous cap on one month's entries. A busy month runs to the low hundreds;
 * this exists so a pathological month can't hand a phone ten thousand rows, not
 * as a real limit. `entryCount` is always the TRUE count, so a truncated list
 * still tells the truth about how many there are.
 */
const MAX_DETAIL_ENTRIES = 600;

/**
 * Everything the monthly fee row is made of — the drill-in behind "how do you
 * know it's $84.83?".
 *
 * Returns `null` for any transaction that isn't a processor-fee rollup, so the
 * detail modal can ask about every transaction it opens and render the section
 * only when there's something to render.
 *
 * The month is taken from the row's own `externalId` rather than from its
 * `postedAt`: the running month's row is dated TODAY (see `runFeeSync`), so its
 * date is not reliably inside the period it covers, but its idempotency key
 * always is.
 */
export const feeRowDetail = query({
  args: { transactionId: v.id("transactions") },
  returns: v.union(
    v.null(),
    v.object({
      month: v.string(),
      /** Summed from the entries — NOT read off the row, so a mismatch shows. */
      totalCents: v.number(),
      entryCount: v.number(),
      rowAmountCents: v.number(),
      byType: v.array(
        v.object({
          type: v.string(),
          label: v.string(),
          feeCents: v.number(),
          count: v.number(),
        }),
      ),
      entries: v.array(
        v.object({
          id: v.id("processorFeeEntries"),
          balanceTransactionId: v.string(),
          type: v.string(),
          label: v.string(),
          feeCents: v.number(),
          grossCents: v.number(),
          occurredAt: v.number(),
          sourceId: v.union(v.string(), v.null()),
          description: v.union(v.string(), v.null()),
        }),
      ),
      truncated: v.boolean(),
    }),
  ),
  handler: async (ctx, { transactionId }) => {
    const txn = await ctx.db.get(transactionId);
    // Which rail's row this is, from its own `externalId` prefix. Resolved
    // rather than assumed: both rails write monthly rows into the same table,
    // and reading Givebutter's row against Stripe's entries would report a
    // total that disagrees with the row it is supposed to be evidence for.
    const railEntry = (
      Object.entries(FEE_RAIL) as [FeeRail, (typeof FEE_RAIL)[FeeRail]][]
    ).find(([, r]) => txn?.externalId?.startsWith(r.refPrefix));
    if (!railEntry || !txn?.externalId) return null;
    const [processor, rail] = railEntry;
    // Fee rows are always booked to a real chapter; a central row could not be
    // one, and `requireFinanceRole` has no chapter to check against.
    if (txn.chapterId === "central") return null;
    await requireFinanceRole(ctx, txn.chapterId, "viewer");

    const month = txn.externalId.slice(rail.refPrefix.length);
    // Deliberately unbounded: `totalCents` is summed here to be COMPARED with
    // the row, and a `take()` would silently make it disagree. A month runs to
    // the low hundreds of entries; if one ever grew past Convex's read limit
    // this would fail loudly, which is the right failure for a figure whose
    // only job is to be checkable.
    const stored = await ctx.db
      .query("processorFeeEntries")
      .withIndex("by_processor_and_month", (q) =>
        q.eq("processor", processor).eq("month", month),
      )
      .collect();

    const byType = new Map<string, { feeCents: number; count: number }>();
    let totalCents = 0;
    for (const e of stored) {
      totalCents += e.feeCents;
      const t = byType.get(e.type) ?? { feeCents: 0, count: 0 };
      t.feeCents += e.feeCents; t.count += 1;
      byType.set(e.type, t);
    }

    // Newest first — the same order every other transaction list reads in. The
    // "what's big here" question is answered by `byType`, not by re-sorting the
    // ledger into an order Stripe's own dashboard never shows.
    const entries = [...stored].sort((a, b) => b.occurredAt - a.occurredAt);
    return {
      month,
      totalCents,
      entryCount: stored.length,
      rowAmountCents: txn.amountCents,
      byType: [...byType.entries()]
        .map(([type, t]) => ({ type, label: feeTypeLabel(type), ...t }))
        .sort((a, b) => b.feeCents - a.feeCents),
      entries: entries.slice(0, MAX_DETAIL_ENTRIES).map((e) => ({
        id: e._id,
        balanceTransactionId: e.balanceTransactionId,
        type: e.type,
        label: feeTypeLabel(e.type),
        feeCents: e.feeCents,
        grossCents: e.grossCents,
        occurredAt: e.occurredAt,
        sourceId: e.sourceId ?? null,
        description: e.description ?? null,
      })),
      truncated: entries.length > MAX_DETAIL_ENTRIES,
    };
  },
});
