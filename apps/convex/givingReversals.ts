/**
 * When money that already posted to the books gets pulled back out.
 *
 * ── THE HOLE THIS FILLS ─────────────────────────────────────────────────────
 * #581 stopped us booking an ACH gift before it settled. That fixed the window
 * BEFORE settlement. It did nothing about the window after it, which is far
 * longer and far less intuitive: a bank can return a settled ACH debit for up
 * to **60 calendar days** on a personal account (two business days on a
 * business one), and Stripe itself can raise a post-settlement failure as a
 * dispute with reason `insufficient_funds` / `incorrect_account_details` /
 * `bank_cannot_process`.
 *
 * So a gift could clear in September, be thanked for, be counted in a donor's
 * lifetime total, a scope rollup and possibly a territory's launch pot — and be
 * silently gone in November with every one of those numbers still claiming it.
 * That is the worst shape a money bug takes: the books look fine.
 *
 * ── WHAT ARRIVES, AND WHAT IT MEANS ─────────────────────────────────────────
 * All of it comes through `charge.dispute.created`, which is unfortunately
 * TWO different events wearing one name:
 *
 *  1. A real dispute or return — money has been (or is being) taken back.
 *  2. An **authorization inquiry**. A customer's bank asks for proof the debit
 *     was authorised. Stripe raises this as `charge.dispute.created` too, with
 *     a `warning_*` status, and **no money moves**.
 *
 * Reversing a gift on an inquiry would delete a perfectly good gift because
 * somebody's bank asked a question. `disputeMovesMoney` is the guard, and the
 * `warning_` prefix is the whole test — Stripe's inquiry statuses are
 * `warning_needs_response` / `warning_under_review` / `warning_closed`, and
 * every status that means real money is one of `needs_response` /
 * `under_review` / `won` / `lost`.
 *
 * ── IDEMPOTENT ON THE DISPUTE, WHICH IS STRONGER THAN THE EVENT ─────────────
 * Every other redelivery-prone branch in `http.ts` dedups on the Stripe event
 * id. This one dedups on the **dispute id** (`giftReversals.by_dispute`), and
 * deliberately so. Event-id dedup only survives a redelivery of the identical
 * event; dispute-id dedup survives that, plus a second event about the same
 * dispute, plus — the one that matters — a replay after a failed attempt. If
 * the event id were the gate, an attempt that crashed halfway would be locked
 * out by its own ledger row and the reversal would be lost forever, which for
 * a money-path event is not an acceptable way to fail. Replaying a handled
 * dispute is a no-op; that is what "idempotent on the event id" has to mean
 * here.
 *
 * ── AN HONEST TRAIL, NOT A TIDY TABLE ───────────────────────────────────────
 * The reversal goes through `removeGiftRow`, because that is the only thing
 * that un-winds `lifetimeCents`, `giftCount`, donor status, the scope rollup,
 * the cross-chapter identity totals and the launch pot consistently — a raw
 * `ctx.db.patch` would leave five numbers wrong. But `removeGiftRow` deletes,
 * and a deleted row explains nothing, so a `giftReversals` tombstone is written
 * FIRST, carrying a full snapshot of what was reversed and Stripe's own reason
 * for it. Same principle as `reverseBadSettlement.ts`. Both writes are in one
 * mutation, so the trail cannot exist without the reversal or vice versa.
 *
 * ── SCOPE: `/give` ONE-TIME GIFTS ───────────────────────────────────────────
 * A dispute is resolved to a gift by asking Stripe which Checkout Session
 * created the disputed PaymentIntent, then looking that session up as
 * `gifts.by_externalRef` = `give:<session id>`. That is the only Stripe
 * identifier a `/give` gift persists. A dispute against a ticket order, an
 * event donation, or a recurring cycle finds no such gift and is LOGGED, not
 * guessed at: those unwind through their own tables (`ticketOrders`,
 * `donations`, `pledges`) and inventing a partial reversal for them here would
 * be worse than the honest gap. See the PR for why that is a deliberate line.
 */
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { recordGiftForDonor, removeGiftRow } from "./lib/givingDonors";

const STRIPE_API = "https://api.stripe.com/v1";

/**
 * Has money actually been taken back, or is a bank merely asking a question?
 *
 * `warning_*` is Stripe's marker for an authorization INQUIRY — the customer's
 * bank wants proof the debit was authorised. It arrives as
 * `charge.dispute.created` exactly like a real return does, and it moves no
 * money at all. Acting on one would delete a good gift over a question.
 *
 * Absent status is treated as REAL. A dispute is a money event by default, and
 * failing to reverse a real return (books overstate income, donor keeps a
 * thank-you for money they got back) is worse than the alternative, which a
 * won-dispute restore can undo anyway.
 */
export function disputeMovesMoney(status: string | undefined | null): boolean {
  return !(status ?? "").startsWith("warning_");
}

/**
 * Which Checkout Session created this PaymentIntent?
 *
 * A `/give` gift stores no charge or PaymentIntent id — its only Stripe
 * identifier is the session id, inside `externalRef`. So the dispute → gift
 * path has to go out to Stripe. `reconciliation.ts#lookupSession` does the
 * identical hop for payout allocation; this is the same call, kept local
 * because that one is memoized inside a payout run.
 *
 * `null` on anything unexpected — an unresolvable dispute must log, never
 * throw, or a webhook retry storm is the result.
 */
async function lookupSessionId(
  paymentIntentId: string,
): Promise<string | null> {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;
  const response = await fetch(
    `${STRIPE_API}/checkout/sessions` +
      `?payment_intent=${encodeURIComponent(paymentIntentId)}&limit=1`,
    { headers: { Authorization: `Bearer ${secretKey}` } },
  );
  if (!response.ok) {
    console.error(
      `[givingReversals] session lookup for ${paymentIntentId} failed: ${response.status}`,
    );
    return null;
  }
  const body = (await response.json()) as { data?: Array<{ id?: string }> };
  return body.data?.[0]?.id ?? null;
}

/** A dispute's PaymentIntent, going via the charge when the event omits it. */
async function lookupChargePaymentIntent(
  chargeId: string,
): Promise<string | null> {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;
  const response = await fetch(
    `${STRIPE_API}/charges/${encodeURIComponent(chargeId)}`,
    { headers: { Authorization: `Bearer ${secretKey}` } },
  );
  if (!response.ok) return null;
  const charge = (await response.json()) as {
    payment_intent?: string | null;
  };
  return charge.payment_intent ?? null;
}

// ── The reversal ─────────────────────────────────────────────────────────────

const reverseResult = v.object({
  /** True only on the pass that actually took the gift off the books. */
  reversed: v.boolean(),
  /** Why not, when not — for the log, never shown to anyone. */
  skipped: v.optional(v.string()),
  amountCents: v.optional(v.number()),
});

/**
 * Take a settled gift back off the books, and leave a row saying why.
 *
 * Everything happens in ONE mutation so it is atomic: the tombstone, the gift
 * removal and every rollup `removeGiftRow` touches either all commit or none
 * do. There is no state in which the money is gone and the explanation isn't.
 *
 * Returns rather than throws for every "nothing to do" case — a dispute
 * against a ticket order or a gift the desk already deleted is a normal thing
 * to see, not an error, and throwing inside a webhook-driven action only buys
 * a retry that will reach the same conclusion.
 */
export const reverseGiftForDispute = internalMutation({
  args: {
    sessionId: v.string(),
    stripeDisputeId: v.string(),
    stripeChargeId: v.optional(v.string()),
    stripePaymentIntentId: v.optional(v.string()),
    disputeReason: v.optional(v.string()),
    disputedAmountCents: v.optional(v.number()),
  },
  returns: reverseResult,
  handler: async (ctx, args) => {
    // THE idempotency gate. Keyed on the dispute, so a redelivery, a second
    // event about the same dispute, and a replay after a crash all land here.
    const existing = await ctx.db
      .query("giftReversals")
      .withIndex("by_dispute", (q) =>
        q.eq("stripeDisputeId", args.stripeDisputeId),
      )
      .first();
    if (existing) return { reversed: false, skipped: "already recorded" };

    const externalRef = `give:${args.sessionId}`;
    const gift = await ctx.db
      .query("gifts")
      .withIndex("by_externalRef", (q) => q.eq("externalRef", externalRef))
      .first();
    // Not a `/give` gift (a ticket order, an event donation, a recurring
    // cycle), or one the desk has already removed by hand. Either way there is
    // nothing here to reverse and nothing honest to invent.
    if (!gift) return { reversed: false, skipped: `no gift for ${externalRef}` };

    // The tombstone goes in BEFORE the row it describes disappears, carrying
    // everything `recordGiftForDonor` would need to put it back if the dispute
    // is later won.
    await ctx.db.insert("giftReversals", {
      donorId: gift.donorId,
      scope: gift.scope,
      amountCents: gift.amountCents,
      currency: gift.currency,
      receivedAt: gift.receivedAt,
      method: gift.method,
      externalRef,
      ...(gift.note !== undefined ? { note: gift.note } : {}),
      ...(gift.countedInLaunchFund !== undefined
        ? { countedInLaunchFund: gift.countedInLaunchFund }
        : {}),
      stripeDisputeId: args.stripeDisputeId,
      ...(args.stripeChargeId ? { stripeChargeId: args.stripeChargeId } : {}),
      ...(args.stripePaymentIntentId
        ? { stripePaymentIntentId: args.stripePaymentIntentId }
        : {}),
      ...(args.disputeReason ? { disputeReason: args.disputeReason } : {}),
      ...(args.disputedAmountCents !== undefined
        ? { disputedAmountCents: args.disputedAmountCents }
        : {}),
      status: "reversed",
      reversedAt: Date.now(),
    });

    // The ONLY correct way to take a gift out: it un-winds the donor's
    // lifetime total and gift count, re-derives their status and first/last
    // bookends, moves the scope rollup, refreshes the cross-chapter identity
    // totals, and un-bumps the territory launch pot for a gift that was
    // counted into one. A `ctx.db.delete` would leave all five wrong.
    await removeGiftRow(ctx, gift._id);

    return { reversed: true, amountCents: gift.amountCents };
  },
});

/**
 * The dispute was WON — the money came back, so the reversal must come back out.
 *
 * Re-records the gift from the tombstone's snapshot through the same
 * `recordGiftForDonor` that wrote it originally, so every rollup moves by
 * exactly the amount the reversal moved them by. The new row has a new id; the
 * old one is gone for good, which is why `restoredGiftId` is recorded.
 *
 * For a genuine ACH return this should never fire: Stripe documents ACH
 * disputes as final and uncontestable, and we never reverse on an inquiry, so
 * there is nothing left that can be won. It exists because the same webhook
 * carries CARD chargebacks, which are contestable and are won often enough
 * that "the reversal is permanent" would be a wrong assumption to bake in.
 */
export const restoreGiftForDispute = internalMutation({
  args: { stripeDisputeId: v.string() },
  returns: v.object({
    restored: v.boolean(),
    skipped: v.optional(v.string()),
    amountCents: v.optional(v.number()),
  }),
  handler: async (ctx, { stripeDisputeId }) => {
    const reversal = await ctx.db
      .query("giftReversals")
      .withIndex("by_dispute", (q) => q.eq("stripeDisputeId", stripeDisputeId))
      .first();
    // A dispute we never reversed anything for (an inquiry, a ticket order, a
    // charge with no gift behind it) has nothing to give back.
    if (!reversal) return { restored: false, skipped: "no reversal recorded" };
    if (reversal.status === "restored") {
      return { restored: false, skipped: "already restored" };
    }
    // The donor row itself could have been merged or deleted in the weeks
    // since. Without it there is nothing to attach a gift to.
    const donor = await ctx.db.get(reversal.donorId);
    if (!donor) return { restored: false, skipped: "donor is gone" };

    const giftId = await recordGiftForDonor(ctx, {
      donorId: reversal.donorId,
      amountCents: reversal.amountCents,
      // The ORIGINAL date, not today. The money arrived when it arrived; a
      // dispute that resolved in our favour doesn't move it into this quarter.
      receivedAt: reversal.receivedAt,
      method: reversal.method,
      ...(reversal.externalRef ? { externalRef: reversal.externalRef } : {}),
      ...(reversal.note ? { note: reversal.note } : {}),
    });

    await ctx.db.patch(reversal._id, {
      status: "restored",
      restoredAt: Date.now(),
      restoredGiftId: giftId,
    });

    return { restored: true, amountCents: reversal.amountCents };
  },
});

// ── The webhook entry points ─────────────────────────────────────────────────

/**
 * `charge.dispute.created` — resolve it to a gift and take the money back out.
 *
 * An ACTION rather than a mutation because resolving a dispute to a gift needs
 * two possible round-trips to Stripe (charge → PaymentIntent → Checkout
 * Session); a `/give` gift persists no charge or PaymentIntent id, so there is
 * no in-database route.
 *
 * Every exit is a log and a return. A webhook handler that throws gets retried
 * forever against a condition that will not change.
 */
export const onDisputeCreated = internalAction({
  args: {
    disputeId: v.string(),
    chargeId: v.optional(v.string()),
    paymentIntentId: v.optional(v.string()),
    reason: v.optional(v.string()),
    status: v.optional(v.string()),
    amountCents: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!disputeMovesMoney(args.status)) {
      // An authorization inquiry. Someone's bank is asking a question about a
      // debit; no money has moved and the gift stays exactly where it is.
      console.log(
        `[givingReversals] dispute ${args.disputeId} is an inquiry ` +
          `(status=${args.status}) — no money moved, nothing reversed`,
      );
      return null;
    }

    const paymentIntentId =
      args.paymentIntentId ??
      (args.chargeId ? await lookupChargePaymentIntent(args.chargeId) : null);
    if (!paymentIntentId) {
      console.error(
        `[givingReversals] dispute ${args.disputeId} has no resolvable payment intent`,
      );
      return null;
    }

    const sessionId = await lookupSessionId(paymentIntentId);
    if (!sessionId) {
      // A charge with no Checkout Session behind it — a Tap-to-Pay sale, an
      // invoice, a manual charge. None of those are `/give` gifts.
      console.log(
        `[givingReversals] dispute ${args.disputeId} (${paymentIntentId}) ` +
          `has no checkout session — not a /give gift`,
      );
      return null;
    }

    const result = await ctx.runMutation(
      internal.givingReversals.reverseGiftForDispute,
      {
        sessionId,
        stripeDisputeId: args.disputeId,
        ...(args.chargeId ? { stripeChargeId: args.chargeId } : {}),
        stripePaymentIntentId: paymentIntentId,
        ...(args.reason ? { disputeReason: args.reason } : {}),
        ...(args.amountCents !== undefined
          ? { disputedAmountCents: args.amountCents }
          : {}),
      },
    );

    if (!result.reversed) {
      console.log(
        `[givingReversals] dispute ${args.disputeId} reversed nothing: ${result.skipped}`,
      );
      return null;
    }

    console.log(
      `[givingReversals] dispute ${args.disputeId} reversed ` +
        `${result.amountCents}¢ (session ${sessionId}, reason ${args.reason ?? "unknown"})`,
    );

    // The wall is consent-gated, but consent was to show a gift that happened.
    // A returned one must not stay up. Done here rather than left to the email
    // so it happens even if there is nobody to write to.
    await ctx.runMutation(internal.givingActivity.withdrawActivity, {
      refKey: `give:${sessionId}`,
    });

    // Gated on `reversed`, so the donor is told once — on the pass that
    // actually moved the money, never on a redelivery.
    await ctx.scheduler.runAfter(0, internal.givingComms.onAchReturned, {
      sessionId,
      ...(args.reason ? { reason: args.reason } : {}),
    });
    return null;
  },
});

/**
 * `charge.dispute.closed` — put it back if we won.
 *
 * `lost` needs nothing: the reversal already happened on `created` and the
 * outcome merely confirms it. Any other closing status is not a money event.
 *
 * NO EMAIL, deliberately. A won dispute means the account holder asked for
 * their money back and did not get it. Writing to tell them their gift is
 * restored would be the org narrating a decision that went against them, in a
 * situation where the right next contact — if there is one — is a person, not
 * an automated receipt. The books get corrected; the donor gets left alone.
 */
export const onDisputeClosed = internalAction({
  args: { disputeId: v.string(), status: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { disputeId, status }) => {
    if (status !== "won") return null;

    const result = await ctx.runMutation(
      internal.givingReversals.restoreGiftForDispute,
      { stripeDisputeId: disputeId },
    );
    if (!result.restored) {
      console.log(
        `[givingReversals] won dispute ${disputeId} restored nothing: ${result.skipped}`,
      );
      return null;
    }
    console.log(
      `[givingReversals] won dispute ${disputeId} restored ${result.amountCents}¢`,
    );

    // Back on the wall if that is what the giver asked for — `markActivityVisible`
    // re-checks consent, so a donor who never opted in stays off it.
    const reversal = await ctx.runQuery(
      internal.givingReversals.getReversalRefKey,
      { stripeDisputeId: disputeId },
    );
    if (reversal) {
      await ctx.runMutation(internal.givingActivity.markActivityVisible, {
        refKey: reversal.refKey,
        amountCents: reversal.amountCents,
      });
    }
    return null;
  },
});

/** The wall key + amount for a reversal, so a restore can put the entry back. */
export const getReversalRefKey = internalQuery({
  args: { stripeDisputeId: v.string() },
  returns: v.union(
    v.object({ refKey: v.string(), amountCents: v.number() }),
    v.null(),
  ),
  handler: async (ctx, { stripeDisputeId }) => {
    const reversal = await ctx.db
      .query("giftReversals")
      .withIndex("by_dispute", (q) => q.eq("stripeDisputeId", stripeDisputeId))
      .first();
    if (!reversal?.externalRef) return null;
    return {
      refKey: reversal.externalRef,
      amountCents: reversal.amountCents,
    };
  },
});
