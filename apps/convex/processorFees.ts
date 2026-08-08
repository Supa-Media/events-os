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
 * treasurer actually reasons about. The row's note carries the charge count so the
 * figure is traceable back to its constituents.
 *
 * GIVEBUTTER IS NOT COVERED HERE. Its fees are deducted before the payout lands and this
 * deployment has no Givebutter API integration, so there is nothing to read. Its
 * deposits also currently exceed recorded revenue by $4,550.70 — almost certainly event
 * ticket sales collected through Givebutter that were never recorded — and until that is
 * resolved, any Givebutter "fee" derived from the gap would be measuring the wrong thing.
 * Stripe first, deliberately.
 */
import { action, internalAction, internalMutation } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import { NEW_YORK_CHAPTER_SLUG } from "./lib/seed/historical/mapping";
import { requireSuperuser } from "./lib/superuser";

const STRIPE_API = "https://api.stripe.com/v1";
const PAGE = 100;
/** `externalId` prefix — the idempotency key is this plus `YYYY-MM`. */
const FEE_REF_PREFIX = "stripe-fees:";

export const upsertFeeRows = internalMutation({
  args: {
    months: v.array(
      v.object({
        month: v.string(), // YYYY-MM
        feeCents: v.number(),
        chargeCount: v.number(),
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

    let created = 0, updated = 0, unchanged = 0, totalFeeCents = 0;
    for (const mo of months) {
      if (mo.feeCents <= 0) continue;
      totalFeeCents += mo.feeCents;
      const externalId = `${FEE_REF_PREFIX}${mo.month}`;
      const note =
        `Stripe fees for ${mo.month}, across ${mo.chargeCount} balance-transaction entries. ` +
        `Includes both the cut taken from each payment AND the fees Stripe bills on its ` +
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
        const samePostedAt = prior.postedAt === mo.postedAt;
        if (prior.amountCents === mo.feeCents && samePostedAt) { unchanged++; continue; }
        if (write) {
          await ctx.db.patch(prior._id, {
            amountCents: mo.feeCents,
            postedAt: mo.postedAt,
            note,
          });
        }
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
          externalId,
          createdAt: Date.now(),
        });
      }
      created++;
    }
    return { created, updated, unchanged, totalFeeCents };
  },
});

const feeTypeRow = v.object({
  type: v.string(),
  feeCents: v.number(),
  count: v.number(),
});

const feeReturns = v.object({
  dryRun: v.boolean(),
  chargesScanned: v.number(),
  byType: v.array(feeTypeRow),
  monthsWithFees: v.number(),
  created: v.number(),
  updated: v.number(),
  unchanged: v.number(),
  totalFeeCents: v.number(),
});

type FeeSyncResult = {
  dryRun: boolean;
  chargesScanned: number;
  byType: { type: string; feeCents: number; count: number }[];
  monthsWithFees: number;
  created: number;
  updated: number;
  unchanged: number;
  totalFeeCents: number;
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

  const byMonth = new Map<string, { feeCents: number; chargeCount: number }>();
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

      const month = new Date((bt.created as number) * 1000).toISOString().slice(0, 7);
      const slot = byMonth.get(month) ?? { feeCents: 0, chargeCount: 0 };
      slot.feeCents += feeCents; slot.chargeCount += 1;
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

  const months = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v2]) => {
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
      return { month, ...v2, postedAt: Math.min(monthEnd, Date.now()) };
    });

  const r: {
    created: number; updated: number; unchanged: number; totalFeeCents: number;
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
    created: r.created,
    updated: r.updated,
    unchanged: r.unchanged,
    totalFeeCents: r.totalFeeCents,
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
