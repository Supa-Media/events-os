/**
 * Giving — donations on the public RSVP page. Mirrors the ticket-order money
 * machinery 1:1 (no parallel system):
 *
 *   - ADMIN (requireEvent / requireOwned): record a manual cash/other donation,
 *     list donations, remove one. Used by the Giving card in the Tickets tab.
 *   - PUBLIC card flow (INTERNAL helpers): `prepareDonation` (mirror of
 *     `ticketing.prepareOrder`) creates a pending donation, the Stripe action
 *     (`stripe.createDonationCheckout`) redirects to Checkout, and the shared
 *     `/stripe/webhook` settles it via `markDonationPaid` → `fulfillDonation`
 *     (mirror of `ticketing.markSessionPaid` → `fulfill`).
 *
 * Money is always integer cents. The rollup (`donationsCents` / `donationsCount`)
 * lives on `eventPages`, a sibling of `revenueCents`, bumped on every paid
 * donation and decremented when a paid manual donation is removed.
 */
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { normalizeEmail } from "./lib/access";
import { requireEvent, requireOwned, requireUserId } from "./lib/context";
import { clearEmailCode } from "./lib/emailCodes";
import {
  dualWriteGiftForDonation,
  removeGiftForDonation,
} from "./lib/givingDonors";
import {
  bumpRsvpCounters,
  getPublishedPage,
  getViewerRsvp,
  newGuestToken,
} from "./ticketing";

// ── Small helpers ────────────────────────────────────────────────────────────

/** Guard: donation amounts are whole cents strictly greater than zero. */
function assertPositiveCents(amountCents: number): void {
  if (amountCents <= 0 || !Number.isInteger(amountCents)) {
    throw new ConvexError({
      code: "INVALID_AMOUNT",
      message: "Amount must be a whole number of cents greater than zero.",
    });
  }
}

/** Bump the page rollup by `deltaCents` / `deltaCount` (clamped at 0). */
async function bumpGivingRollup(
  ctx: MutationCtx,
  eventId: Id<"events">,
  deltaCents: number,
  deltaCount: number,
): Promise<void> {
  const page = await ctx.db
    .query("eventPages")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .unique();
  if (!page) return;
  await ctx.db.patch(page._id, {
    donationsCents: Math.max(0, (page.donationsCents ?? 0) + deltaCents),
    donationsCount: Math.max(0, (page.donationsCount ?? 0) + deltaCount),
  });
}

// ── ADMIN: manual entry (cash / other) ───────────────────────────────────────

/**
 * Record a manual donation (cash at the merch table, a check, etc.). Card
 * donations never come through here — they go via Stripe. Inserted `paid`
 * immediately and bumps the rollup.
 */
export const recordDonation = mutation({
  args: {
    eventId: v.id("events"),
    amountCents: v.number(),
    method: v.union(v.literal("cash"), v.literal("other")),
    name: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const event = await requireEvent(ctx, args.eventId);
    const userId = await requireUserId(ctx);
    assertPositiveCents(args.amountCents);

    const donationId = await ctx.db.insert("donations", {
      chapterId: event.chapterId,
      eventId: args.eventId,
      name: args.name?.trim() || "Anonymous",
      amountCents: args.amountCents,
      currency: "usd",
      method: args.method,
      status: "paid",
      note: args.note?.trim() || undefined,
      recordedBy: userId as Id<"users">,
      createdAt: Date.now(),
    });
    await bumpGivingRollup(ctx, args.eventId, args.amountCents, 1);
    // F-6 P1: mirror the settled donation into the donor CRM (additive — the
    // event rollup above is untouched). Keyed to the event's chapter.
    const donation = await ctx.db.get(donationId);
    if (donation) await dualWriteGiftForDonation(ctx, donation);
    return donationId;
  },
});

/** All donations for an event (admin Giving card). Returns full rows. */
export const listDonationsAdmin = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    await requireEvent(ctx, eventId);
    return await ctx.db
      .query("donations")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .order("desc")
      .take(500);
  },
});

/** Remove a donation; a paid one first decrements the rollup. */
export const removeDonation = mutation({
  args: { donationId: v.id("donations") },
  handler: async (ctx, { donationId }) => {
    const donation = await requireOwned(ctx, "donations", donationId, "Donation");
    // A `pending` row is an IN-FLIGHT card checkout: the donor may still be on
    // Stripe. Deleting it now would orphan a real payment — the completion
    // webhook would find no row (no receipt, no rollup credit). Refuse; an
    // abandoned pending row is cleaned up by the expiry webhook
    // (`cancelPendingDonation`) instead. Manual donations are inserted `paid`,
    // so this never blocks removing a recorded cash/other gift.
    if (donation.status === "pending") {
      throw new ConvexError({
        code: "DONATION_IN_FLIGHT",
        message:
          "This card donation is still being processed — it can't be removed until it settles or expires.",
      });
    }
    if (donation.status === "paid") {
      await bumpGivingRollup(ctx, donation.eventId, -donation.amountCents, -1);
      // F-6 P1: reverse the linked CRM gift (+ its donor rollups). No-op if the
      // donation was never mirrored. Removes the gift BEFORE the donation row.
      await removeGiftForDonation(ctx, donationId);
    }
    await ctx.db.delete(donationId);
    return null;
  },
});

// ── COMBINED CHECKOUT: paid donation from a ticket order's add-on gift ──────

/**
 * Create + settle a PAID donation for the ticket-checkout's optional add-on
 * gift (the "would you also like to donate?" upsell). The SAME Stripe charge
 * that paid for the tickets already collected this amount — there is no
 * separate pending→paid step like the standalone donation checkout — so this
 * inserts straight to `paid` and runs the same rollup + CRM dual-write
 * (`bumpGivingRollup`, `dualWriteGiftForDonation`) and receipt-email scheduling
 * that `fulfillDonation` runs for a card donation. Money invariant: this ONLY
 * touches `donations`/`donationsCents`/`gifts` — never `revenueCents` or the
 * order itself (the caller does that separately for the ticket portion).
 *
 * Called by `ticketing.ts#fulfill` directly (same-ctx helper, not a
 * registered mutation) so both writes land in the SAME mutation transaction
 * as the ticket issuance. NOT idempotent on its own — the caller's
 * `order.status === "paid"` early-return is what guarantees this runs at
 * most once per order (webhook redelivery re-enters `fulfill`, which no-ops
 * before ever reaching this call).
 */
export async function createPaidDonationForOrder(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    chapterId: Id<"chapters">;
    rsvpId?: Id<"rsvps">;
    name: string;
    email: string;
    amountCents: number;
  },
): Promise<Id<"donations">> {
  const now = Date.now();
  const donationId = await ctx.db.insert("donations", {
    chapterId: args.chapterId,
    eventId: args.eventId,
    name: args.name,
    email: args.email,
    amountCents: args.amountCents,
    currency: "usd",
    method: "card",
    status: "paid",
    rsvpId: args.rsvpId,
    createdAt: now,
  });
  await bumpGivingRollup(ctx, args.eventId, args.amountCents, 1);
  // F-6 P1: mirror into the donor CRM exactly like every other paid donation —
  // reuse the same dual-write helper `fulfillDonation` uses, never hand-roll a
  // second one.
  const donation = await ctx.db.get(donationId);
  if (donation) await dualWriteGiftForDonation(ctx, donation);

  await ctx.scheduler.runAfter(
    0,
    internal.ticketingEmails.sendDonationReceiptEmail,
    { donationId },
  );
  return donationId;
}

// ── INTERNAL: card donation lifecycle (shared by stripe.ts + webhook) ─────────

/**
 * Validate a card donation and create a pending row (+ ensure an RSVP identity
 * for the donor). Called by `stripe.createDonationCheckout` right before Stripe.
 * Mirrors `ticketing.prepareOrder`.
 */
export const prepareDonation = internalMutation({
  args: {
    slug: v.string(),
    name: v.string(),
    email: v.string(),
    amountCents: v.number(),
    token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const page = await getPublishedPage(ctx, args.slug);
    if (!page || page.givingEnabled !== true) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Donations aren't enabled for this event.",
      });
    }
    assertPositiveCents(args.amountCents);
    const name = args.name.trim();
    const email = normalizeEmail(args.email);
    if (!name || !email || !email.includes("@")) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "A name and valid email are required.",
      });
    }

    const now = Date.now();

    // Ensure the donor has an RSVP identity (mirror prepareOrder — token, then
    // same-email, then a fresh 'maybe' row that fulfillment leaves as-is).
    let rsvp = await getViewerRsvp(ctx, page.eventId, args.token);
    if (!rsvp) {
      rsvp = await ctx.db
        .query("rsvps")
        .withIndex("by_event_email", (q) =>
          q.eq("eventId", page.eventId).eq("email", email),
        )
        .first();
    }
    let rsvpId: Id<"rsvps">;
    let guestToken: string;
    if (rsvp) {
      rsvpId = rsvp._id;
      guestToken = rsvp.token;
      await ctx.db.patch(rsvp._id, { name, updatedAt: now });
    } else {
      guestToken = newGuestToken();
      rsvpId = await ctx.db.insert("rsvps", {
        eventId: page.eventId,
        chapterId: page.chapterId,
        name,
        email,
        status: "maybe",
        token: guestToken,
        source: "rsvp",
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      });
      await bumpRsvpCounters(ctx, page, null, "maybe");
    }

    const donationId = await ctx.db.insert("donations", {
      chapterId: page.chapterId,
      eventId: page.eventId,
      name,
      email,
      amountCents: args.amountCents,
      currency: "usd",
      method: "card",
      status: "pending",
      rsvpId,
      createdAt: now,
    });

    const event = await ctx.db.get(page.eventId);
    return {
      donationId,
      amountCents: args.amountCents,
      guestToken,
      slug: page.slug,
      eventName: event?.name ?? "Event",
    };
  },
});

/** Attach the Stripe Checkout Session id to a pending donation. */
export const attachDonationSession = internalMutation({
  args: { donationId: v.id("donations"), sessionId: v.string() },
  handler: async (ctx, { donationId, sessionId }) => {
    await ctx.db.patch(donationId, { stripeCheckoutSessionId: sessionId });
    return null;
  },
});

/**
 * Settle a paid card donation: mark it paid, bump the rollup, mark the donor's
 * email verified (a completed Stripe payment proves control of the address),
 * schedule a receipt. Idempotent — a second call no-ops. Mirror of `fulfill`.
 */
async function fulfillDonation(
  ctx: MutationCtx,
  donationId: Id<"donations">,
  stripePaymentIntentId?: string,
): Promise<null> {
  const donation = await ctx.db.get(donationId);
  if (!donation) return null;
  if (donation.status === "paid") return null; // idempotent (webhook retries)

  const now = Date.now();
  await ctx.db.patch(donationId, {
    status: "paid",
    ...(stripePaymentIntentId ? { stripePaymentIntentId } : {}),
  });
  await bumpGivingRollup(ctx, donation.eventId, donation.amountCents, 1);
  // F-6 P1: mirror the settled card donation into the donor CRM (idempotent on
  // redelivery via the `donationId` link — the early `status === "paid"` return
  // above already guards the rollup; this is a belt-and-suspenders no-op then).
  const settled = await ctx.db.get(donationId);
  if (settled) await dualWriteGiftForDonation(ctx, settled);

  // A completed Stripe payment proves the donor controls this email.
  if (donation.rsvpId) {
    const rsvp = await ctx.db.get(donation.rsvpId);
    const paidViaStripe =
      stripePaymentIntentId !== undefined ||
      donation.stripeCheckoutSessionId !== undefined;
    if (
      rsvp &&
      paidViaStripe &&
      // Both emails are optional now (imported guests may have none); require
      // a real string on the rsvp so an email-less row never matches an
      // email-less donation via `undefined === undefined`.
      !!rsvp.email &&
      rsvp.email === donation.email &&
      rsvp.emailVerified === false
    ) {
      await ctx.db.patch(rsvp._id, { emailVerified: true });
      await clearEmailCode(ctx, rsvp._id);
    }
  }

  await ctx.scheduler.runAfter(
    0,
    internal.ticketingEmails.sendDonationReceiptEmail,
    { donationId },
  );
  return null;
}

/**
 * Mark a pending donation paid from the Stripe webhook (by session id).
 * Returns whether a donation matched — the shared webhook uses this to know
 * the session was a donation (and to no-op silently when it wasn't). Mirror of
 * `ticketing.markSessionPaid`.
 */
export const markDonationPaid = internalMutation({
  args: { sessionId: v.string(), paymentIntentId: v.optional(v.string()) },
  handler: async (ctx, { sessionId, paymentIntentId }) => {
    const donation = await ctx.db
      .query("donations")
      .withIndex("by_stripe_session", (q) =>
        q.eq("stripeCheckoutSessionId", sessionId),
      )
      .unique();
    if (!donation) return false; // not a donation session — safe no-op
    await fulfillDonation(ctx, donation._id, paymentIntentId);
    return true;
  },
});

/** Expire a pending donation (donor backed out of Stripe checkout). */
export const cancelPendingDonation = internalMutation({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }) => {
    const donation = await ctx.db
      .query("donations")
      .withIndex("by_stripe_session", (q) =>
        q.eq("stripeCheckoutSessionId", sessionId),
      )
      .unique();
    if (donation && donation.status === "pending") {
      await ctx.db.patch(donation._id, { status: "expired" });
    }
    return null;
  },
});

/** Receipt-email payload for a paid donation. */
export const getDonationEmailPayload = internalQuery({
  args: { donationId: v.id("donations") },
  handler: async (ctx, { donationId }) => {
    const donation = await ctx.db.get(donationId);
    if (!donation || !donation.email) return null;
    const event = await ctx.db.get(donation.eventId);
    const page = await ctx.db
      .query("eventPages")
      .withIndex("by_event", (q) => q.eq("eventId", donation.eventId))
      .unique();
    return {
      email: donation.email,
      name: donation.name,
      amountCents: donation.amountCents,
      eventName: event?.name ?? "Event",
      slug: page?.slug ?? null,
    };
  },
});
