/**
 * ACH giving that is in flight — authorised by the donor, not yet moved by the
 * bank.
 *
 * Two mutations and nothing else: one writes a `pendingGifts` row, one deletes
 * it. Both are called ONLY from the Stripe webhook (`http.ts`), both key on the
 * Checkout Session id, and both are idempotent because Stripe delivers at least
 * once. See `schema/givingPlatform.ts#pendingGifts` for why this table exists,
 * why it is not `donations` / `ticketOrders` / `givingActivity`, and why a
 * resolved row is deleted rather than flipped to a status.
 *
 * ── THE ONE RULE THIS FILE MUST NOT BREAK ──────────────────────────────────
 * NOTHING HERE MAY TOUCH `gifts`, `transactions`, `donors` ROLLUPS, OR ANY
 * SCOPE ROLLUP. Book value is `Σ gifts.amountCents + Σ signedBookCents(ledger)`
 * (see `lib/bookBalance.ts`, `reconciliation.ts#computeBookBalances`), and the
 * org's book-vs-bank gap closed to exactly $0.00 on that basis. Pending ACH is
 * not money yet; a single write into either of those tables from here would
 * reopen a reconciliation that took months to close. The whole design is that
 * this table is invisible to every reader except the giving digest.
 *
 * ── WHY THE WRITE HAPPENS WHERE IT DOES ────────────────────────────────────
 * At `checkout.session.completed` with an unsettled `payment_status` — later
 * than checkout-start, earlier than settlement. Both bounds are load-bearing:
 *
 *  · LATER than checkout-start, so an abandoned checkout is never counted.
 *    `donations` and `ticketOrders` both insert their pending row when the
 *    session is CREATED, which is why neither could serve as the source: most
 *    of their pending rows are people who closed the tab, and a digest that
 *    reported those would announce giving nobody ever authorised.
 *  · EARLIER than settlement, which is the entire point — after settlement
 *    there is a `gifts` row and nothing to report here.
 *
 * ── NO SWEEPER, DELIBERATELY ───────────────────────────────────────────────
 * If Stripe never sent the resolving event, a row would sit here forever. That
 * is survivable without a cron because the digest windows pending money on
 * `submittedAt`: a stranded row is reported in exactly one digest — the one
 * covering the day it was authorised — and is invisible to every window after
 * it. A stale row is a stale row, not a recurring lie.
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { splitIntendedGift } from "./lib/givingDonors";

/**
 * Record an ACH debit as in flight, if this session carries giving we can
 * price.
 *
 * ── THE THREE SHAPES, AND THE ONE DELIBERATELY LEFT OUT ────────────────────
 * A delayed-settlement session can be any of four things. Three of them hold a
 * one-time giving amount and are recorded here, in the same order the settle
 * fan-out (`http.ts#settleCheckoutSession`) resolves them so the two can't
 * disagree about what a session was:
 *
 *  1. A `/give` one-time gift — `metadata.giveDonation === "1"`. The donor row
 *     already exists (`prepareGiveDonation` match-or-creates it before the
 *     session), which is where the scope and the name come from.
 *  2. An event-page donation — its `donations` row, found by session id.
 *  3. A ticket order carrying a bundled add-on gift — only the `donationCents`
 *     part. The TICKETS are not giving (they settle into `ticketOrders`
 *     revenue, never into `gifts`), so an in-flight ticket order contributes
 *     only its upsell to the giving digest, or nothing at all.
 *
 * NOT recorded: a BACKER (subscription) checkout. Its session has no gift
 * amount to record — `amount_total` on a subscription session is $0 or a
 * proration — and the money that becomes a gift arrives later as its own
 * `invoice.paid`, which is a different event on a different object. Recording
 * a guess here would put a number in a digest that no gift ever matches.
 *
 * Every branch NO-OPS QUIETLY when its preconditions aren't met. A webhook's
 * job is to answer 200; a missing donor or a malformed amount must cost a
 * digest line, never the payment.
 */
export const recordPendingGift = internalMutation({
  args: {
    sessionId: v.string(),
    /** The session's own `amount_total` — the CHARGE, fee coverage included. */
    amountTotalCents: v.number(),
    /** `metadata.giveDonation === "1"` — this is a `/give` one-time gift. */
    isGiveDonation: v.optional(v.boolean()),
    /** `metadata.giveDonorId`. A raw string from Stripe: normalized, never trusted. */
    giveDonorId: v.optional(v.string()),
    /** `metadata.giveIntendedCents` — what they meant to give, when they also
     *  covered the processing fees. See `splitIntendedGift`. */
    giveIntendedCents: v.optional(v.number()),
    /** When the donor authorised the debit. Injectable so the digest's window
     *  boundaries are testable; production passes the webhook's instant. */
    submittedAt: v.optional(v.number()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const now = args.submittedAt ?? Date.now();

    // Stripe delivers at least once, and a redelivered completion must not
    // double the pending figure.
    const existing = await ctx.db
      .query("pendingGifts")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .unique();
    if (existing) return false;

    // A total that isn't a sane positive integer is a malformed payload. Record
    // nothing rather than a nonsense figure — the settle path applies the same
    // guard before it books a gift.
    if (
      !Number.isInteger(args.amountTotalCents) ||
      args.amountTotalCents <= 0
    ) {
      return false;
    }

    // ── 1. A `/give` one-time gift ────────────────────────────────────────
    if (args.isGiveDonation) {
      const donorId = ctx.db.normalizeId("donors", args.giveDonorId ?? "");
      if (!donorId) return false; // not one of our donor ids — safe no-op
      const donor = await ctx.db.get(donorId);
      if (!donor) return false; // donor since deleted — safe no-op

      // The PENDING FIGURE IS THE GIFT, NOT THE CHARGE — the same split the
      // settle path books, so the figure a digest reports as "still clearing"
      // is the figure that later appears as a gift. Reporting the charge would
      // make the pending line and the settled gift disagree by the fee
      // coverage, every time a donor ticked the box.
      const { giftCents } = splitIntendedGift(
        args.amountTotalCents,
        args.giveIntendedCents,
      );
      await ctx.db.insert("pendingGifts", {
        sessionId: args.sessionId,
        scope: donor.scope,
        amountCents: giftCents,
        currency: "usd",
        submittedAt: now,
        donorName: donor.name,
        donorId,
        createdAt: now,
      });
      return true;
    }

    // ── 2. An event-page donation ─────────────────────────────────────────
    const donation = await ctx.db
      .query("donations")
      .withIndex("by_stripe_session", (q) =>
        q.eq("stripeCheckoutSessionId", args.sessionId),
      )
      .unique();
    if (donation) {
      // `pending` ONLY. A row already `paid`/`expired` has been resolved by
      // some other path and there is nothing in flight to announce.
      if (donation.status !== "pending" || donation.amountCents <= 0) {
        return false;
      }
      await ctx.db.insert("pendingGifts", {
        sessionId: args.sessionId,
        scope: donation.chapterId,
        amountCents: donation.amountCents,
        currency: donation.currency,
        submittedAt: now,
        donorName: donation.name,
        // `donationId` AND `eventId`, exactly as the settled gift will carry
        // them — `giftType` buckets on either, and the digest's type cut has to
        // put the pending row and the gift it becomes in the same bucket.
        eventId: donation.eventId,
        donationId: donation._id,
        createdAt: now,
      });
      return true;
    }

    // ── 3. A ticket order's bundled add-on gift ───────────────────────────
    const order = await ctx.db
      .query("ticketOrders")
      .withIndex("by_stripe_session", (q) =>
        q.eq("stripeCheckoutSessionId", args.sessionId),
      )
      .unique();
    const addOnCents = order?.donationCents ?? 0;
    if (order && order.status === "pending" && addOnCents > 0) {
      await ctx.db.insert("pendingGifts", {
        sessionId: args.sessionId,
        scope: order.chapterId,
        // ONLY the upsell. `order.totalCents` is ticket revenue, which never
        // becomes a gift and has no business in a giving digest.
        amountCents: addOnCents,
        currency: order.currency,
        submittedAt: now,
        donorName: order.name,
        eventId: order.eventId,
        createdAt: now,
      });
      return true;
    }

    // A backer signup, a repayment, a tickets-only order — nothing giving in
    // flight that this session can price.
    return false;
  },
});

/**
 * The debit resolved, one way or the other — drop the pending row.
 *
 * ONE mutation for both outcomes, called from `settleCheckoutSession` (it
 * cleared — the `gifts` row now carries it) and `cancelCheckoutSession` (the
 * bank refused it, or the donor walked away). They mean opposite things about
 * the money and exactly the same thing about this table: it is no longer in
 * flight. A cleared debit and a returned one leaving different residue here is
 * how a phantom gets built.
 *
 * Requirement #4 of the brief lands entirely on this function: after a failure
 * the amount must be gone from FUTURE digests. It is — the row is deleted. A
 * digest already mailed announcing it is water under the bridge and is
 * deliberately not corrected; the pending line says out loud that a bank can
 * still refuse the money.
 */
export const resolvePendingGift = internalMutation({
  args: { sessionId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { sessionId }) => {
    const row = await ctx.db
      .query("pendingGifts")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .unique();
    // No row is the NORMAL case: every card checkout in the system reaches
    // here, and none of them was ever pending.
    if (!row) return false;
    await ctx.db.delete(row._id);
    return true;
  },
});
