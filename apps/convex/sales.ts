/**
 * SALES — merch, snacks and drinks sold in person.
 *
 * The third revenue stream, and the one that had no home. Gifts arrive through
 * the giving layer and tickets through the ticketing layer, but a $2 Izze sold
 * from a table at Pop The Balloon reached Stripe and stopped there: $1,588 of
 * real money that book value could not see while its cash sat in the bank. The
 * `sales` table (schema/ticketing.ts) and `salesSync.ts` brought it in;
 * `reconciliation.ts#accountBalances` counts it GROSS alongside the other two.
 * This module is the read surface over it.
 *
 * ── WHY MOST ROWS HAVE NO ITEMS ─────────────────────────────────────────────
 * The in-person taps went through a third-party Tap-to-Pay app that sent Stripe
 * an AMOUNT and nothing else — 177 of 178 charges carry no line item and no
 * price id, even though the product catalogue existed in Stripe. So the amount
 * is the only surviving evidence of what was sold, and `lib/salesCatalog.ts`
 * only asserts a breakdown when exactly ONE combination of that event's prices
 * makes the total. Eden sold only $30 tees, so its charges read cleanly; Pop
 * The Balloon's $1/$2/$3/$5 snack prices overlap so heavily that most of it
 * stays unresolved.
 *
 * That is the honest outcome, not a gap to paper over: the money and the event
 * are certain, the SKU is not, and a fabricated SKU is worse than a blank. The
 * UI shows `unresolved` plainly for the same reason.
 *
 * READ-ONLY. Sales originate at Stripe and are re-synced idempotently on the
 * charge id; there is no hand-entry path, so nothing here writes.
 */
import { query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { requireFinanceRole } from "./lib/finance";

/** Bounded read — a chapter's sales history is small and stays small. */
const SALES_SCAN_LIMIT = 4000;

const saleRowValidator = v.object({
  saleId: v.id("sales"),
  soldAt: v.number(),
  grossCents: v.number(),
  feeCents: v.number(),
  netCents: v.number(),
  channel: v.string(),
  itemSource: v.string(),
  items: v.array(
    v.object({
      label: v.string(),
      quantity: v.number(),
      unitPriceCents: v.number(),
      /** >1 entry when several products share this price — the sale is real,
       *  which product it was is genuinely ambiguous. */
      candidates: v.array(v.string()),
    }),
  ),
  eventId: v.union(v.id("events"), v.null()),
  eventName: v.union(v.string(), v.null()),
  stripeChargeId: v.string(),
});

/**
 * Every sale for a chapter, newest first, with its event resolved and a summary.
 *
 * The summary carries `unresolvedCents` next to the total deliberately: a
 * reader's first question about a sales page whose rows mostly say "Unresolved"
 * is how much money that actually accounts for, and the answer (all of it —
 * revenue is exact, only the breakdown is missing) should not require adding up
 * the rows by hand.
 */
export const listSales = query({
  args: {
    chapterId: v.id("chapters"),
    /** Filter to one event; omit for the whole chapter. */
    eventId: v.optional(v.id("events")),
  },
  returns: v.object({
    sales: v.array(saleRowValidator),
    summary: v.object({
      count: v.number(),
      grossCents: v.number(),
      feeCents: v.number(),
      netCents: v.number(),
      resolvedCount: v.number(),
      unresolvedCount: v.number(),
      unresolvedCents: v.number(),
    }),
    /** Per-event totals, biggest first — the shape of what actually sold. */
    byEvent: v.array(
      v.object({
        eventId: v.union(v.id("events"), v.null()),
        eventName: v.string(),
        count: v.number(),
        grossCents: v.number(),
        feeCents: v.number(),
      }),
    ),
    /** Every identified unit across resolved sales, most revenue first. */
    byItem: v.array(
      v.object({
        label: v.string(),
        quantity: v.number(),
        grossCents: v.number(),
        candidates: v.array(v.string()),
      }),
    ),
    truncated: v.boolean(),
  }),
  handler: async (ctx, { chapterId, eventId }) => {
    // Bookkeeper+ — the same floor the rest of the finance reads use. Sales are
    // revenue detail, not public event data.
    await requireFinanceRole(ctx, chapterId, "bookkeeper");

    const rows = await ctx.db
      .query("sales")
      .withIndex("by_chapter_and_soldAt", (q) => q.eq("chapterId", chapterId))
      .take(SALES_SCAN_LIMIT);
    const truncated = rows.length === SALES_SCAN_LIMIT;
    const scoped = eventId ? rows.filter((r) => r.eventId === eventId) : rows;

    // One read per distinct event rather than per sale — 178 sales across two
    // events would otherwise be 178 gets.
    const eventIds = [...new Set(scoped.map((r) => r.eventId).filter(Boolean))];
    const events = await Promise.all(
      eventIds.map((id) => ctx.db.get(id as Id<"events">)),
    );
    const eventName = new Map<string, string>();
    for (const e of events) {
      if (e) eventName.set(e._id as string, e.name);
    }

    const sales = scoped
      .slice()
      .sort((a, b) => b.soldAt - a.soldAt)
      .map((r: Doc<"sales">) => ({
        saleId: r._id,
        soldAt: r.soldAt,
        grossCents: r.grossCents,
        feeCents: r.feeCents,
        netCents: r.grossCents - r.feeCents,
        channel: r.channel,
        itemSource: r.itemSource,
        items: r.items,
        eventId: r.eventId ?? null,
        eventName: r.eventId ? (eventName.get(r.eventId) ?? null) : null,
        stripeChargeId: r.stripeChargeId,
      }));

    const grossCents = sales.reduce((a, s) => a + s.grossCents, 0);
    const feeCents = sales.reduce((a, s) => a + s.feeCents, 0);
    const unresolved = sales.filter((s) => s.itemSource === "unresolved");

    const eventBuckets = new Map<
      string,
      { eventId: Id<"events"> | null; eventName: string; count: number; grossCents: number; feeCents: number }
    >();
    for (const s of sales) {
      const key = s.eventId ?? "__none__";
      const slot = eventBuckets.get(key) ?? {
        eventId: s.eventId,
        eventName: s.eventName ?? "Unattributed",
        count: 0,
        grossCents: 0,
        feeCents: 0,
      };
      slot.count += 1;
      slot.grossCents += s.grossCents;
      slot.feeCents += s.feeCents;
      eventBuckets.set(key, slot);
    }

    const itemBuckets = new Map<
      string,
      { label: string; quantity: number; grossCents: number; candidates: string[] }
    >();
    for (const s of sales) {
      for (const item of s.items) {
        const slot = itemBuckets.get(item.label) ?? {
          label: item.label,
          quantity: 0,
          grossCents: 0,
          candidates: item.candidates,
        };
        slot.quantity += item.quantity;
        slot.grossCents += item.quantity * item.unitPriceCents;
        itemBuckets.set(item.label, slot);
      }
    }

    return {
      sales,
      summary: {
        count: sales.length,
        grossCents,
        feeCents,
        netCents: grossCents - feeCents,
        resolvedCount: sales.length - unresolved.length,
        unresolvedCount: unresolved.length,
        unresolvedCents: unresolved.reduce((a, s) => a + s.grossCents, 0),
      },
      byEvent: [...eventBuckets.values()].sort((a, b) => b.grossCents - a.grossCents),
      byItem: [...itemBuckets.values()].sort((a, b) => b.grossCents - a.grossCents),
      truncated,
    };
  },
});
