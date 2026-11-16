import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * One attempt to give a ticket buyer their money back, issued from the Sales
 * page (`saleRefunds.ts`).
 *
 * A row per ATTEMPT, never one per order, because a refund can fail (a closed
 * card, a Stripe error, a network drop between us and Stripe) and the person
 * at the desk then reissues it. The failed attempt is kept — "we tried on the
 * 12th and the bank refused it" is exactly what a treasurer needs when the
 * buyer writes in asking where their money is.
 *
 * Status mirrors Stripe's refund status, plus `requested` for the moment
 * between our row being written and Stripe answering:
 *  - `requested` — written, Stripe not yet answered. A row stuck here means the
 *    call never returned; "Check with Stripe" resolves it, and the Stripe
 *    idempotency key (this row's id) means a retry can never pay out twice.
 *  - `pending` / `succeeded` — Stripe accepted it. The order is `refunded`, its
 *    tickets are void, and it has left every revenue total.
 *  - `failed` / `canceled` — no money went back. The order is (or is put back)
 *    `paid` with its tickets restored, and the Sales page offers a reissue.
 */
export const saleRefunds = defineTable({
  chapterId: v.id("chapters"),
  ticketOrderId: v.id("ticketOrders"),
  /** The ticket subtotal only — an add-on gift in the same charge is giving,
   *  not a sale, and is never refunded from here. */
  amountCents: v.number(),
  /** What the person at the desk wrote, shown in the row's history. */
  reason: v.optional(v.string()),
  status: v.union(
    v.literal("requested"),
    v.literal("pending"),
    v.literal("succeeded"),
    v.literal("failed"),
    v.literal("canceled"),
  ),
  stripeRefundId: v.optional(v.string()),
  /** Stripe's own words when it refused, or our error when the call failed. */
  failureReason: v.optional(v.string()),
  /** Tickets this refund voided — exactly the set put back if it fails, so a
   *  ticket voided for some other reason is never revived by a failed refund. */
  voidedTicketIds: v.array(v.id("tickets")),
  /** Whether the order's revenue/ticket counters are currently taken down for
   *  this refund. Makes applying and un-applying the effects idempotent. */
  effectsApplied: v.boolean(),
  requestedByUserId: v.id("users"),
  requestedByPersonId: v.optional(v.id("people")),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_order", ["ticketOrderId"])
  .index("by_chapter", ["chapterId"]);
