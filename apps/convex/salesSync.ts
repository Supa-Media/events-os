/**
 * Stripe → `sales` sync.
 *
 * Brings in the third revenue stream. Gifts and ticket orders already reach the books
 * through their own paths; in-person sales never did, so $1,588 of real revenue —
 * snacks at Pop The Balloon, tees at Eden — was invisible to book value while its cash
 * sat in the bank. That gap is most of why book value and cash disagree.
 *
 * SCOPE: CARD-PRESENT CHARGES ONLY. Every online charge in this account is already a
 * ticket order or a gift, recorded when it was taken. Syncing those as sales too would
 * double-count exactly the money this is meant to fix, so `card_present` is the filter
 * and the sync will not touch anything else.
 *
 * FEES ARE READ, NEVER DERIVED. Each charge's `balance_transaction` is expanded to get
 * Stripe's actual cut. That's the honest fee figure the earlier attempt at this
 * couldn't obtain — inferring it from deposit residuals gave "fees minus unrecorded
 * sales", which is not a fee.
 *
 * ITEMS ARE RESOLVED OR ABSENT. `lib/salesCatalog.ts` asserts a breakdown only when
 * exactly one reading of the amount exists; anything else stores the revenue with no
 * items and `itemSource: "unresolved"`. Pop The Balloon's snack prices overlap so
 * heavily that most of it lands there, and that is the correct outcome — the money and
 * the event are certain, the SKU is not, and a fabricated SKU is worse than a blank.
 *
 * The action pages Stripe and hands batches to an internal mutation; Convex actions
 * can't touch the database directly. Idempotent on `stripeChargeId`, so re-running
 * imports only what's new.
 */
"use node";

import { action, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { NEW_YORK_CHAPTER_SLUG } from "./lib/seed/historical/mapping";
import { catalogForDay, resolveCharge } from "./lib/salesCatalog";
import { requireSuperuser } from "./lib/superuser";

const STRIPE_API = "https://api.stripe.com/v1";
const PAGE = 100;

const saleItem = v.object({
  label: v.string(),
  quantity: v.number(),
  unitPriceCents: v.number(),
  candidates: v.array(v.string()),
});

/** Write one page of resolved charges. Separate from the action because only a
 *  mutation may write, and because it keeps the Stripe shape at the boundary. */
export const upsertSales = internalMutation({
  args: {
    rows: v.array(
      v.object({
        stripeChargeId: v.string(),
        soldAt: v.number(),
        grossCents: v.number(),
        feeCents: v.number(),
        dayISO: v.string(),
        eventName: v.union(v.string(), v.null()),
        items: v.array(saleItem),
        itemSource: v.union(
          v.literal("stripe_line_items"),
          v.literal("amount_decomposition"),
          v.literal("unresolved"),
        ),
      }),
    ),
    execute: v.optional(v.boolean()),
  },
  returns: v.object({
    created: v.number(),
    alreadyPresent: v.number(),
    unresolved: v.number(),
    grossCents: v.number(),
    feeCents: v.number(),
    unmatchedEvents: v.array(v.string()),
  }),
  handler: async (ctx, { rows, execute }) => {
    const write = execute ?? false;
    const chapter = await ctx.db
      .query("chapters")
      .withIndex("by_slug", (q) => q.eq("slug", NEW_YORK_CHAPTER_SLUG))
      .first();
    if (!chapter) throw new ConvexError({ code: "NO_CHAPTER", message: "NY chapter not found." });

    const events = await ctx.db
      .query("events")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapter._id))
      .collect();

    let created = 0, alreadyPresent = 0, unresolved = 0, grossCents = 0, feeCents = 0;
    const unmatchedEvents = new Set<string>();

    for (const row of rows) {
      const existing = await ctx.db
        .query("sales")
        .withIndex("by_charge", (q) => q.eq("stripeChargeId", row.stripeChargeId))
        .first();
      if (existing) { alreadyPresent++; continue; }

      // Resolve the event by NAME AND DATE together. Two events are called "Eden";
      // only the one whose `eventDate` is the sale day is the right one.
      let eventId: Id<"events"> | undefined;
      if (row.eventName) {
        const match = events.find(
          (e) =>
            e.name === row.eventName &&
            e.eventDate != null &&
            new Date(e.eventDate).toISOString().slice(0, 10) === row.dayISO,
        );
        // Pop The Balloon ran over two days; the event carries the first.
        const loose = events.filter((e) => e.name === row.eventName);
        eventId = match?._id ?? (loose.length === 1 ? loose[0]._id : undefined);
        if (!eventId) unmatchedEvents.add(`${row.eventName} @ ${row.dayISO}`);
      }

      grossCents += row.grossCents;
      feeCents += row.feeCents;
      if (row.itemSource === "unresolved") unresolved++;

      if (write) {
        await ctx.db.insert("sales", {
          chapterId: chapter._id,
          ...(eventId ? { eventId } : {}),
          stripeChargeId: row.stripeChargeId,
          soldAt: row.soldAt,
          grossCents: row.grossCents,
          feeCents: row.feeCents,
          items: row.items,
          itemSource: row.itemSource,
          channel: "in_person",
          createdAt: Date.now(),
        });
      }
      created++;
    }
    return {
      created, alreadyPresent, unresolved, grossCents, feeCents,
      unmatchedEvents: [...unmatchedEvents],
    };
  },
});

/**
 * Pull card-present charges from Stripe and record them as sales.
 * `execute` omitted / false = a zero-write dry run reporting exactly what a real run
 * would import. Superuser-gated: it reads the whole payment history.
 */
export const syncStripeSales = action({
  args: { execute: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    chargesScanned: v.number(),
    cardPresent: v.number(),
    created: v.number(),
    alreadyPresent: v.number(),
    unresolved: v.number(),
    grossCents: v.number(),
    feeCents: v.number(),
    unmatchedEvents: v.array(v.string()),
  }),
  handler: async (ctx, { execute }) => {
    await requireSuperuser(ctx);
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new ConvexError({ code: "NO_KEY", message: "STRIPE_SECRET_KEY is not set." });

    let startingAfter: string | undefined;
    let chargesScanned = 0, cardPresent = 0;
    let created = 0, alreadyPresent = 0, unresolved = 0, grossCents = 0, feeCents = 0;
    const unmatchedEvents = new Set<string>();

    for (;;) {
      const params = new URLSearchParams({ limit: String(PAGE) });
      // Expanding the balance transaction is what makes the fee a READ, not a guess.
      params.append("expand[]", "data.balance_transaction");
      if (startingAfter) params.set("starting_after", startingAfter);
      const res = await fetch(`${STRIPE_API}/charges?${params.toString()}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) {
        throw new ConvexError({
          code: "STRIPE_ERROR",
          message: `Stripe charges read failed (${res.status}).`,
        });
      }
      const page = (await res.json()) as {
        data: Array<Record<string, unknown>>;
        has_more: boolean;
      };

      const rows: {
        stripeChargeId: string; soldAt: number; grossCents: number; feeCents: number;
        dayISO: string; eventName: string | null;
        items: { label: string; quantity: number; unitPriceCents: number; candidates: string[] }[];
        itemSource: "stripe_line_items" | "amount_decomposition" | "unresolved";
      }[] = [];

      for (const c of page.data) {
        chargesScanned++;
        const pmd = (c.payment_method_details ?? {}) as { type?: string };
        if (pmd.type !== "card_present") continue;
        if (c.status !== "succeeded" || c.captured !== true) continue;
        cardPresent++;

        const soldAt = (c.created as number) * 1000;
        const dayISO = new Date(soldAt).toISOString().slice(0, 10);
        const bt = c.balance_transaction as { fee?: number } | string | null;
        const fee = typeof bt === "object" && bt ? (bt.fee ?? 0) : 0;
        const catalog = catalogForDay(dayISO);
        const resolution = catalog
          ? resolveCharge(c.amount as number, catalog.units)
          : ({ kind: "unresolved", reason: "no_match", waysFound: 0 } as const);

        rows.push({
          stripeChargeId: c.id as string,
          soldAt,
          grossCents: c.amount as number,
          feeCents: fee,
          dayISO,
          eventName: catalog?.eventName ?? null,
          items:
            resolution.kind === "resolved"
              ? resolution.lines.map((l) => ({
                  label: l.unit.label,
                  quantity: l.quantity,
                  unitPriceCents: l.unit.unitPriceCents,
                  candidates: l.unit.candidates,
                }))
              : [],
          itemSource: resolution.kind === "resolved" ? "amount_decomposition" : "unresolved",
        });
        startingAfter = c.id as string;
      }
      if (rows.length) {
        const r = await ctx.runMutation(internal.salesSync.upsertSales, {
          rows,
          ...(execute ? { execute: true } : {}),
        });
        created += r.created; alreadyPresent += r.alreadyPresent;
        unresolved += r.unresolved; grossCents += r.grossCents; feeCents += r.feeCents;
        for (const e of r.unmatchedEvents) unmatchedEvents.add(e);
      }

      if (!page.has_more) break;
      if (!page.data.length) break;
      startingAfter = page.data[page.data.length - 1].id as string;
    }

    return {
      dryRun: !execute,
      chargesScanned, cardPresent, created, alreadyPresent, unresolved,
      grossCents, feeCents, unmatchedEvents: [...unmatchedEvents],
    };
  },
});
