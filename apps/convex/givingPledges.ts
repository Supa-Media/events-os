/**
 * Giving Platform (F-6, Phase 2) — recurring backer billing on Stripe
 * subscriptions (PRD §2). A BACKER is a donor with an `active` monthly pledge
 * to a city at/above `BACKER_UNIT_CENTS`; the affordability tiers count them.
 *
 * House Stripe style (mirrors `stripe.ts` + `giving.ts`): REST over `fetch` in
 * the default Convex runtime — no SDK, no `"use node"`. Card data never touches
 * our code (Stripe-hosted Checkout + billing portal). Never trust a client
 * amount on settle: every cycle's money is read from the Stripe invoice object.
 *
 * Flow:
 *   startPledgeCheckout (public action) → preparePledge (incomplete row) →
 *   Stripe Checkout `mode=subscription` → the shared `/stripe/webhook` fan-out
 *   in http.ts drives the lifecycle:
 *     - checkout.session.completed  → activatePledgeFromCheckout (→ active)
 *     - invoice.paid                → recordPledgeInvoice (one gift per cycle)
 *     - invoice.payment_failed      → markPledgePastDue
 *     - customer.subscription.updated → syncPledgeSubscription
 *     - customer.subscription.deleted → cancelPledgeSubscription
 *   Each handler no-ops if the object isn't a pledge's (the established "safe
 *   fan-out" pattern), so it can't touch a ticket/donation session.
 *
 * `chapters.backerCount` is DERIVED here: recomputed from active pledges on
 * every status/amount transition (`recomputeChapterBackerCount`). Money is
 * always integer cents; `transactions` stays the only actuals ledger (PRD §7).
 * See docs/plans/giving-platform.md §2.
 */
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { BACKER_UNIT_CENTS } from "@events-os/shared";
import { normalizeEmail } from "./lib/access";
import {
  requireGivingManage,
  requireGivingView,
  type GivingScope,
} from "./lib/givingAccess";
import { matchOrCreateDonor, recordGiftForDonor } from "./lib/givingDonors";
import { PLEDGE_STATUSES } from "./schema/givingPlatform";
import { siteUrl } from "./lib/siteUrl";

const STRIPE_API = "https://api.stripe.com/v1";

/** The monthly pledge FLOOR, in cents ($20 — the schema's `≥ 2000`, PRD §2's
 *  smallest preset). A pledge below `BACKER_UNIT_CENTS` still counts the donor
 *  as a donor, just not as a backer (see `recomputeChapterBackerCount`). */
const PLEDGE_FLOOR_CENTS = 2000;

/** Bounded read for the derived backer-count recompute — mirrors the
 *  `GIFT_WINDOW_LIMIT` bounded-recompute precedent in `givingPlatform.ts`. A
 *  chapter's active-pledge set is far smaller than this in practice. */
const BACKER_RECOUNT_LIMIT = 10000;

/** A generous bound on an admin pledge list (mirrors `listDonors`'s 500). */
const PLEDGE_LIST_LIMIT = 500;

/** Pledges shown on a donor's detail (a donor holds very few). */
const DONOR_PLEDGE_LIMIT = 50;

/** Import cap per call — Givebutter recurring-donor lists are small (tens), so
 *  one bounded batch covers a cutover import without self-reschedule. */
const IMPORT_LIMIT = 500;

const scopeValidator = v.union(v.id("chapters"), v.literal("central"));
const pledgeStatusValidator = v.union(
  ...PLEDGE_STATUSES.map((s) => v.literal(s)),
);
type PledgeStatus = (typeof PLEDGE_STATUSES)[number];

// ── Guards ────────────────────────────────────────────────────────────────────

/** Guard: a monthly pledge is a whole number of cents at/above the $20 floor. */
function assertPledgeFloor(amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents < PLEDGE_FLOOR_CENTS) {
    throw new ConvexError({
      code: "INVALID_AMOUNT",
      message: "A monthly pledge must be at least $20.",
    });
  }
}

// ── Derived backer count ──────────────────────────────────────────────────────

/**
 * Recompute + persist a chapter's derived `backerCount` (PRD §2's "retiring the
 * manual number"): the count of `active` pledges scoped to the chapter whose
 * `amountCents >= BACKER_UNIT_CENTS`. Called on EVERY pledge status/amount
 * transition so the affordability header, skim math, and transfer automation
 * read a truthful, live number without any code change on their side.
 *
 * `central` has no `chapters.backerCount` to derive, so it's a no-op there.
 * NOTE: `finances.setBackerCount` stays the MANUAL override during the
 * Givebutter migration — it and this derived path coexist until cutover
 * completes, then the manual path retires (see that mutation's doc comment).
 */
export async function recomputeChapterBackerCount(
  ctx: MutationCtx,
  scope: GivingScope,
): Promise<void> {
  if (scope === "central") return; // only real chapters carry a backer count
  const active = await ctx.db
    .query("pledges")
    .withIndex("by_scope_and_status", (q) =>
      q.eq("scope", scope).eq("status", "active"),
    )
    .take(BACKER_RECOUNT_LIMIT);
  // Owner-tunable default (PRD Appendix C#2): a pledge below BACKER_UNIT_CENTS
  // ($50/mo) makes the person a DONOR but NOT a BACKER — only pledges at/above
  // the unit count toward the affordability tiers. Flip this predicate if the
  // owner decides partial pledges count.
  const count = active.filter((p) => p.amountCents >= BACKER_UNIT_CENTS).length;
  await ctx.db.patch(scope, {
    backerCount: Math.max(0, count),
    backerCountUpdatedAt: Date.now(),
  });
}

/** Resolve a pledge by its Stripe subscription id (webhook object → pledge). */
async function pledgeBySubscription(
  ctx: MutationCtx,
  subscriptionId: string,
): Promise<Doc<"pledges"> | null> {
  if (!subscriptionId) return null;
  return await ctx.db
    .query("pledges")
    .withIndex("by_stripe_subscription", (q) =>
      q.eq("stripeSubscriptionId", subscriptionId),
    )
    .unique();
}

/** Map a Stripe subscription `status` onto our pledge status; unknown Stripe
 *  states leave the pledge where it is (`fallback`). */
function mapStripeSubStatus(
  stripeStatus: string,
  fallback: PledgeStatus,
): PledgeStatus {
  switch (stripeStatus) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    case "incomplete":
      return "incomplete";
    default:
      return fallback;
  }
}

// ── Public: subscribe ─────────────────────────────────────────────────────────

/**
 * Validate a backer signup and create an `incomplete` pledge (+ match-or-create
 * the donor). Called by `startPledgeCheckout` right before Stripe. Mirrors
 * `giving.prepareDonation`.
 */
export const preparePledge = internalMutation({
  args: {
    chapterId: v.id("chapters"),
    amountCents: v.number(),
    name: v.string(),
    email: v.string(),
  },
  handler: async (ctx, args) => {
    assertPledgeFloor(args.amountCents);
    const name = args.name.trim();
    const email = normalizeEmail(args.email);
    if (!name || !email || !email.includes("@")) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "A name and valid email are required.",
      });
    }
    const chapter = await ctx.db.get(args.chapterId);
    if (!chapter) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That city isn't available for backing.",
      });
    }

    const donorId = await matchOrCreateDonor(ctx, {
      scope: args.chapterId,
      name,
      email,
      source: "manual",
    });
    const pledgeId = await ctx.db.insert("pledges", {
      donorId,
      scope: args.chapterId,
      amountCents: args.amountCents,
      status: "incomplete",
      origin: "stripe",
      createdAt: Date.now(),
    });
    return { pledgeId, amountCents: args.amountCents, chapterName: chapter.name };
  },
});

/**
 * PUBLIC entry point for the become-a-backer flow (no auth — like
 * `createDonationCheckout`). Creates an `incomplete` pledge, then a Stripe
 * Checkout Session in `mode=subscription` with an inline monthly recurring
 * price. `metadata.pledgeId` is set on BOTH the session (for
 * `checkout.session.completed`) and the subscription (`subscription_data`), so
 * every downstream subscription event resolves back to this pledge.
 */
export const startPledgeCheckout = action({
  args: {
    chapterId: v.id("chapters"),
    amountCents: v.number(),
    name: v.string(),
    email: v.string(),
  },
  handler: async (ctx, args): Promise<{ url: string }> => {
    const prepared: {
      pledgeId: Id<"pledges">;
      amountCents: number;
      chapterName: string;
    } = await ctx.runMutation(internal.givingPledges.preparePledge, {
      chapterId: args.chapterId,
      amountCents: args.amountCents,
      name: args.name,
      email: args.email,
    });

    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new ConvexError({
        code: "PAYMENTS_NOT_CONFIGURED",
        message: "Backing isn't available yet — payments are still being set up.",
      });
    }

    // Return to the site with a thank-you state. P3's public city page
    // (`/give/<slug>`) becomes the real return target; the base URL is the
    // interim landing.
    const base = siteUrl();
    const body = new URLSearchParams();
    body.set("mode", "subscription");
    body.set("customer_email", args.email.trim().toLowerCase());
    body.set("success_url", `${base}/?pledge=success`);
    body.set("cancel_url", `${base}/?pledge=canceled`);
    body.set("metadata[pledgeId]", String(prepared.pledgeId));
    // Inline recurring price — one monthly line, unit = the pledge amount.
    body.set("line_items[0][quantity]", "1");
    body.set("line_items[0][price_data][currency]", "usd");
    body.set(
      "line_items[0][price_data][unit_amount]",
      String(prepared.amountCents),
    );
    body.set("line_items[0][price_data][recurring][interval]", "month");
    body.set(
      "line_items[0][price_data][product_data][name]",
      `Monthly backer — ${prepared.chapterName}`,
    );
    // Propagate the pledge id onto the subscription so subscription.* webhooks
    // (which carry no session) can also resolve to this pledge.
    body.set("subscription_data[metadata][pledgeId]", String(prepared.pledgeId));

    const response = await fetch(`${STRIPE_API}/checkout/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!response.ok) {
      console.error("[stripe] pledge session failed:", await response.text());
      throw new ConvexError({
        code: "STRIPE_ERROR",
        message: "Couldn't start backing. Please try again.",
      });
    }
    const session = (await response.json()) as { id: string; url: string };
    return { url: session.url };
  },
});

// ── Webhook handlers (internal, idempotent, wired into /stripe/webhook) ───────

/**
 * Activate a pledge from `checkout.session.completed`, linking the Stripe
 * customer + subscription. Resolves the pledge by the session's
 * `metadata.pledgeId` (via `normalizeId`, so a ticket/donation session — which
 * carries none — is a safe no-op). Idempotent on webhook redelivery.
 */
export const activatePledgeFromCheckout = internalMutation({
  args: {
    pledgeId: v.string(),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    currentPeriodEnd: v.optional(v.number()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const pledgeId = ctx.db.normalizeId("pledges", args.pledgeId);
    if (!pledgeId) return false; // not one of our pledge sessions — safe no-op
    const pledge = await ctx.db.get(pledgeId);
    if (!pledge) return false;
    // Idempotent: a redelivered completion doesn't re-transition or re-count.
    if (pledge.status === "active" && pledge.stripeSubscriptionId) return true;

    await ctx.db.patch(pledgeId, {
      status: "active",
      ...(args.stripeCustomerId
        ? { stripeCustomerId: args.stripeCustomerId }
        : {}),
      ...(args.stripeSubscriptionId
        ? { stripeSubscriptionId: args.stripeSubscriptionId }
        : {}),
      ...(args.currentPeriodEnd ? { currentPeriodEnd: args.currentPeriodEnd } : {}),
      startedAt: pledge.startedAt ?? Date.now(),
    });
    await recomputeChapterBackerCount(ctx, pledge.scope);
    return true;
  },
});

/**
 * Record ONE `gifts` row per paid billing cycle (`invoice.paid`), resolving the
 * pledge by the invoice's subscription id (no-op for a subscription that isn't
 * ours). Idempotent on `stripeInvoiceId` — a redelivered invoice inserts
 * nothing. The amount is read from the invoice's `amount_paid` (never a client
 * value). Bumps the donor + scope CRM rollups via the shared primitive, recovers
 * a `past_due` pledge to `active`, and schedules a receipt email.
 */
export const recordPledgeInvoice = internalMutation({
  args: {
    subscriptionId: v.string(),
    invoiceId: v.string(),
    amountPaidCents: v.number(),
    currentPeriodEnd: v.optional(v.number()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const pledge = await pledgeBySubscription(ctx, args.subscriptionId);
    if (!pledge) return false; // not our subscription — safe no-op

    // Idempotent on the invoice id — exactly one gift per billing cycle.
    const existing = await ctx.db
      .query("gifts")
      .withIndex("by_stripeInvoice", (q) =>
        q.eq("stripeInvoiceId", args.invoiceId),
      )
      .first();
    if (existing) return true;

    // Trust only the invoice's own amount. A zero/negative/non-integer amount
    // (a $0 proration or a malformed payload) records no gift but still no-ops
    // cleanly.
    if (args.amountPaidCents > 0 && Number.isInteger(args.amountPaidCents)) {
      const giftId = await recordGiftForDonor(ctx, {
        donorId: pledge.donorId,
        amountCents: args.amountPaidCents,
        receivedAt: Date.now(),
        method: "stripe",
        pledgeId: pledge._id,
        stripeInvoiceId: args.invoiceId,
        note: "Monthly backer gift",
      });
      await ctx.scheduler.runAfter(
        0,
        internal.ticketingEmails.sendPledgeReceiptEmail,
        { giftId },
      );
    }

    // A paid cycle recovers a past_due pledge and refreshes the period end.
    const patch: Partial<Doc<"pledges">> = {};
    if (pledge.status !== "active" && pledge.status !== "canceled") {
      patch.status = "active";
    }
    if (args.currentPeriodEnd && args.currentPeriodEnd !== pledge.currentPeriodEnd) {
      patch.currentPeriodEnd = args.currentPeriodEnd;
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(pledge._id, patch);
      if (patch.status) await recomputeChapterBackerCount(ctx, pledge.scope);
    }
    return true;
  },
});

/** Move a pledge to `past_due` on `invoice.payment_failed` (Stripe Smart
 *  Retries handles the dunning). No-op for a non-pledge subscription. */
export const markPledgePastDue = internalMutation({
  args: { subscriptionId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const pledge = await pledgeBySubscription(ctx, args.subscriptionId);
    if (!pledge) return false;
    if (pledge.status !== "past_due" && pledge.status !== "canceled") {
      await ctx.db.patch(pledge._id, { status: "past_due" });
      await recomputeChapterBackerCount(ctx, pledge.scope);
    }
    return true;
  },
});

/** Sync a pledge from `customer.subscription.updated`: status (active/past_due/
 *  canceled), current period end, and amount changes. No-op for a non-pledge. */
export const syncPledgeSubscription = internalMutation({
  args: {
    subscriptionId: v.string(),
    stripeStatus: v.string(),
    currentPeriodEnd: v.optional(v.number()),
    amountCents: v.optional(v.number()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const pledge = await pledgeBySubscription(ctx, args.subscriptionId);
    if (!pledge) return false;

    const status = mapStripeSubStatus(args.stripeStatus, pledge.status);
    const patch: Partial<Doc<"pledges">> = {};
    if (status !== pledge.status) patch.status = status;
    if (
      args.currentPeriodEnd &&
      args.currentPeriodEnd !== pledge.currentPeriodEnd
    ) {
      patch.currentPeriodEnd = args.currentPeriodEnd;
    }
    if (
      args.amountCents &&
      Number.isInteger(args.amountCents) &&
      args.amountCents !== pledge.amountCents
    ) {
      patch.amountCents = args.amountCents;
    }
    if (status === "canceled" && !pledge.canceledAt) {
      patch.canceledAt = Date.now();
    }
    if (Object.keys(patch).length === 0) return true;

    await ctx.db.patch(pledge._id, patch);
    // A status or amount change can move a backer in/out of the derived count.
    if (patch.status !== undefined || patch.amountCents !== undefined) {
      await recomputeChapterBackerCount(ctx, pledge.scope);
    }
    return true;
  },
});

/** Cancel a pledge on `customer.subscription.deleted`. No-op for a non-pledge. */
export const cancelPledgeSubscription = internalMutation({
  args: { subscriptionId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const pledge = await pledgeBySubscription(ctx, args.subscriptionId);
    if (!pledge) return false;
    if (pledge.status !== "canceled") {
      await ctx.db.patch(pledge._id, {
        status: "canceled",
        canceledAt: Date.now(),
      });
      await recomputeChapterBackerCount(ctx, pledge.scope);
    }
    return true;
  },
});

// ── Self-serve management (Stripe billing portal) ─────────────────────────────

/** Resolve the Stripe customer id behind a donor's pledge in a chapter, by
 *  email. Prefers an `active` pledge's customer, else any pledge that has one. */
export const portalCustomerId = internalQuery({
  args: { email: v.string(), chapterId: v.id("chapters") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    if (!email) return null;
    const donor = await ctx.db
      .query("donors")
      .withIndex("by_scope_and_email", (q) =>
        q.eq("scope", args.chapterId).eq("email", email),
      )
      .first();
    if (!donor) return null;
    const pledges = await ctx.db
      .query("pledges")
      .withIndex("by_donor", (q) => q.eq("donorId", donor._id))
      .take(DONOR_PLEDGE_LIMIT);
    const chosen =
      pledges.find((p) => p.status === "active" && p.stripeCustomerId) ??
      pledges.find((p) => p.stripeCustomerId);
    return chosen?.stripeCustomerId ?? null;
  },
});

/**
 * PUBLIC self-serve management (no auth — email lookup, like the donation flow):
 * open a Stripe billing portal session so a backer can update their card, change
 * the amount, or cancel — we never store card data or build a card UI. Returns a
 * typed error the UI can show when no Stripe customer is on file.
 */
export const createPortalSession = action({
  args: { email: v.string(), chapterId: v.id("chapters") },
  handler: async (ctx, args): Promise<{ url: string }> => {
    const customerId: string | null = await ctx.runQuery(
      internal.givingPledges.portalCustomerId,
      { email: args.email, chapterId: args.chapterId },
    );
    if (!customerId) {
      throw new ConvexError({
        code: "NO_STRIPE_CUSTOMER",
        message:
          "We couldn't find a backing subscription for that email in this city.",
      });
    }
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new ConvexError({
        code: "PAYMENTS_NOT_CONFIGURED",
        message: "Backing management isn't available yet.",
      });
    }
    const body = new URLSearchParams();
    body.set("customer", customerId);
    body.set("return_url", `${siteUrl()}/`);
    const response = await fetch(`${STRIPE_API}/billing_portal/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!response.ok) {
      console.error("[stripe] portal session failed:", await response.text());
      throw new ConvexError({
        code: "STRIPE_ERROR",
        message: "Couldn't open the billing portal. Please try again.",
      });
    }
    const session = (await response.json()) as { url: string };
    return { url: session.url };
  },
});

// ── Admin reads (gated) ───────────────────────────────────────────────────────

/** Enrich a pledge row with its donor's name/email for list rendering. */
async function withDonor(ctx: QueryCtx, pledge: Doc<"pledges">) {
  const donor = await ctx.db.get(pledge.donorId);
  return {
    ...pledge,
    donorName: donor?.name ?? "Unknown",
    donorEmail: donor?.email ?? null,
  };
}

/** The scope's pledges (optionally one status), newest first — the Backers
 *  desk list. Gated by `requireGivingView` at the scope. */
export const listPledges = query({
  args: { scope: scopeValidator, status: v.optional(pledgeStatusValidator) },
  handler: async (ctx, { scope, status }) => {
    await requireGivingView(ctx, scope as GivingScope);
    const rows = status
      ? await ctx.db
          .query("pledges")
          .withIndex("by_scope_and_status", (q) =>
            q.eq("scope", scope).eq("status", status),
          )
          .order("desc")
          .take(PLEDGE_LIST_LIMIT)
      : await ctx.db
          .query("pledges")
          .withIndex("by_scope_and_status", (q) => q.eq("scope", scope))
          .order("desc")
          .take(PLEDGE_LIST_LIMIT);
    return await Promise.all(rows.map((p) => withDonor(ctx, p)));
  },
});

/** A donor's pledges (for the donor detail screen). Gated by the donor's scope. */
export const getDonorPledges = query({
  args: { donorId: v.id("donors") },
  handler: async (ctx, { donorId }) => {
    const donor = await ctx.db.get(donorId);
    if (!donor) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Donor not found." });
    }
    await requireGivingView(ctx, donor.scope);
    return await ctx.db
      .query("pledges")
      .withIndex("by_donor", (q) => q.eq("donorId", donorId))
      .order("desc")
      .take(DONOR_PLEDGE_LIMIT);
  },
});

// ── Givebutter recurring import (cutover tooling) ─────────────────────────────

/**
 * Import Givebutter recurring donors as pledge-shaped rows (PRD §2 cutover):
 * match-or-create the donor, then insert an `origin:"imported"` pledge. These
 * land as `past_due` — the Givebutter card CANNOT be ported (it lives in
 * Givebutter's Stripe), so the pledge is real but NOT collecting on our rails
 * yet; it's awaiting the donor's personal re-signup. `past_due` (not `active`)
 * keeps imported rows OUT of the derived backer count until re-signed, which is
 * the honest state during the cutover window. Dedup is on `externalRef` (the
 * Givebutter recurrence id) within the donor's own pledges, so a re-run is safe.
 * Admin-gated (`giving.manage` at `scope`).
 */
export const importGivebutterRecurring = mutation({
  args: {
    scope: scopeValidator,
    rows: v.array(
      v.object({
        email: v.optional(v.string()),
        name: v.string(),
        amountCents: v.number(),
        externalRef: v.string(),
      }),
    ),
  },
  returns: v.object({ imported: v.number(), skipped: v.number() }),
  handler: async (ctx, { scope, rows }) => {
    await requireGivingManage(ctx, scope as GivingScope);
    let imported = 0;
    let skipped = 0;
    for (const row of rows.slice(0, IMPORT_LIMIT)) {
      if (!Number.isInteger(row.amountCents) || row.amountCents < PLEDGE_FLOOR_CENTS) {
        skipped++; // a malformed amount never blocks the rest of the import
        continue;
      }
      const donorId = await matchOrCreateDonor(ctx, {
        scope: scope as GivingScope,
        name: row.name,
        email: row.email,
        source: "givebutter-import",
      });
      // Dedup on externalRef within this donor's pledges (a bounded scan — a
      // donor holds very few pledges).
      const donorPledges = await ctx.db
        .query("pledges")
        .withIndex("by_donor", (q) => q.eq("donorId", donorId))
        .take(DONOR_PLEDGE_LIMIT);
      if (donorPledges.some((p) => p.externalRef === row.externalRef)) {
        skipped++;
        continue;
      }
      await ctx.db.insert("pledges", {
        donorId,
        scope: scope as GivingScope,
        amountCents: row.amountCents,
        status: "past_due",
        origin: "imported",
        externalRef: row.externalRef,
        createdAt: Date.now(),
      });
      imported++;
    }
    return { imported, skipped };
  },
});

// ── Receipt payload ───────────────────────────────────────────────────────────

/** Receipt-email payload for a paid backer cycle (read by
 *  `ticketingEmails.sendPledgeReceiptEmail`). */
export const getPledgeReceiptPayload = internalQuery({
  args: { giftId: v.id("gifts") },
  returns: v.union(
    v.object({
      email: v.string(),
      name: v.string(),
      amountCents: v.number(),
      chapterName: v.union(v.string(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, { giftId }) => {
    const gift = await ctx.db.get(giftId);
    if (!gift) return null;
    const donor = await ctx.db.get(gift.donorId);
    if (!donor || !donor.email) return null;
    let chapterName: string | null = null;
    if (gift.scope !== "central") {
      const chapter = await ctx.db.get(gift.scope);
      chapterName = chapter?.name ?? null;
    }
    return {
      email: donor.email,
      name: donor.name,
      amountCents: gift.amountCents,
      chapterName,
    };
  },
});
