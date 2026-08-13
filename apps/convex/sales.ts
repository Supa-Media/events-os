/**
 * SALES — merch, snacks and drinks sold in person.
 *
 * The third revenue stream, and the one that had no home. Gifts arrive through
 * the giving layer and tickets through the ticketing layer, but a $2 Izze sold
 * from a table at Pop The Balloon reached Stripe and stopped there: $1,588 of
 * real money that book value could not see while its cash sat in the bank. The
 * `sales` table (schema/ticketing.ts) and `salesSync.ts` brought it in;
 * `reconciliation.ts#accountBalances` counts it GROSS alongside the other two.
 * This module is the read/edit surface over it.
 *
 * ── WHY MANY OLD ROWS HAVE NO ITEMS ─────────────────────────────────────────
 * The 2025 in-person taps went through a third-party Tap-to-Pay app that sent
 * Stripe an AMOUNT and nothing else — 142 of the 2025 charges carry no line item
 * and no price id, even though the product catalogue existed in Stripe. For
 * those the amount is the only surviving evidence of what was sold, and
 * `lib/salesCatalog.ts` only asserts a breakdown when exactly ONE combination of
 * that event's prices makes the total. Eden sold only $30 tees, so its charges
 * read cleanly; Pop The Balloon's $1/$2/$3/$5 snack prices overlap so heavily
 * that most of it stays unresolved.
 *
 * That is the honest outcome, not a gap to paper over: the money and the event
 * are certain, the SKU is not, and a fabricated SKU is worse than a blank.
 *
 * NEWER ROWS DON'T NEED THE GUESSWORK. The payment app started sending the SKU
 * with the charge (a Stripe price id in `metadata.line_items`, and a "1x PW Tee"
 * description), so from 2026-05-31 those charges resolve from what Stripe
 * states rather than from what the amount implies — `itemSource` says which,
 * and `lib/salesItems.ts` explains the ranking.
 *
 * ── WHY THIS MODULE STOPPED BEING READ-ONLY ─────────────────────────────────
 * It was read-only on the reasoning that sales originate at Stripe and re-sync
 * idempotently, so there is nothing to hand-enter. That still holds for the
 * MONEY — gross and fee are the processor's word and no mutation here touches
 * them. It does not hold for the two facts the card reader never recorded on
 * the older taps: which items the amount was, and which event it happened at.
 * A better importer has since closed part of that gap and cannot close the
 * rest — 2025's charges say "Payment for Stripe App" and nothing more, so what
 * they bought exists only in the memory of whoever was standing at the table.
 * A page that shows a bookkeeper a hundred rows reading "Unresolved" with no
 * way to settle any of them is a report, not a tool.
 *
 * So two writes, and only two:
 *   - `setSaleItems` picks from the baskets the amount ACTUALLY makes (server
 *     re-enumerates them; a caller can't assert a breakdown that doesn't add
 *     up), recording `itemSource: "manual"` — the TOP rung of `salesItems.ts`'s
 *     ladder, which is what stops a later enrichment run quietly reverting a
 *     human's decision (`outranks` only ever moves a row up).
 *   - `setSaleEvent` attributes an orphan payment to an event, or detaches one
 *     attributed wrongly. The sync never revisits `eventId` on an existing row,
 *     so this too survives a re-run.
 * Both are bookkeeper+, both write `financeAuditLog`, and neither can move a
 * cent.
 *
 * Historical note: the 2026-08-09 Cash App backfill (a one-off since removed)
 * wrote three sales that never touched a card reader, keyed on `externalRef`
 * instead of a charge id. They read identically here — only `paymentRef` shows
 * the difference.
 */
import { mutation, query } from "./_generated/server";
import { v, ConvexError, type Infer } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { financeRoleAtLeast } from "@events-os/shared";
import { requireFinanceRole } from "./lib/finance";
import { logFinanceAudit } from "./lib/financeAuditLog";
import {
  basketOptions,
  catalogForDay,
  itemsToKey,
  type BasketOption,
} from "./lib/salesCatalog";

/** Bounded read — a chapter's sales history is small and stays small. */
const SALES_SCAN_LIMIT = 4000;
/** Bounded read for the event picker. A chapter runs events in the dozens. */
const EVENT_SCAN_LIMIT = 500;

/** The UTC day a sale landed on. Derived exactly as `salesSync` derives it, so
 *  a row's catalogue here is the same catalogue it was imported against. */
function dayISOFor(soldAt: number): string {
  return new Date(soldAt).toISOString().slice(0, 10);
}

const saleItemValidator = v.object({
  label: v.string(),
  quantity: v.number(),
  unitPriceCents: v.number(),
  /** >1 entry when several products share this price — the sale is real,
   *  which product it was is genuinely ambiguous. */
  candidates: v.array(v.string()),
});

/** One row of the Sales grid, whichever rail sold it. */
type SaleRow = Infer<typeof saleRowValidator>;

const saleRowValidator = v.object({
  /**
   * Which rail sold it. Founder, 2026-08-12: "we have regular sales, and we
   * have ticket sales, and they're coming from different tables, I know, but
   * they're all sales. So let's add it in there."
   *
   * They stay distinguishable rather than being flattened into one anonymous
   * list, because the two are not interchangeable to a bookkeeper: an
   * in-person tap may need its basket resolved and its event attributed, while
   * a ticket order already knows both and can't be edited from here.
   */
  kind: v.union(v.literal("in_person"), v.literal("ticket")),
  /** Row key — a `sales` id for a tap, a `ticketOrders` id for an order. */
  id: v.string(),
  /** Present ONLY on an in-person row; the two edit mutations key on it. A
   *  ticket order's items and event come from the order itself, so it carries
   *  `null` and the grid renders it read-only. */
  saleId: v.union(v.id("sales"), v.null()),
  /** Who bought it, when the rail records that. Ticket orders carry a
   *  purchaser; a card reader at a snack table does not. */
  buyerName: v.union(v.string(), v.null()),
  soldAt: v.number(),
  grossCents: v.number(),
  feeCents: v.number(),
  netCents: v.number(),
  channel: v.string(),
  itemSource: v.string(),
  items: v.array(saleItemValidator),
  eventId: v.union(v.id("events"), v.null()),
  eventName: v.union(v.string(), v.null()),
  /** The payment's id on whichever rail carried it — a Stripe charge id for a
   *  card tap, the namespaced `externalRef` for anything else (the 2026-08-09
   *  Cash App backfill). One field rather than two because a reader only ever
   *  wants "which payment was this", and the rail is legible from the string. */
  paymentRef: v.string(),
  /**
   * Every basket this amount could be, from the frozen catalogue for its day —
   * the row's own picker options, shipped WITH the row rather than fetched when
   * a cell opens. A chapter's whole sales history is a few hundred rows and the
   * enumeration is capped at 8 solutions, so computing them all costs less than
   * the round trip a lazy cell would need, and it lets the grid say "3 readings"
   * on a row before anyone clicks it.
   *
   * Empty means nothing can be offered: either no catalogue covers the day, or
   * no combination of that day's prices makes this amount. `hasCatalog`
   * separates the two, because they call for different words on screen.
   */
  itemOptions: v.array(
    v.object({
      key: v.string(),
      label: v.string(),
      items: v.array(saleItemValidator),
    }),
  ),
  /** The key of the basket currently recorded, when it is one of `itemOptions`.
   *  `null` for an empty breakdown — and, legitimately, for one the current
   *  catalogue no longer makes. */
  itemsKey: v.union(v.string(), v.null()),
  /** Whether a catalogue is defined for this sale's day at all. */
  hasCatalog: v.boolean(),
});

/**
 * Every sale for a chapter, newest first, with its event resolved, its picker
 * options attached, and a chapter-wide summary.
 *
 * ── WHY THE AGGREGATES LEFT ─────────────────────────────────────────────────
 * This used to return `byEvent` and `byItem` roll-ups, which the screen rendered
 * as two cards above the row list. They are gone, and nothing they said is
 * gone with them: the grid's Event and Item filters carry the same numbers as
 * FACET COUNTS, which is strictly more useful — a count you can click narrows
 * the table, a count in a card just sits there. That is the same move Reconcile
 * made when its nine counted chips became one counted dropdown.
 *
 * `summary` stays, and stays CHAPTER-WIDE rather than following the screen's
 * filters. A treasurer's "what did we take, what did Stripe keep, what reached
 * the bank" is a fact about the chapter, and a headline figure that silently
 * re-scoped itself every time someone clicked a filter would be a good way to
 * misreport revenue. It carries `unresolvedCents` alongside for the same reason
 * it always did: the first question a page full of "Unresolved" provokes is how
 * much money that accounts for, and the answer — all of it, the revenue is
 * exact and only the breakdown is missing — should not require adding up rows.
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
      /** The two rails, split out — "how much came from merch vs tickets" is
       *  the question a combined list otherwise makes harder to answer, not
       *  easier. */
      inPersonGrossCents: v.number(),
      ticketGrossCents: v.number(),
      /** True once any ticket row is in scope. `feeCents`/`netCents` above sum
       *  only the fees this app actually holds per row, and a ticket order
       *  doesn't carry one — Stripe's ticket fees are booked as a single
       *  monthly line in Reconcile rather than per order. Without this flag the
       *  net would silently read as if tickets cost nothing to process. */
      ticketFeesBookedMonthly: v.boolean(),
    }),
    /** The chapter's events, newest first — the Event cell's options. Every
     *  event, not just the ones already carrying sales: attributing an ORPHAN
     *  is the whole point, and an orphan by definition names none of them. */
    events: v.array(
      v.object({
        eventId: v.id("events"),
        name: v.string(),
        eventDate: v.union(v.number(), v.null()),
      }),
    ),
    /** Whether this caller may edit these rows. Today the read floor and the
     *  write floor are the same rank, so this is always true for anyone who
     *  gets a response at all — it exists so the grid renders from the SERVER's
     *  answer rather than assuming, the way Reconcile's rows carry their own
     *  `canEdit`. If sales reads ever drop to viewer (a peek), the grid goes
     *  read-only on its own and no affordance appears that the mutation would
     *  then refuse. */
    canEdit: v.boolean(),
    truncated: v.boolean(),
  }),
  handler: async (ctx, { chapterId, eventId }) => {
    // Bookkeeper+ — the same floor the rest of the finance reads use. Sales are
    // revenue detail, not public event data.
    const access = await requireFinanceRole(ctx, chapterId, "bookkeeper");

    const rows = await ctx.db
      .query("sales")
      .withIndex("by_chapter_and_soldAt", (q) => q.eq("chapterId", chapterId))
      .take(SALES_SCAN_LIMIT);
    const truncated = rows.length === SALES_SCAN_LIMIT;
    const scoped = eventId ? rows.filter((r) => r.eventId === eventId) : rows;

    const chapterEvents = await ctx.db
      .query("events")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(EVENT_SCAN_LIMIT);
    const eventName = new Map<string, string>();
    for (const e of chapterEvents) eventName.set(e._id as string, e.name);

    // One enumeration per distinct AMOUNT-and-DAY rather than per sale: 186
    // sales collapse to a couple of dozen distinct pairs, and the catalogue is
    // frozen, so the answer for $3 on 2025-12-06 is the same answer every time.
    const optionCache = new Map<string, BasketOption[]>();
    const optionsFor = (soldAt: number, grossCents: number) => {
      const dayISO = dayISOFor(soldAt);
      const cacheKey = `${dayISO}:${grossCents}`;
      const hit = optionCache.get(cacheKey);
      if (hit) return hit;
      const catalog = catalogForDay(dayISO);
      const options = catalog ? basketOptions(grossCents, catalog.units) : [];
      optionCache.set(cacheKey, options);
      return options;
    };

    // Both rails produce the SAME row type — annotated rather than inferred so
    // a divergence between the two shapes is a compile error here, not a union
    // every consumer has to narrow.
    const inPersonRows: SaleRow[] = scoped.map((r: Doc<"sales">) => ({
      kind: "in_person" as const,
      id: r._id as string,
      saleId: r._id,
      buyerName: null,
      soldAt: r.soldAt,
      grossCents: r.grossCents,
      feeCents: r.feeCents,
      netCents: r.grossCents - r.feeCents,
      channel: r.channel,
      itemSource: r.itemSource,
      items: r.items,
      eventId: r.eventId ?? null,
      eventName: r.eventId ? (eventName.get(r.eventId) ?? null) : null,
      paymentRef: r.stripeChargeId ?? r.externalRef ?? "",
      itemOptions: optionsFor(r.soldAt, r.grossCents),
      itemsKey: itemsToKey(r.items),
      hasCatalog: catalogForDay(dayISOFor(r.soldAt)) !== null,
    }));

    // ── Ticket orders, as sales ────────────────────────────────────────────
    // The other half of "they're all sales". A ticket order needs none of the
    // basket guesswork above — it was sold from a catalogue that recorded what
    // it sold — so its items come straight off the order and its `itemSource`
    // says so, which is also why it is not editable here.
    //
    // ONLY `paid` orders. A pending order is a checkout somebody abandoned, and
    // canceled/refunded/expired ones are not revenue; counting any of them
    // would inflate this page above what the accounts page reports, and those
    // two must agree.
    //
    // `donationCents` is deliberately excluded: an add-on gift rides in the
    // same Stripe charge but is split off to `donations` by the webhook and
    // counted in giving. Including it here would count that money twice.
    const ticketOrders = await ctx.db
      .query("ticketOrders")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .take(SALES_SCAN_LIMIT);
    const ticketsTruncated = ticketOrders.length === SALES_SCAN_LIMIT;
    const ticketRows: SaleRow[] = ticketOrders
      .filter((o) => o.status === "paid")
      .filter((o) => (eventId ? o.eventId === eventId : true))
      .map((o: Doc<"ticketOrders">) => ({
        kind: "ticket" as const,
        id: o._id as string,
        saleId: null,
        buyerName: o.name || null,
        // A paid order's `updatedAt` is when the webhook settled it; `createdAt`
        // is when the checkout opened. The money arrived at settlement, which is
        // the date this page sorts and reports on.
        soldAt: o.updatedAt,
        grossCents: o.totalCents,
        // Not zero-because-free: Stripe's ticket fees are booked as one monthly
        // Reconcile line rather than per order, so there is no per-row fee to
        // report. `summary.ticketFeesBookedMonthly` is what says so on screen.
        feeCents: 0,
        netCents: o.totalCents,
        channel: o.externalProvider ?? "stripe_checkout",
        itemSource: "ticket_order",
        items: o.items.map((i) => ({
          label: i.name,
          quantity: i.quantity,
          unitPriceCents: i.unitPriceCents,
          // Never ambiguous: the order names the ticket type it sold. The
          // `candidates` list exists for taps where several products share a
          // price, which cannot happen here.
          candidates: [],
        })),
        eventId: o.eventId,
        eventName: eventName.get(o.eventId as string) ?? null,
        paymentRef: o.stripePaymentIntentId ?? o.externalRef ?? "",
        // No basket to guess at, so nothing to offer and nothing to pick.
        itemOptions: [],
        itemsKey: null,
        hasCatalog: false,
      }));

    const sales = [...inPersonRows, ...ticketRows].sort((a, b) => b.soldAt - a.soldAt);

    const grossCents = sales.reduce((a, s) => a + s.grossCents, 0);
    const feeCents = sales.reduce((a, s) => a + s.feeCents, 0);
    // "Unresolved" is an in-person concept — it means the amount alone couldn't
    // be turned back into a basket. A ticket order is never unresolved, so it
    // must not dilute the count the bookkeeper works through.
    const unresolved = inPersonRows.filter((s) => s.itemSource === "unresolved");

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
        inPersonGrossCents: inPersonRows.reduce((a, s) => a + s.grossCents, 0),
        ticketGrossCents: ticketRows.reduce((a, s) => a + s.grossCents, 0),
        ticketFeesBookedMonthly: ticketRows.length > 0,
      },
      events: chapterEvents
        .slice()
        .sort((a, b) => (b.eventDate ?? 0) - (a.eventDate ?? 0))
        .map((e) => ({
          eventId: e._id,
          name: e.name,
          eventDate: e.eventDate ?? null,
        })),
      canEdit: financeRoleAtLeast(access.role, "bookkeeper"),
      truncated: truncated || ticketsTruncated,
    };
  },
});

/** Load a sale and assert the caller may edit it. Bookkeeper+ is the floor used
 *  across this whole finance surface — the same rank `listSales` reads at, and
 *  the same one `finances.ts`'s marking mutations write at. A viewer (or a
 *  central peek) never reaches either. */
async function requireEditableSale(
  ctx: MutationCtx,
  saleId: Id<"sales">,
): Promise<{ sale: Doc<"sales">; actorPersonId: Id<"people"> | null }> {
  const sale = await ctx.db.get(saleId);
  if (!sale) {
    throw new ConvexError({ code: "NOT_FOUND", message: "That sale no longer exists." });
  }
  const access = await requireFinanceRole(ctx, sale.chapterId, "bookkeeper");
  return { sale, actorPersonId: access.personId };
}

/** How a breakdown reads in the audit trail. */
function itemsLabel(items: Doc<"sales">["items"]): string {
  if (items.length === 0) return "Unresolved";
  return items
    .map((i) => (i.quantity > 1 ? `${i.quantity} × ${i.label}` : i.label))
    .join(" + ");
}

/**
 * Settle what a sale's amount was, from the baskets it could actually be.
 *
 * `basketKey` names one of the decompositions `lib/salesCatalog.ts` enumerates
 * for this amount against its day's frozen catalogue; `null` puts the row back
 * to `unresolved`. The server re-enumerates rather than trusting anything the
 * client sends, which is the whole design: a bookkeeper can tell us WHICH of the
 * readings the money admits is the true one, and cannot tell us the money bought
 * something it could not have bought. "$5 was a popcorn, not five waters" is
 * knowledge; "$5 was a hoodie" is a typo, and this refuses it.
 *
 * Clearing is deliberately available even on a row the importer resolved on its
 * own — a single-reading decomposition is still only arithmetic, and if the
 * person who was there says it's wrong, "Unresolved" is a better record than a
 * confident falsehood.
 */
export const setSaleItems = mutation({
  args: {
    saleId: v.id("sales"),
    /** A key from the row's `itemOptions`, or `null` to clear back to unresolved. */
    basketKey: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, { saleId, basketKey }) => {
    const { sale, actorPersonId } = await requireEditableSale(ctx, saleId);
    const before = itemsLabel(sale.items);

    if (basketKey === null) {
      if (sale.items.length === 0 && sale.itemSource === "unresolved") return null;
      await ctx.db.patch(sale._id, { items: [], itemSource: "unresolved" });
      await logFinanceAudit(ctx, {
        chapterId: sale.chapterId,
        subjectType: "sale",
        subjectId: sale._id,
        action: "sale_items_set",
        actorPersonId,
        field: "items",
        before,
        after: "Unresolved",
      });
      return null;
    }

    const catalog = catalogForDay(dayISOFor(sale.soldAt));
    if (!catalog) {
      throw new ConvexError({
        code: "NO_CATALOG",
        message:
          "There's no price list on file for the day this sale happened, so there's nothing to choose from.",
      });
    }
    const option = basketOptions(sale.grossCents, catalog.units).find(
      (o) => o.key === basketKey,
    );
    if (!option) {
      throw new ConvexError({
        code: "NO_SUCH_BASKET",
        message:
          "That combination doesn't add up to what was paid. Pick one of the readings offered for this amount.",
      });
    }

    await ctx.db.patch(sale._id, { items: option.items, itemSource: "manual" });
    await logFinanceAudit(ctx, {
      chapterId: sale.chapterId,
      subjectType: "sale",
      subjectId: sale._id,
      action: "sale_items_set",
      actorPersonId,
      field: "items",
      before,
      after: option.label,
    });
    return null;
  },
});

/**
 * Attribute a sale to an event, or detach one attributed wrongly.
 *
 * The importer matches by name AND date (`salesSync`), which is right and still
 * leaves orphans: a payment taken the morning after a two-day event, or one on a
 * day no event was recorded, matches nothing and lands unattributed. Nobody but
 * a person can close that gap, and until now nobody could.
 *
 * Chapter-locked: an event from another chapter is refused rather than silently
 * moving a chapter's revenue into another chapter's event reporting. The sale's
 * own `chapterId` is never touched here — which book took the money is a fact
 * about the payment, not a judgement, and it isn't editable on this surface.
 */
export const setSaleEvent = mutation({
  args: {
    saleId: v.id("sales"),
    /** The event this sale happened at, or `null` to leave it unattributed. */
    eventId: v.union(v.id("events"), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, { saleId, eventId }) => {
    const { sale, actorPersonId } = await requireEditableSale(ctx, saleId);
    if ((sale.eventId ?? null) === eventId) return null;

    const previous = sale.eventId ? await ctx.db.get(sale.eventId) : null;
    let nextName = "Unattributed";
    if (eventId !== null) {
      const event = await ctx.db.get(eventId);
      if (!event) {
        throw new ConvexError({ code: "NOT_FOUND", message: "That event no longer exists." });
      }
      if (event.chapterId !== sale.chapterId) {
        throw new ConvexError({
          code: "CROSS_CHAPTER_EVENT",
          message: "That event belongs to another chapter. A sale stays with the book that took it.",
        });
      }
      nextName = event.name;
    }

    // `undefined` REMOVES the field, which is what "unattributed" means in this
    // schema — `eventId` is optional and its absence is the orphan state.
    await ctx.db.patch(sale._id, { eventId: eventId ?? undefined });
    await logFinanceAudit(ctx, {
      chapterId: sale.chapterId,
      subjectType: "sale",
      subjectId: sale._id,
      action: "sale_event_set",
      actorPersonId,
      field: "event",
      before: previous?.name ?? "Unattributed",
      after: nextName,
    });
    return null;
  },
});
