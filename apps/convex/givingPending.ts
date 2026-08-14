/**
 * ACH giving that is in flight — authorised by the donor, not yet moved by the
 * bank.
 *
 * A writer, a resolver and a sweeper. All three are called ONLY from the Stripe
 * webhook (`http.ts`) or a cron, and all three key on the Checkout Session id.
 * See `schema/givingPlatform.ts#pendingGifts` for why this table exists and why
 * it is not `donations` / `ticketOrders` / `givingActivity`.
 *
 * ── EVERY RESOLUTION MUST LEAVE A KEY BEHIND ───────────────────────────────
 * Stripe delivers at least once and in no guaranteed order, and an event's
 * object is frozen at creation — so a `checkout.session.completed` retry still
 * reads `payment_status: "unpaid"` days after the debit resolved, and lands
 * here. This is the ONE thing this file has to get right, and it got it wrong
 * twice, in the same shape both times: a resolved row that leaves NOTHING
 * behind cannot recognise its own session again, so the redelivery re-creates a
 * pending row that no later event will ever clear.
 *
 * `by_session` alone is therefore not idempotency — it is idempotency against a
 * LIVE row. Every path a session can take now ends holding a key that outlives
 * it:
 *
 *   CLEARED   → row deleted; the `gifts` row's `externalRef` is the key.
 *   FAILED    → row KEPT, marked `failed`; the row itself is the key, because
 *               no gift exists or ever will.
 *   (branches 2 and 3 have a third: their `donations` / `ticketOrders` source
 *    row, which goes `paid` on success and `expired` on failure, so neither
 *    ever reads as `pending` again.)
 *
 * ── THE ONE CASE THAT IS STILL OPEN, STATED RATHER THAN CLAIMED AWAY ───────
 * A key can only outlive a resolution it was present for. If a `/give`
 * session's FAILURE is processed before its `completed` ever arrives — a true
 * out-of-order delivery, not a redelivery — there is no row to tombstone and no
 * gift to point at, so the late completion writes a fresh `in_flight` row.
 *
 * Left open deliberately, because closing it needs a durable record of every
 * session we have ever seen, which is a different and much larger thing than
 * this table. The blast radius is bounded and small: the row is windowed on the
 * redelivery instant so it enters exactly ONE digest, that digest says
 * `$X still clearing` — already caveated as money a bank can refuse — and no
 * gift is ever booked behind it, so nothing real is double-counted and book
 * value cannot move. `MAX_PENDING_AGE_MS` caps it at 21 days. There is a test
 * asserting this shape, so it stays a decision rather than becoming a surprise.
 *
 * Nothing here is bounded by trust in Stripe's delivery: `MAX_PENDING_AGE_MS`
 * caps anything that still slips through.
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
    /** When the donor authorised the debit. Injectable so the digest's window
     *  boundaries are testable; production passes the webhook's instant. */
    submittedAt: v.optional(v.number()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const now = args.submittedAt ?? Date.now();

    // Stripe delivers at least once, and a redelivered completion must not
    // double the pending figure.
    //
    // ANY existing row refuses, `in_flight` or `failed` alike. A `failed` row
    // is a TOMBSTONE kept for exactly this: the bank refused the debit, so no
    // gift will ever exist to act as the key, and without the row a Dashboard
    // "Resend" would re-create a phantom for money that is already gone. See
    // `resolvePendingGift`.
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

      // THE PENDING FIGURE IS THE CHARGE, because the gift is the charge — the
      // same rule the settle path books by (`gifts.feeCoverageCents`), so the
      // figure a digest reports as "still clearing" is the figure that later
      // appears as a gift. This used to report the smaller pre-coverage amount
      // to match the old split; reporting anything but the charge now would
      // make the pending line and the settled gift disagree by the fee
      // coverage, every time a donor ticked the box.
      await ctx.db.insert("pendingGifts", {
        sessionId: args.sessionId,
        status: "in_flight",
        scope: donor.scope,
        amountCents: args.amountTotalCents,
        chargeTotalCents: args.amountTotalCents,
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
        status: "in_flight",
        scope: donation.chapterId,
        amountCents: donation.amountCents,
        chargeTotalCents: args.amountTotalCents,
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
        status: "in_flight",
        scope: order.chapterId,
        // ONLY the upsell. `order.totalCents` is ticket revenue, which never
        // becomes a gift and has no business in a giving digest. The charge
        // total, by contrast, is the WHOLE session — tickets included — since
        // that is what Stripe holds in pending while the debit clears.
        amountCents: addOnCents,
        chargeTotalCents: args.amountTotalCents,
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
 * The debit resolved — it is no longer in flight, whichever way it went.
 *
 * ONE mutation, two outcomes, because the two leave behind different keys and
 * that is the whole of the design:
 *
 *  · `settled` — the debit cleared (`settleCheckoutSession`). DELETE the row.
 *    The gift now in the ledger is the durable key: a redelivered `completed`
 *    is refused by the writer's `gifts.by_externalRef` check.
 *  · `failed` — the bank refused it, or the session died
 *    (`cancelCheckoutSession`). MARK the row `failed` and KEEP it, because
 *    there is no gift and there never will be, so the row is the only key that
 *    can exist. Deleting it is what let a resent `completed` re-create a
 *    phantom for money the bank had already refused — the failure-side mirror
 *    of the cleared-side bug, and it shipped for the same reason: a resolved
 *    row that leaves nothing behind cannot recognise its own session again.
 *
 * The asymmetry looks like an inconsistency and is the opposite. Each side
 * keeps whichever key OUTLIVES it: delete when something better survives, mark
 * when nothing else would.
 *
 * After a failure the amount is gone from FUTURE digests either way — a
 * `failed` row is not `in_flight`, and `collectWindowPending` counts only
 * `in_flight`. A digest already mailed announcing it is water under the bridge
 * and is deliberately not corrected; the caveat says out loud that a bank can
 * still refuse the money.
 */
export const resolvePendingGift = internalMutation({
  args: {
    sessionId: v.string(),
    outcome: v.union(v.literal("settled"), v.literal("failed")),
  },
  returns: v.boolean(),
  handler: async (ctx, { sessionId, outcome }) => {
    const row = await ctx.db
      .query("pendingGifts")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .unique();
    // No row is the NORMAL case: every card checkout in the system reaches
    // here, and none of them was ever pending.
    if (!row) return false;
    if (outcome === "settled") {
      await ctx.db.delete(row._id);
      return true;
    }
    // Idempotent: re-marking an already-failed row writes the same value.
    await ctx.db.patch(row._id, { status: "failed" });
    return true;
  },
});

/**
 * Age out this table — the daily cron. Two different rows, one rule.
 *
 *  · STRANDED (`in_flight`): the resolving webhook never arrived. Stripe stops
 *    retrying after about three days and a longer outage loses the event
 *    outright. Such a row is wrong — money announced as committed that the bank
 *    may well have refused — and it exists for the donor data as much as for
 *    the arithmetic: it carries a person's name, no screen in the app shows
 *    this table, and "forever" is not a retention policy.
 *  · TOMBSTONES (`failed`): deliberately kept by `resolvePendingGift` so a
 *    resent `completed` can be refused. Past the ceiling no redelivery is
 *    coming, so the key has done its job.
 *
 * DELETES rather than flagging. There is nothing to review — the row says a
 * bank debit was authorised three weeks ago and never landed, which is a fact
 * about Stripe's delivery, not about the money. Stripe remains the system of
 * record for the session, and if the debit DID clear, the gift is in the ledger
 * under its own key and was never this table's business.
 *
 * A PARTIAL SWEEP IS A DECISION, NOT A LIMIT. `.take(500)` reads the index
 * ascending, so the oldest go first and a bigger backlog finishes on the
 * following day's run rather than blowing the transaction. Nothing degrades
 * meanwhile: `collectWindowPending` applies the same ceiling on the read, so a
 * row the sweep hasn't reached yet is already uncountable.
 *
 * LOUD, and it names the SESSIONS — a count tells you webhooks are being lost
 * and gives you no way to chase them; a session id can be pasted into the
 * Stripe Dashboard. Session ids only: no donor name, no amount, no PII.
 */
export const sweepStrandedPendingGifts = internalMutation({
  args: { now: v.optional(v.number()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const cutoff = (args.now ?? Date.now()) - MAX_PENDING_AGE_MS;
    // Bounded: the table holds debits in flight, so this is normally empty and
    // never large. The index range means an empty sweep reads nothing at all.
    const aged = await ctx.db
      .query("pendingGifts")
      .withIndex("by_submitted", (q) => q.lte("submittedAt", cutoff))
      .take(500);
    // Only the ones that never resolved say anything about webhook health; a
    // swept tombstone is the system working as designed and must not raise an
    // alarm that trains people to ignore this log.
    const stranded = aged.filter((row) => row.status === "in_flight");
    for (const row of aged) await ctx.db.delete(row._id);
    if (stranded.length > 0) {
      console.error(
        `[givingPending] swept ${stranded.length} bank debit(s) authorised over ` +
          `${Math.round(MAX_PENDING_AGE_MS / 86_400_000)} days ago that never ` +
          "resolved — Stripe delivered no async_payment_succeeded/failed for " +
          `them. Check webhook delivery for: ${stranded
            .map((row) => row.sessionId)
            .join(", ")}`,
      );
    }
    return aged.length;
  },
});
