/**
 * REFUNDS FROM THE SALES PAGE — giving a ticket buyer their money back, and
 * reissuing the refund when an attempt didn't go through.
 *
 * Before this, nothing in the app could send a refund: a refund meant opening
 * the Stripe dashboard, and the order here stayed `paid` with live tickets and
 * its money still counted as revenue. Now the Sales row's detail panel issues
 * it, and the order, its tickets and every revenue total move with it.
 *
 * ── SCOPE: STRIPE TICKET ORDERS ─────────────────────────────────────────────
 * Only a `ticketOrders` row with a `stripePaymentIntentId` can be refunded
 * here. That is the rail the app itself charges, and `ticketOrders.status`
 * already has a `refunded` state that every revenue sum (accounts, public
 * ledger, this page) honours. An in-person tap (`sales`) has no refunded state
 * — adding one means touching each of the sums over that table — and a
 * Givebutter or hand-entered order never went through our Stripe account at
 * all. Both still refund in their own tools.
 *
 * ── THE SHAPE OF ONE REFUND ─────────────────────────────────────────────────
 *  1. `beginTicketRefund` (mutation) checks the power and the order, and writes
 *     a `saleRefunds` row in `requested` BEFORE any money moves.
 *  2. The action asks Stripe for the refund, keyed on that row's id as the
 *     Idempotency-Key — so a retry of the same attempt can never refund twice.
 *  3. `settleRefund` (mutation) records Stripe's answer. Accepted (`pending` /
 *     `succeeded`): the order goes `refunded`, its tickets go void, and the
 *     event's sold/revenue counters come down. Refused (`failed` / `canceled`):
 *     nothing changes, or — if Stripe later reports an accepted refund failed —
 *     exactly what step 3 did is put back.
 *
 * A row stuck in `requested` (the call never came back) or `pending` (Stripe
 * hasn't finished) is resolved by `checkRefund`, which re-sends the same
 * idempotent request or reads the refund back. A failed or canceled attempt
 * leaves the order `paid`, and the Sales page then offers "Reissue refund",
 * which is simply a new attempt.
 *
 * Refunds only the ticket subtotal (`totalCents`). An add-on gift in the same
 * charge is giving, not a sale, and stays a gift.
 */
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUserId } from "./lib/context";
import { requireFinanceRole } from "./lib/finance";
import { requireSaleRefund } from "./lib/salesRefundAccess";

const STRIPE_API = "https://api.stripe.com/v1";
const REASON_MAX = 500;

const refundStatus = v.union(
  v.literal("requested"),
  v.literal("pending"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("canceled"),
);
type RefundStatus = Doc<"saleRefunds">["status"];

/** Stripe accepted it, so the money is (or will be) back with the buyer. */
export function refundIsLive(status: RefundStatus): boolean {
  return status === "pending" || status === "succeeded";
}

/** An attempt that still blocks a new one: in flight, or already done. */
function refundBlocksNew(status: RefundStatus): boolean {
  return status === "requested" || refundIsLive(status);
}

/** The newest attempt for an order, or null. */
async function latestAttempt(
  ctx: MutationCtx,
  orderId: Id<"ticketOrders">,
): Promise<Doc<"saleRefunds"> | null> {
  const rows = await ctx.db
    .query("saleRefunds")
    .withIndex("by_order", (q) => q.eq("ticketOrderId", orderId))
    .order("desc")
    .take(1);
  return rows[0] ?? null;
}

// ── Effects on the order ─────────────────────────────────────────────────────

/**
 * Take a refunded order off the books: order → `refunded`, its live tickets →
 * void, and the counters `ticketing.ts#fulfill` raised come back down.
 * Idempotent via `effectsApplied`.
 *
 * `updatedAt` is deliberately left alone — the Sales page dates a ticket sale
 * by it, and a refund shouldn't move the sale to the day it was refunded.
 */
async function applyRefundEffects(ctx: MutationCtx, refund: Doc<"saleRefunds">) {
  if (refund.effectsApplied) return;
  const order = await ctx.db.get(refund.ticketOrderId);
  if (!order) return;

  const tickets = await ctx.db
    .query("tickets")
    .withIndex("by_order", (q) => q.eq("orderId", order._id))
    .take(200);
  const voided: Id<"tickets">[] = [];
  const perType = new Map<Id<"ticketTypes">, number>();
  for (const t of tickets) {
    if (t.status === "void") continue;
    await ctx.db.patch(t._id, { status: "void" });
    voided.push(t._id);
    perType.set(t.ticketTypeId, (perType.get(t.ticketTypeId) ?? 0) + 1);
  }
  await bumpCounters(ctx, order, perType, voided.length, -1);

  await ctx.db.patch(order._id, { status: "refunded" });
  await ctx.db.patch(refund._id, {
    effectsApplied: true,
    voidedTicketIds: voided,
    updatedAt: Date.now(),
  });
}

/** Undo `applyRefundEffects` — Stripe reported an accepted refund failed. */
async function revertRefundEffects(ctx: MutationCtx, refund: Doc<"saleRefunds">) {
  if (!refund.effectsApplied) return;
  const order = await ctx.db.get(refund.ticketOrderId);
  if (!order) return;

  const perType = new Map<Id<"ticketTypes">, number>();
  let restored = 0;
  for (const id of refund.voidedTicketIds) {
    const t = await ctx.db.get(id);
    // Only revive what THIS refund voided and nothing has touched since.
    if (!t || t.status !== "void") continue;
    await ctx.db.patch(id, { status: "valid" });
    restored++;
    perType.set(t.ticketTypeId, (perType.get(t.ticketTypeId) ?? 0) + 1);
  }
  await bumpCounters(ctx, order, perType, restored, 1);

  if (order.status === "refunded") {
    await ctx.db.patch(order._id, { status: "paid" });
  }
  await ctx.db.patch(refund._id, { effectsApplied: false, updatedAt: Date.now() });
}

/** Move the ticket-type and event-page rollups by `sign` (−1 refund, +1 undo). */
async function bumpCounters(
  ctx: MutationCtx,
  order: Doc<"ticketOrders">,
  perType: Map<Id<"ticketTypes">, number>,
  ticketCount: number,
  sign: 1 | -1,
) {
  for (const [typeId, n] of perType) {
    const tt = await ctx.db.get(typeId);
    if (tt) {
      await ctx.db.patch(typeId, { soldCount: Math.max(0, tt.soldCount + sign * n) });
    }
  }
  const page = await ctx.db
    .query("eventPages")
    .withIndex("by_event", (q) => q.eq("eventId", order.eventId))
    .unique();
  if (page) {
    await ctx.db.patch(page._id, {
      ticketsSoldCount: Math.max(0, page.ticketsSoldCount + sign * ticketCount),
      revenueCents: Math.max(0, page.revenueCents + sign * order.totalCents),
    });
  }
}

// ── Mutations the action drives ──────────────────────────────────────────────

/**
 * Check the caller and the order, and write the attempt row. Runs with the
 * action's caller identity, so `requireSaleRefund` sees the real user.
 */
export const beginTicketRefund = internalMutation({
  args: {
    orderId: v.id("ticketOrders"),
    reason: v.optional(v.string()),
  },
  returns: v.object({
    refundId: v.id("saleRefunds"),
    paymentIntentId: v.string(),
    amountCents: v.number(),
  }),
  handler: async (ctx, { orderId, reason }) => {
    const order = await ctx.db.get(orderId);
    if (!order) {
      throw new ConvexError({ code: "NOT_FOUND", message: "That order no longer exists." });
    }
    const access = await requireSaleRefund(ctx, order.chapterId);
    const userId = (await requireUserId(ctx)) as Id<"users">;

    if (!order.stripePaymentIntentId) {
      throw new ConvexError({
        code: "NOT_REFUNDABLE",
        message:
          "This order wasn't paid through our Stripe checkout, so it has to be refunded where it was paid.",
      });
    }
    if (order.status !== "paid") {
      throw new ConvexError({
        code: "NOT_REFUNDABLE",
        message: `This order is ${order.status}, so there's nothing to refund.`,
      });
    }
    if (order.totalCents <= 0) {
      throw new ConvexError({ code: "NOT_REFUNDABLE", message: "This order was free." });
    }
    const last = await latestAttempt(ctx, orderId);
    if (last && refundBlocksNew(last.status)) {
      throw new ConvexError({
        code: "ALREADY_REFUNDING",
        message:
          last.status === "requested"
            ? "A refund for this order is already on its way to Stripe. Use Check with Stripe instead."
            : "This order has already been refunded.",
      });
    }

    const trimmed = reason?.trim().slice(0, REASON_MAX);
    const now = Date.now();
    const refundId = await ctx.db.insert("saleRefunds", {
      chapterId: order.chapterId,
      ticketOrderId: orderId,
      amountCents: order.totalCents,
      ...(trimmed ? { reason: trimmed } : {}),
      status: "requested",
      voidedTicketIds: [],
      effectsApplied: false,
      requestedByUserId: userId,
      ...(access.personId ? { requestedByPersonId: access.personId } : {}),
      createdAt: now,
      updatedAt: now,
    });
    return {
      refundId,
      paymentIntentId: order.stripePaymentIntentId,
      amountCents: order.totalCents,
    };
  },
});

/** Record Stripe's answer and move the order to match it. */
export const settleRefund = internalMutation({
  args: {
    refundId: v.id("saleRefunds"),
    status: refundStatus,
    stripeRefundId: v.optional(v.string()),
    failureReason: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { refundId, status, stripeRefundId, failureReason }) => {
    const refund = await ctx.db.get(refundId);
    if (!refund) return null;
    await ctx.db.patch(refundId, {
      status,
      ...(stripeRefundId ? { stripeRefundId } : {}),
      ...(failureReason ? { failureReason: failureReason.slice(0, REASON_MAX) } : {}),
      updatedAt: Date.now(),
    });
    const fresh = (await ctx.db.get(refundId))!;
    if (refundIsLive(status)) await applyRefundEffects(ctx, fresh);
    else if (status === "failed" || status === "canceled") {
      await revertRefundEffects(ctx, fresh);
    }
    return null;
  },
});

/** What `checkRefund` needs, after checking the caller may act on it. */
export const refundForCheck = internalQuery({
  args: { refundId: v.id("saleRefunds") },
  returns: v.object({
    status: refundStatus,
    stripeRefundId: v.union(v.string(), v.null()),
    paymentIntentId: v.union(v.string(), v.null()),
    amountCents: v.number(),
  }),
  handler: async (ctx, { refundId }) => {
    const refund = await ctx.db.get(refundId);
    if (!refund) {
      throw new ConvexError({ code: "NOT_FOUND", message: "That refund no longer exists." });
    }
    await requireSaleRefund(ctx, refund.chapterId);
    const order = await ctx.db.get(refund.ticketOrderId);
    return {
      status: refund.status,
      stripeRefundId: refund.stripeRefundId ?? null,
      paymentIntentId: order?.stripePaymentIntentId ?? null,
      amountCents: refund.amountCents,
    };
  },
});

// ── Talking to Stripe ────────────────────────────────────────────────────────

type StripeOutcome = {
  status: RefundStatus;
  stripeRefundId?: string;
  failureReason?: string;
};

function stripeKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new ConvexError({
      code: "PAYMENTS_NOT_CONFIGURED",
      message: "Stripe isn't configured on this deployment, so no refund was sent.",
    });
  }
  return key;
}

/** Map Stripe's refund status onto ours. Anything unknown stays `pending`. */
function mapStatus(s: string | undefined): RefundStatus {
  if (s === "succeeded" || s === "failed" || s === "canceled") return s;
  return "pending";
}

/**
 * Create the refund. Same `refundId` → same Idempotency-Key, so re-sending an
 * attempt whose answer was lost returns Stripe's original answer instead of
 * refunding again.
 */
async function createStripeRefund(
  refundId: Id<"saleRefunds">,
  paymentIntentId: string,
  amountCents: number,
): Promise<StripeOutcome> {
  const body = new URLSearchParams({
    payment_intent: paymentIntentId,
    amount: String(amountCents),
    reason: "requested_by_customer",
    "metadata[saleRefundId]": refundId,
  });
  const res = await fetch(`${STRIPE_API}/refunds`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeKey()}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": `sale-refund-${refundId}`,
    },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as {
    id?: string;
    status?: string;
    failure_reason?: string;
    error?: { message?: string };
  };
  if (!res.ok) {
    return {
      status: "failed",
      failureReason: json.error?.message ?? `Stripe answered ${res.status}.`,
    };
  }
  return {
    status: mapStatus(json.status),
    ...(json.id ? { stripeRefundId: json.id } : {}),
    ...(json.failure_reason ? { failureReason: json.failure_reason } : {}),
  };
}

async function readStripeRefund(stripeRefundId: string): Promise<StripeOutcome | null> {
  const res = await fetch(`${STRIPE_API}/refunds/${encodeURIComponent(stripeRefundId)}`, {
    headers: { Authorization: `Bearer ${stripeKey()}` },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { id?: string; status?: string; failure_reason?: string };
  return {
    status: mapStatus(json.status),
    stripeRefundId,
    ...(json.failure_reason ? { failureReason: json.failure_reason } : {}),
  };
}

const outcomeValidator = v.object({
  status: refundStatus,
  message: v.union(v.string(), v.null()),
});

/**
 * Refund a ticket order — and, called again after a failed attempt, reissue it.
 * Gated by `requireSaleRefund` (inside `beginTicketRefund`).
 */
export const refundTicketOrder = action({
  args: {
    orderId: v.id("ticketOrders"),
    reason: v.optional(v.string()),
  },
  returns: outcomeValidator,
  handler: async (ctx, { orderId, reason }) => {
    stripeKey(); // refuse before writing anything if Stripe isn't set up
    const begun: {
      refundId: Id<"saleRefunds">;
      paymentIntentId: string;
      amountCents: number;
    } = await ctx.runMutation(internal.saleRefunds.beginTicketRefund, { orderId, reason });

    let outcome: StripeOutcome;
    try {
      outcome = await createStripeRefund(begun.refundId, begun.paymentIntentId, begun.amountCents);
    } catch (e) {
      // The request may or may not have reached Stripe. Leave it `requested`:
      // `checkRefund` re-sends it under the same idempotency key, which is the
      // only safe way to find out.
      return {
        status: "requested" as const,
        message: `We couldn't reach Stripe (${e instanceof Error ? e.message : "network error"}). Use Check with Stripe to finish it.`,
      };
    }
    await ctx.runMutation(internal.saleRefunds.settleRefund, {
      refundId: begun.refundId,
      ...outcome,
    });
    return { status: outcome.status, message: outcome.failureReason ?? null };
  },
});

/** Resolve an attempt stuck in `requested` or `pending`. */
export const checkRefund = action({
  args: { refundId: v.id("saleRefunds") },
  returns: outcomeValidator,
  handler: async (ctx, { refundId }) => {
    const r: {
      status: RefundStatus;
      stripeRefundId: string | null;
      paymentIntentId: string | null;
      amountCents: number;
    } = await ctx.runQuery(internal.saleRefunds.refundForCheck, { refundId });

    let outcome: StripeOutcome | null = null;
    if (r.status === "requested" && r.paymentIntentId) {
      outcome = await createStripeRefund(refundId, r.paymentIntentId, r.amountCents);
    } else if (r.stripeRefundId) {
      outcome = await readStripeRefund(r.stripeRefundId);
    }
    if (!outcome) return { status: r.status, message: "Stripe had nothing new to say." };
    await ctx.runMutation(internal.saleRefunds.settleRefund, { refundId, ...outcome });
    return { status: outcome.status, message: outcome.failureReason ?? null };
  },
});

// ── Read ─────────────────────────────────────────────────────────────────────

/** Every refund attempt for one order, newest first — the detail panel's history. */
export const refundHistory = query({
  args: { orderId: v.id("ticketOrders") },
  returns: v.array(
    v.object({
      id: v.id("saleRefunds"),
      status: refundStatus,
      amountCents: v.number(),
      reason: v.union(v.string(), v.null()),
      failureReason: v.union(v.string(), v.null()),
      requestedByName: v.union(v.string(), v.null()),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, { orderId }) => {
    const order = await ctx.db.get(orderId);
    if (!order) return [];
    await requireFinanceRole(ctx, order.chapterId, "bookkeeper");
    const rows = await ctx.db
      .query("saleRefunds")
      .withIndex("by_order", (q) => q.eq("ticketOrderId", orderId))
      .order("desc")
      .take(50);
    const out = [];
    for (const r of rows) {
      const person = r.requestedByPersonId ? await ctx.db.get(r.requestedByPersonId) : null;
      out.push({
        id: r._id,
        status: r.status,
        amountCents: r.amountCents,
        reason: r.reason ?? null,
        failureReason: r.failureReason ?? null,
        requestedByName: person?.name ?? null,
        createdAt: r.createdAt,
      });
    }
    return out;
  },
});
