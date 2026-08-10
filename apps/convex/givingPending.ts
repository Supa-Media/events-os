/**
 * ACH giving that is in flight — authorised by the donor, not yet moved by the
 * bank.
 *
 * Two mutations and nothing else: one writes a `pendingGifts` row, one deletes
 * it. Both are called ONLY from the Stripe webhook (`http.ts`) and both key on
 * the Checkout Session id. See `schema/givingPlatform.ts#pendingGifts` for why
 * this table exists, why it is not `donations` / `ticketOrders` /
 * `givingActivity`, and why a resolved row is deleted rather than flipped to a
 * status.
 *
 * ── IDEMPOTENCY TAKES TWO KEYS, NOT ONE ────────────────────────────────────
 * Stripe delivers at least once and in no guaranteed order, so both mutations
 * are reached twice. `resolvePendingGift` is trivially safe (deleting a row
 * that isn't there is a no-op). `recordPendingGift` is NOT safe on the session
 * id alone, and assuming it was is the one real bug this file has shipped:
 * because a resolved row is DELETED, `by_session` cannot see a debit that has
 * ALREADY CLEARED, so a redelivered or out-of-order `completed` re-created a
 * pending row that no later event would ever resolve. Each branch therefore
 * checks a key that OUTLIVES resolution as well — for `/give` that is the
 * settled gift's `externalRef`; for the other two, the source row's status.
 * See the branch comments.
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
 * ── A STRANDED ROW IS BOUNDED IN TIME, NOT LEFT FOREVER ────────────────────
 * If Stripe never delivered the resolving event — it gives up retrying after
 * about three days, and a longer outage eats the event entirely — a row is left
 * behind with nothing coming to clear it.
 *
 * That is not a RECURRING lie: the digest windows pending money on
 * `submittedAt`, and `claimDigest` stamps the watermark even on a window whose
 * only content was pending, so a stranded row is read by exactly one digest per
 * rule and is invisible to every window after it. But it is still a WRONG one
 * — money announced as committed that the bank may well have refused — and a
 * row carrying a donor's name would otherwise live in the table indefinitely
 * with no screen anywhere that shows it. Nobody would ever find it.
 *
 * So there is a ceiling, `MAX_PENDING_AGE_MS`, enforced twice over: the digest
 * refuses to count anything past it (`collectWindowPending`), and
 * `sweepStrandedPendingGifts` deletes it daily. The read bound alone would
 * leave the donor data; the sweep alone would leave a replayed window able to
 * count it. Together, a pending row is a claim with an expiry date.
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { splitIntendedGift } from "./lib/givingDonors";

/**
 * How long a bank debit may stay "in flight" before we stop believing in it.
 *
 * THREE WEEKS, which is roughly triple the worst honest case. An ACH debit
 * settles in 2–4 business days; a holiday weekend stretches that to about six
 * calendar days, and Stripe retries a failing webhook for three more — so ten
 * days covers a debit that really is still moving plus a delivery that really
 * is still being retried. Past three weeks, the money is not slow, it is gone:
 * either the bank refused it and we never heard, or the session died.
 *
 * Chosen ABOVE any digest period rather than close to one, deliberately. A
 * weekly window reaches at most seven days back, so this bound can never cut
 * off a row a normal digest was going to report — it only bites on a window
 * that has legitimately run long (a rule that missed a month of runs reports
 * the month), which is precisely where a stranded row would otherwise get a
 * second airing.
 *
 * NOT tuned to ACH RETURNS, which run to 60 days: a return happens AFTER
 * settlement, so it is a `gifts` row being pulled back out (`givingReversals`),
 * never a row in this table.
 */
export const MAX_PENDING_AGE_MS = 21 * 24 * 60 * 60 * 1000;

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
 * NOT recorded: a BACKER (subscription) checkout. It falls through all three
 * branches and returns `false` — it carries no `giveDonation` marker and
 * matches no `donations` or `ticketOrders` row, which is the whole mechanism.
 *
 * That is the RIGHT answer for a reason worth stating, because the obvious
 * reason is wrong: a subscription session's `amount_total` is its first
 * invoice's total and can be perfectly non-zero, so "there's no amount to
 * record" is not why this is safe. It is safe because a backer's money becomes
 * a gift through `invoice.paid` — a different event, on a different object,
 * with its own idempotency key (`gifts.stripeInvoiceId`). A pending row written
 * here would be keyed on a session that no gift will ever reference, so nothing
 * could resolve it: exactly the permanent phantom the `/give` branch guards
 * against. Reporting an in-flight first cycle would need its own key and its
 * own lifecycle, and that is not this change.
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
      // ── THE DEBIT MAY ALREADY HAVE CLEARED ────────────────────────────
      // `by_session` above is idempotency against a LIVE row, and a resolved
      // row is DELETED — so the moment a debit clears, the key that would stop
      // a second write is destroyed with it. Two ordinary Stripe behaviours
      // walk straight into that:
      //
      //  · OUT OF ORDER. Stripe does not promise event order. After an outage
      //    or a deploy that 500s this endpoint, both events redeliver in
      //    whatever order; `async_payment_succeeded` lands first and books the
      //    gift, then the older `checkout.session.completed` arrives — with its
      //    snapshot still saying `payment_status: "unpaid"`, because event
      //    objects are frozen at creation — and reaches this branch.
      //  · REDELIVERY AFTER CLEARING. ACH takes 2–4 business days, Stripe
      //    retries a failing event for up to three, and "Resend" in the
      //    Dashboard is a normal debugging move.
      //
      // Both terminal events have been consumed by then, so nothing would ever
      // delete the row this would insert: a PERMANENT phantom, reporting one
      // donor's gift as both settled and still clearing, in the same digest.
      //
      // The gift's own idempotency key is the thing that survives — it is
      // exactly what `recordGiveDonationPaid` dedupes on. The other two
      // branches need no equivalent because they already have one: a settled
      // `donations` row is no longer `pending`, and neither is a fulfilled
      // `ticketOrders` row.
      const alreadySettled = await ctx.db
        .query("gifts")
        .withIndex("by_externalRef", (q) =>
          q.eq("externalRef", `give:${args.sessionId}`),
        )
        .first();
      if (alreadySettled) return false;

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

/**
 * Delete debits that were never resolved — the daily cron.
 *
 * The resolving webhook is the ONLY thing that normally clears a row, and it
 * can go missing: Stripe stops retrying after about three days, and an outage
 * longer than that loses the event outright. This is the backstop, and it
 * exists for the donor data as much as for the arithmetic — a row here carries
 * a person's name, no screen in the app shows this table, and "forever" is not
 * a retention policy. `MAX_PENDING_AGE_MS` explains the ceiling.
 *
 * DELETES rather than flagging. There is nothing to review: the row says a bank
 * debit was authorised three weeks ago and never landed, which is a fact about
 * Stripe's delivery, not about the money — if the debit DID clear, the gift is
 * in the ledger under its own idempotency key and was never this table's
 * business. Keeping a tombstone would mean building a screen for it.
 *
 * LOUD, once per sweep, because a nonzero count means webhooks are being lost
 * and that is worth knowing before it costs something that matters.
 */
export const sweepStrandedPendingGifts = internalMutation({
  args: { now: v.optional(v.number()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const cutoff = (args.now ?? Date.now()) - MAX_PENDING_AGE_MS;
    // Bounded: the table holds debits in flight, so this is normally empty and
    // never large. The index range means an empty sweep reads nothing at all.
    const stranded = await ctx.db
      .query("pendingGifts")
      .withIndex("by_submitted", (q) => q.lte("submittedAt", cutoff))
      .take(500);
    for (const row of stranded) await ctx.db.delete(row._id);
    if (stranded.length > 0) {
      console.error(
        `[givingPending] swept ${stranded.length} bank debit(s) that were ` +
          `authorised over ${Math.round(MAX_PENDING_AGE_MS / 86_400_000)} days ` +
          "ago and never resolved. Stripe never delivered their " +
          "async_payment_succeeded/failed — check webhook delivery.",
      );
    }
    return stranded.length;
  },
});
