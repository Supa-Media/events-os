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
 * question is never asked. They are still coded, still reconciled, still in
 * every spend total: a fee is real money out, it just isn't anybody's choice.
 * (Owner, 2026-08-09.)
 *
 * GIVEBUTTER IS NOT COVERED HERE. Its fees are deducted before the payout lands and this
 * deployment has no Givebutter API integration, so there is nothing to read. Its
 * deposits also currently exceed recorded revenue by $4,550.70 — almost certainly event
 * ticket sales collected through Givebutter that were never recorded — and until that is
 * resolved, any Givebutter "fee" derived from the gap would be measuring the wrong thing.
 * Stripe first, deliberately.
 */
import { action, internalAction, internalMutation, query } from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import { NEW_YORK_CHAPTER_SLUG } from "./lib/seed/historical/mapping";
import { requireSuperuser } from "./lib/superuser";
import { requireFinanceRole } from "./lib/finance";

const STRIPE_API = "https://api.stripe.com/v1";
const PAGE = 100;
/** `externalId` prefix — the idempotency key is this plus `YYYY-MM`. */
const FEE_REF_PREFIX = "stripe-fees:";

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
    month: v.string(),
    entries: v.array(feeEntry),
    execute: v.optional(v.boolean()),
  },
  returns: v.object({ inserted: v.number(), updated: v.number(), removed: v.number() }),
  handler: async (ctx, { month, entries, execute }) => {
    if (!execute) return { inserted: 0, updated: 0, removed: 0 };

    const stored = await ctx.db
      .query("processorFeeEntries")
      .withIndex("by_processor_and_month", (q) =>
        q.eq("processor", "stripe").eq("month", month),
      )
      .collect();
    const byId = new Map(stored.map((e) => [e.balanceTransactionId, e]));

    let inserted = 0, updated = 0, removed = 0;
    const now = Date.now();
    for (const e of entries) {
      const prior = byId.get(e.balanceTransactionId);
      if (!prior) {
        await ctx.db.insert("processorFeeEntries", {
          processor: "stripe",
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
      // Stripe's ledger is append-only, so a re-read normally matches exactly
      // and this whole loop writes nothing. Patch anyway rather than assume —
      // the one thing worse than a fee number nobody can check is a fee number
      // whose evidence silently disagrees with it.
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
    months: v.array(
      v.object({
        month: v.string(), // YYYY-MM
        feeCents: v.number(),
        entryCount: v.number(),
        /** Per Stripe balance-transaction type, for the note's breakdown. */
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
  }),
  handler: async (ctx, { months, execute }) => {
    const write = execute ?? false;
    const chapter = await ctx.db
      .query("chapters")
      .withIndex("by_slug", (q) => q.eq("slug", NEW_YORK_CHAPTER_SLUG))
      .first();
    if (!chapter) throw new ConvexError({ code: "NO_CHAPTER", message: "NY chapter not found." });

    const category = (
      await ctx.db
        .query("budgetCategories")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapter._id))
        .collect()
    ).find((c) => c.name === "Bank & Fees");

    const existing = await ctx.db
      .query("transactions")
      .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", chapter._id))
      .take(6000);
    const byRef = new Map(existing.filter((t) => t.externalId).map((t) => [t.externalId!, t]));

    let created = 0, updated = 0, unchanged = 0, totalFeeCents = 0, marked = 0;
    for (const mo of months) {
      if (mo.feeCents <= 0) continue;
      totalFeeCents += mo.feeCents;
      const externalId = `${FEE_REF_PREFIX}${mo.month}`;
      const note =
        `Stripe fees for ${mo.month} — ${usd(mo.feeCents)} across ${mo.entryCount} ` +
        `ledger entries: ${breakdownSentence(mo.byType)}. Every entry is kept, so this ` +
        `total can be checked line by line against Stripe (open the transaction). ` +
        `Covers both the cut taken from each payment AND the fees Stripe bills on its ` +
        `own account (Terminal readers, payout and account fees). Revenue is recorded ` +
        `gross, so this is the whole difference between what was given and what banked.`;

      const prior = byRef.get(externalId);
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
            ...(needsMark ? { feeOrigin: "stripe_processing" as const } : {}),
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
          description: `Stripe processing fees — ${mo.month}`,
          merchantName: "Stripe",
          note,
          status: "categorized",
          ...(category ? { categoryId: category._id } : {}),
          // NOT a budget. See this module's header and `finances.ts#needsBudget`.
          feeOrigin: "stripe_processing",
          externalId,
          createdAt: Date.now(),
        });
        marked++;
      }
      created++;
    }
    return { created, updated, unchanged, totalFeeCents, marked };
  },
});

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

  // ── The evidence goes down FIRST ───────────────────────────────────────────
  // One mutation per month, each a full replace of that month's entries, so
  // that at every instant the stored entries for a month either predate the
  // row's new amount or match it — never a row updated against evidence that
  // was never written. In a dry run this writes nothing and reports nothing;
  // the preview stays a preview.
  let entriesRecorded = 0;
  for (const [month, slot] of sorted) {
    await ctx.runMutation(internal.processorFees.upsertFeeEntries, {
      month,
      entries: slot.entries,
      ...(execute ? { execute: true } : {}),
    });
    entriesRecorded += slot.entries.length;
  }

  const months = sorted.map(([month, slot]) => {
    const [y, mo] = month.split("-").map(Number);
    // A CLOSED month books at its last day — a period cost at period end.
    //
    // The month still running books at TODAY instead. Dating it to the
    // month's end put an August fee row on Aug 31 while it was Aug 7: a
    // transaction in the future, sorting above everything real, for a period
    // that hasn't happened yet. It also kept growing each time the sync ran,
    // so the future-dated amount was never even final.
    //
    // Today is the honest date for it — everything in the row HAS been
    // charged, and the row moves forward with the month as more accrues.
    const monthEnd = Date.UTC(y, mo, 0, 12);
    return {
      month,
      feeCents: slot.feeCents,
      entryCount: slot.entries.length,
      byType: [...slot.byType.entries()].map(([type, t]) => ({ type, ...t })),
      postedAt: Math.min(monthEnd, Date.now()),
    };
  });

  const r: {
    created: number;
    updated: number;
    unchanged: number;
    totalFeeCents: number;
    marked: number;
  } = await ctx.runMutation(internal.processorFees.upsertFeeRows, {
    months,
    ...(execute ? { execute: true } : {}),
  });
  return {
    dryRun: !execute,
    chargesScanned,
    byType: [...byType.entries()]
      .map(([type, v2]) => ({ type, ...v2 }))
      .sort((a, b) => b.feeCents - a.feeCents),
    monthsWithFees: months.length,
    entriesRecorded,
    created: r.created,
    updated: r.updated,
    unchanged: r.unchanged,
    totalFeeCents: r.totalFeeCents,
    marked: r.marked,
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
    if (!txn?.externalId?.startsWith(FEE_REF_PREFIX)) return null;
    // Fee rows are always booked to a real chapter; a central row could not be
    // one, and `requireFinanceRole` has no chapter to check against.
    if (txn.chapterId === "central") return null;
    await requireFinanceRole(ctx, txn.chapterId, "viewer");

    const month = txn.externalId.slice(FEE_REF_PREFIX.length);
    // Deliberately unbounded: `totalCents` is summed here to be COMPARED with
    // the row, and a `take()` would silently make it disagree. A month runs to
    // the low hundreds of entries; if one ever grew past Convex's read limit
    // this would fail loudly, which is the right failure for a figure whose
    // only job is to be checkable.
    const stored = await ctx.db
      .query("processorFeeEntries")
      .withIndex("by_processor_and_month", (q) =>
        q.eq("processor", "stripe").eq("month", month),
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
