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
 * ITEMS ARE READ BEFORE THEY ARE DEDUCED. Stripe often knows what was sold and this
 * sync used to ignore it: its only strategy was to decompose the AMOUNT against
 * `lib/salesCatalog.ts`'s hand-typed per-event price list, so the 2026-08-08 tees — four
 * of whose five charges say `1x PW Tee` outright, with a real Stripe price id in
 * `metadata.line_items` — booked as "unresolved" purely because nobody had added a
 * 2026-08-08 catalogue entry. `lib/salesItems.ts` now takes the charge's own evidence
 * first (price metadata, then description) and the decomposition only speaks when the
 * charge genuinely carries no label. Where nothing can speak the row still stores its
 * revenue with no items and `itemSource: "unresolved"` — the money and the event are
 * certain, the SKU is not, and a fabricated SKU is worse than a blank.
 *
 * A RE-RUN MAY ENRICH, NEVER RE-IMPORT. `upsertSales` still keys on `stripeChargeId` and
 * still inserts at most one row per charge — double-counting revenue is the failure this
 * sync must never commit. What it will now do is PATCH `items`/`itemSource` on a row
 * whose breakdown it can improve, and only ever upward (`salesItems.ts#outranks`), so
 * the 2026-08-08 sales already sitting in the books can gain their breakdown from a
 * re-run without their money moving a cent.
 *
 * The action pages Stripe and hands batches to an internal mutation; Convex actions
 * can't touch the database directly. Idempotent on `stripeChargeId`, so re-running
 * imports only what's new.
 *
 * NO `"use node"` — deliberately, and it is load-bearing. `fetch()` runs in Convex's
 * default runtime (same reasoning as `stripeFinance.ts`), and a Node file may contain
 * ONLY actions. With the directive, the `upsertSales` mutation below fails the push
 * with `InvalidModules` — which typecheck and the test suite both pass straight
 * through, because neither performs a deploy. It only surfaces at `convex deploy`.
 */

import { action, internalAction, internalMutation } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { NEW_YORK_CHAPTER_SLUG } from "./lib/seed/historical/mapping";
import { catalogForDay, resolveCharge } from "./lib/salesCatalog";
import {
  itemsFromDescription,
  itemsFromPrices,
  outranks,
  type SyncedItemSource,
  parseLineItemsMetadata,
  type ItemSource,
  type PriceRecord,
  type SaleItem,
} from "./lib/salesItems";
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
          v.literal("charge_description"),
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
    /** Rows already imported whose breakdown this run improved. A subset of
     *  `alreadyPresent`, and never counted as revenue — see the handler. */
    enriched: v.number(),
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

    let created = 0, alreadyPresent = 0, enriched = 0, unresolved = 0, grossCents = 0, feeCents = 0;
    const unmatchedEvents = new Set<string>();

    for (const row of rows) {
      const existing = await ctx.db
        .query("sales")
        .withIndex("by_charge", (q) => q.eq("stripeChargeId", row.stripeChargeId))
        .first();
      if (existing) {
        alreadyPresent++;
        // ENRICH, NEVER RE-IMPORT. This charge already has its row, so its money is
        // already in the books — it must not be inserted again and must not be added to
        // this run's `grossCents`/`feeCents`, which report what a run would BRING IN.
        // The only thing a second look can legitimately add is a better breakdown, so
        // the patch touches `items` and `itemSource` and nothing else: not the amounts,
        // not the fee, not `soldAt`, not the event. And only upward — `outranks` stops a
        // transient Stripe failure from replacing a good breakdown with a blank, which
        // would make an idempotent sync quietly lossy.
        if (outranks(row.itemSource, existing.itemSource)) {
          enriched++;
          if (write) {
            await ctx.db.patch(existing._id, {
              items: row.items,
              itemSource: row.itemSource,
            });
          }
        }
        continue;
      }

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
      created, alreadyPresent, enriched, unresolved, grossCents, feeCents,
      unmatchedEvents: [...unmatchedEvents],
    };
  },
});

/**
 * Pull card-present charges from Stripe and record them as sales.
 * `execute` omitted / false = a zero-write dry run reporting exactly what a real run
 * would import. Superuser-gated: it reads the whole payment history.
 */
const syncReturns = v.object({
  dryRun: v.boolean(),
  chargesScanned: v.number(),
  cardPresent: v.number(),
  created: v.number(),
  alreadyPresent: v.number(),
  /** Already-imported rows whose breakdown this run improved. On a dry run this is the
   *  count a real run WOULD improve — the honest preview of a backfill that adds no
   *  money, which is the only kind of re-run this sync performs. */
  enriched: v.number(),
  unresolved: v.number(),
  grossCents: v.number(),
  feeCents: v.number(),
  unmatchedEvents: v.array(v.string()),
});

/**
 * Resolve Stripe Price ids to their unit amount and product name, memoized for the run.
 *
 * A LOOKUP FAILURE IS NOT A RUN FAILURE. Anything other than a clean 200 caches `null`,
 * which makes `itemsFromPrices` decline and the charge fall to a weaker rung. A Stripe
 * blip must cost a breakdown, never a sale: the revenue is already known from the charge
 * itself and must land in the books either way. The cache also keeps this to one request
 * per distinct price across the whole history rather than one per charge.
 */
async function loadPrices(
  key: string,
  ids: string[],
  cache: Map<string, PriceRecord | null>,
): Promise<void> {
  for (const id of ids) {
    if (cache.has(id)) continue;
    let record: PriceRecord | null = null;
    try {
      const res = await fetch(
        `${STRIPE_API}/prices/${encodeURIComponent(id)}?expand[]=product`,
        { headers: { Authorization: `Bearer ${key}` } },
      );
      if (res.ok) {
        const p = (await res.json()) as {
          unit_amount?: number | null;
          currency?: string;
          nickname?: string | null;
          product?: { name?: string } | string | null;
        };
        const product = typeof p.product === "object" && p.product ? p.product : null;
        record = {
          unitAmountCents: typeof p.unit_amount === "number" ? p.unit_amount : null,
          currency: typeof p.currency === "string" ? p.currency : "",
          // The product's name is the label a human would recognise; the price's own
          // nickname is the fallback for a price attached to an unnamed product.
          label: (product?.name ?? p.nickname ?? "").trim(),
        };
      }
    } catch {
      record = null;
    }
    cache.set(id, record);
  }
}

/** The sync itself, with no authorization of its own — each entry point below brings
 *  its own. Shared so the app-facing and ops paths can never drift apart. */
async function runSync(ctx: ActionCtx, execute: boolean | undefined) {
  {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new ConvexError({ code: "NO_KEY", message: "STRIPE_SECRET_KEY is not set." });

    let startingAfter: string | undefined;
    let chargesScanned = 0, cardPresent = 0;
    let created = 0, alreadyPresent = 0, enriched = 0, unresolved = 0;
    let grossCents = 0, feeCents = 0;
    const unmatchedEvents = new Set<string>();
    // One Price lookup per distinct id for the whole run, not per charge.
    const priceCache = new Map<string, PriceRecord | null>();

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
        items: SaleItem[];
        itemSource: SyncedItemSource;
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
        const amount = c.amount as number;
        const currency = typeof c.currency === "string" ? c.currency : "usd";
        const metadata = (c.metadata ?? {}) as Record<string, unknown>;
        const catalog = catalogForDay(dayISO);

        // THE LADDER (see lib/salesItems.ts): what Stripe stated, then what the seller
        // wrote down, then what the amount can be deduced to mean. Each rung only runs
        // when the one above declined, so a charge that says what it is is never
        // second-guessed by a price list.
        let items: SaleItem[] = [];
        let itemSource: SyncedItemSource = "unresolved";

        const refs = parseLineItemsMetadata(metadata.line_items);
        if (refs) {
          await loadPrices(key, refs.map((r) => r.priceId), priceCache);
          const priced = itemsFromPrices(amount, currency, refs, priceCache);
          if (priced) { items = priced; itemSource = "stripe_line_items"; }
        }

        if (itemSource === "unresolved") {
          const described = itemsFromDescription(
            c.description,
            metadata.device_charge_description,
            amount,
          );
          if (described) { items = described; itemSource = "charge_description"; }
        }

        if (itemSource === "unresolved" && catalog) {
          const resolution = resolveCharge(amount, catalog.units);
          if (resolution.kind === "resolved") {
            items = resolution.lines.map((l) => ({
              label: l.unit.label,
              quantity: l.quantity,
              unitPriceCents: l.unit.unitPriceCents,
              candidates: l.unit.candidates,
            }));
            itemSource = "amount_decomposition";
          }
        }

        rows.push({
          stripeChargeId: c.id as string,
          soldAt,
          grossCents: amount,
          feeCents: fee,
          dayISO,
          // TODO: Investigate — the EVENT is still attributed via the hand-kept
          // catalogue, so a day nobody added an entry for lands unattributed even now
          // that its items resolve. That is the same root cause as the item bug this
          // change fixes, one field over: the 2026-08-08 sales carry no `eventId` for
          // exactly this reason. Matching the sale's day against the chapter's
          // `events.eventDate` would need no hand-maintenance at all, but it is a
          // behaviour change to attribution rather than to the breakdown, so it is
          // deliberately not bundled here.
          eventName: catalog?.eventName ?? null,
          items,
          itemSource,
        });
        startingAfter = c.id as string;
      }
      if (rows.length) {
        const r = await ctx.runMutation(internal.salesSync.upsertSales, {
          rows,
          ...(execute ? { execute: true } : {}),
        });
        created += r.created; alreadyPresent += r.alreadyPresent; enriched += r.enriched;
        unresolved += r.unresolved; grossCents += r.grossCents; feeCents += r.feeCents;
        for (const e of r.unmatchedEvents) unmatchedEvents.add(e);
      }

      if (!page.has_more) break;
      if (!page.data.length) break;
      startingAfter = page.data[page.data.length - 1].id as string;
    }

    return {
      dryRun: !execute,
      chargesScanned, cardPresent, created, alreadyPresent, enriched, unresolved,
      grossCents, feeCents, unmatchedEvents: [...unmatchedEvents],
    };
  }
}

/**
 * App-facing sync. Superuser-gated because it reads the entire payment history.
 * This is what a "Sync from Stripe" control in the Sales tab calls.
 */
export const syncStripeSales = action({
  args: { execute: v.optional(v.boolean()) },
  returns: syncReturns,
  handler: async (ctx, { execute }) => {
    await requireSuperuser(ctx);
    return runSync(ctx, execute);
  },
});

/**
 * Ops entry point for the one-time backfill, run from the CLI.
 *
 * No `requireSuperuser`: that resolves the caller from an authenticated session, and a
 * CLI invocation has none — it carries the deployment admin key instead, which is
 * strictly stronger. Gating on a session here would only make the backfill impossible
 * to run, not safer. Same body as the public action, so behaviour cannot diverge.
 */
export const syncStripeSalesOps = internalAction({
  args: { execute: v.optional(v.boolean()) },
  returns: syncReturns,
  handler: async (ctx, { execute }) => runSync(ctx, execute),
});
