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
 * FEES ARE READ FROM STRIPE, NEVER DERIVED. Each charge's balance transaction carries
 * the exact fee. An earlier attempt at this tried to infer fees by subtracting recorded
 * revenue from banked deposits; that produced "fees MINUS unrecorded sales", which is
 * not a fee and would have written a wrong number into the ledger. The Stripe read has
 * no such ambiguity.
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
        `Stripe processing fees for ${mo.month}, across ${mo.chargeCount} charges. ` +
        `Read from each charge's balance transaction — revenue is recorded gross, so ` +
        `this is the difference between what was given and what banked.`;
      const prior = byRef.get(externalId);
      if (prior) {
        // A later month can still gain charges (a late capture, a refund reversal), so
        // the row is re-summed rather than assumed final.
        if (prior.amountCents === mo.feeCents) { unchanged++; continue; }
        if (write) await ctx.db.patch(prior._id, { amountCents: mo.feeCents, note });
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

const feeReturns = v.object({
  dryRun: v.boolean(),
  chargesScanned: v.number(),
  monthsWithFees: v.number(),
  created: v.number(),
  updated: v.number(),
  unchanged: v.number(),
  totalFeeCents: v.number(),
});

type FeeSyncResult = {
  dryRun: boolean;
  chargesScanned: number;
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
  let startingAfter: string | undefined;
  let chargesScanned = 0;

  for (;;) {
    const params = new URLSearchParams({ limit: String(PAGE), "expand[]": "data.balance_transaction" });
    if (startingAfter) params.set("starting_after", startingAfter);
    const res = await fetch(`${STRIPE_API}/charges?${params.toString()}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      throw new ConvexError({ code: "STRIPE_ERROR", message: `Stripe charges read failed (${res.status}).` });
    }
    const page = (await res.json()) as { data: Array<Record<string, unknown>>; has_more: boolean };
    if (!page.data.length) break;

    for (const c of page.data) {
      chargesScanned++;
      if (c.status !== "succeeded" || c.captured !== true) continue;
      const bt = c.balance_transaction as { fee?: number } | string | null;
      const fee = typeof bt === "object" && bt ? (bt.fee ?? 0) : 0;
      if (!fee) continue;
      const month = new Date((c.created as number) * 1000).toISOString().slice(0, 7);
      const slot = byMonth.get(month) ?? { feeCents: 0, chargeCount: 0 };
      slot.feeCents += fee; slot.chargeCount += 1;
      byMonth.set(month, slot);
    }
    if (!page.has_more) break;
    startingAfter = page.data[page.data.length - 1].id as string;
  }

  const months = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v2]) => {
      const [y, mo] = month.split("-").map(Number);
      // Last day of the month at noon UTC — a period cost booked at period end.
      return { month, ...v2, postedAt: Date.UTC(y, mo, 0, 12) };
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
