/**
 * One-time "give" donations (Territories `/give` redesign) — a single,
 * no-subscription gift from the public giving map or a territory page.
 * Mirrors `givingPledges.ts`'s recurring-backer machinery 1:1, but
 * `mode=payment` instead of `mode=subscription`, and settles into the SAME
 * `gifts` ledger through the SAME `recordGiftForDonor` write path
 * (`lib/givingDonors.ts`) every other giving channel uses.
 *
 * House Stripe style (mirrors `stripe.ts`/`givingPledges.ts`): REST over
 * `fetch` in the default Convex runtime — no SDK, no `"use node"`. Card data
 * never touches our code (Stripe-hosted Checkout). The settled amount is ALWAYS
 * read from the Stripe session's `amount_total` on webhook settle — never a
 * client-supplied value.
 *
 * Flow:
 *   startGiveDonationCheckout (public action) → prepareGiveDonation (match-or-
 *   create the donor, no gift yet) → Stripe Checkout `mode=payment` → the
 *   shared `/stripe/webhook` fan-out in http.ts calls `recordGiveDonationPaid`
 *   on `checkout.session.completed` BEFORE the ticket/order/pledge fan-out
 *   (`metadata.giveDonation === "1"` is this flow's marker — a safe no-op for
 *   every other session, which carries no such metadata).
 *
 * Scope: a `slug` resolves to a territory's chapter (`resolveTerritoryForCheckout`
 * — prospect/raising territories resolve to their shadow chapter, exactly like
 * `preparePledge`); no slug (or an unbackable one) is a friendly error at the
 * action, and an ABSENT slug scopes to `"central"` (general ministry giving —
 * distinct from a pledge, which always backs a real chapter).
 *
 * No gift is recorded until the money settles — `prepareGiveDonation` only
 * match-or-creates the donor, so an abandoned checkout never shows up in the
 * ledger.
 */
import { action, internalMutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { normalizeEmail } from "./lib/access";
import {
  assertPositiveGiftCents,
  matchOrCreateDonor,
  recordGiftForDonor,
} from "./lib/givingDonors";
import type { GivingScope } from "./lib/givingAccess";
import { siteUrl, givePagePath } from "./lib/siteUrl";

const STRIPE_API = "https://api.stripe.com/v1";

const scopeValidator = v.union(v.id("chapters"), v.literal("central"));

// ── Public: start the one-time give checkout ─────────────────────────────────

/**
 * PUBLIC entry point for the one-time "just give" flow (no auth — like
 * `givingPledges.startPledgeCheckout` / `stripe.createDonationCheckout`).
 * Resolves `slug` to a chapter (a territory-backed gift) or falls back to
 * `"central"` (a general-ministry gift, no slug), match-or-creates the donor
 * via `prepareGiveDonation`, then opens a Stripe Checkout Session in
 * `mode=payment` with a single inline one-time price line. `metadata` carries
 * `giveDonation`/`giveDonorId`/`giveScope` so `checkout.session.completed` can
 * settle it (`recordGiveDonationPaid`) without any pending row of our own.
 */
export const startGiveDonationCheckout = action({
  args: {
    slug: v.optional(v.string()),
    amountCents: v.number(),
    name: v.string(),
    email: v.string(),
  },
  handler: async (ctx, args): Promise<{ url: string }> => {
    const slug = args.slug?.trim() || undefined;

    let scope: GivingScope = "central";
    if (slug) {
      const resolved: { chapterId: Id<"chapters"> } | null =
        await ctx.runQuery(internal.territories.resolveTerritoryForCheckout, {
          slug,
        });
      if (!resolved) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "That territory isn't available for giving right now.",
        });
      }
      scope = resolved.chapterId;
    }

    const prepared: {
      donorId: Id<"donors">;
      amountCents: number;
      chapterName?: string;
    } = await ctx.runMutation(internal.givingDonations.prepareGiveDonation, {
      scope,
      amountCents: args.amountCents,
      name: args.name,
      email: args.email,
    });

    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new ConvexError({
        code: "PAYMENTS_NOT_CONFIGURED",
        message: "Giving isn't available yet — payments are still being set up.",
      });
    }

    // Return to the same give page (map or territory) with a thank-you flag;
    // the cancel path returns to the same page with no flag at all.
    const base = siteUrl();
    const returnPath = givePagePath(slug);
    const body = new URLSearchParams();
    body.set("mode", "payment");
    body.set("customer_email", args.email.trim().toLowerCase());
    body.set("success_url", `${base}${returnPath}?donated=1`);
    body.set("cancel_url", `${base}${returnPath}`);
    body.set("metadata[giveDonation]", "1");
    body.set("metadata[giveDonorId]", String(prepared.donorId));
    body.set("metadata[giveScope]", String(scope));
    // Inline one-time price — no recurring interval (unlike the pledge flow).
    body.set("line_items[0][quantity]", "1");
    body.set("line_items[0][price_data][currency]", "usd");
    body.set(
      "line_items[0][price_data][unit_amount]",
      String(prepared.amountCents),
    );
    body.set(
      "line_items[0][price_data][product_data][name]",
      `One-time gift — ${prepared.chapterName ?? "Public Worship"}`,
    );

    const response = await fetch(`${STRIPE_API}/checkout/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!response.ok) {
      console.error("[stripe] give donation session failed:", await response.text());
      throw new ConvexError({
        code: "STRIPE_ERROR",
        message: "Couldn't start your gift. Please try again.",
      });
    }
    const session = (await response.json()) as { id: string; url: string };
    return { url: session.url };
  },
});

/**
 * Validate a one-time gift and match-or-create its donor. Called by
 * `startGiveDonationCheckout` right before Stripe. Mirrors `givingPledges
 * .preparePledge` minus the pledge-floor guard (a one-time gift has no $20
 * minimum — `assertPositiveGiftCents` is the only bound, same as
 * `giving.prepareDonation`'s card donations) and minus the incomplete-row
 * insert: NO `gifts` row is written here — the settle-time webhook
 * (`recordGiveDonationPaid`) is the only place a one-time gift is recorded, so
 * an abandoned checkout leaves no trace.
 *
 * Donor `source` is always `"map"` — every one-time give (central or
 * territory-scoped) originates from the public give page, unlike a pledge
 * (which distinguishes a shadow-chapter map signup from a live chapter's
 * direct one).
 */
export const prepareGiveDonation = internalMutation({
  args: {
    scope: scopeValidator,
    amountCents: v.number(),
    name: v.string(),
    email: v.string(),
  },
  handler: async (ctx, args) => {
    assertPositiveGiftCents(args.amountCents);
    const name = args.name.trim();
    const email = normalizeEmail(args.email);
    if (!name || !email || !email.includes("@")) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "A name and valid email are required.",
      });
    }

    let chapterName: string | undefined;
    if (args.scope !== "central") {
      const chapter = await ctx.db.get(args.scope);
      if (!chapter) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "That territory isn't available for giving.",
        });
      }
      chapterName = chapter.name;
    }

    const donorId = await matchOrCreateDonor(ctx, {
      scope: args.scope as GivingScope,
      name,
      email,
      source: "map",
    });

    return {
      donorId,
      amountCents: args.amountCents,
      ...(chapterName ? { chapterName } : {}),
    };
  },
});

// ── Webhook handler (internal, idempotent, wired into /stripe/webhook) ───────

/**
 * Settle a one-time gift from `checkout.session.completed` (called BEFORE the
 * ticket/order/pledge fan-out — see `http.ts`). Records ONE `gifts` row via
 * the shared `recordGiftForDonor` write path — the same single choke point
 * every giving channel uses — idempotent on `externalRef = "give:" +
 * sessionId` (checked against `gifts.by_externalRef` first, mirroring
 * `recordPledgeInvoice`'s `stripeInvoiceId` dedup). The amount is read from
 * the Stripe session's `amount_total` (`amountTotalCents` here) — NEVER a
 * client-supplied value.
 *
 * `donorId` arrives as a metadata STRING (Stripe session metadata is always
 * strings) and is normalized via `ctx.db.normalizeId` — a malformed/foreign id
 * (a session that isn't ours, or a donor since deleted) is a safe no-op,
 * mirroring `activatePledgeFromCheckout`'s `normalizeId` guard. `scope` is
 * accepted for webhook-metadata symmetry (and easy log correlation) but is
 * NOT itself used to route the write: `recordGiftForDonor` always derives the
 * gift's `scope` from the donor doc, which is the source of truth.
 *
 * Returns `true` iff this call recorded a NEW gift (false for a no-op —
 * invalid donor, or an already-recorded session).
 */
export const recordGiveDonationPaid = internalMutation({
  args: {
    sessionId: v.string(),
    amountTotalCents: v.number(),
    donorId: v.string(),
    scope: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    void args.scope; // symmetry/logging only — recordGiftForDonor derives scope from the donor.

    const donorId = ctx.db.normalizeId("donors", args.donorId);
    if (!donorId) return false; // not one of our donor ids — safe no-op
    const donor = await ctx.db.get(donorId);
    if (!donor) return false; // donor since deleted — safe no-op

    // Idempotent: a redelivered completion doesn't double-record.
    const externalRef = `give:${args.sessionId}`;
    const existing = await ctx.db
      .query("gifts")
      .withIndex("by_externalRef", (q) => q.eq("externalRef", externalRef))
      .first();
    if (existing) return false;

    // Trust only the session's own settled amount. A zero/negative/non-integer
    // amount (a malformed payload) records no gift but still no-ops cleanly.
    if (
      !Number.isInteger(args.amountTotalCents) ||
      args.amountTotalCents <= 0
    ) {
      return false;
    }

    await recordGiftForDonor(ctx, {
      donorId,
      amountCents: args.amountTotalCents,
      receivedAt: Date.now(),
      // Card payments settle through Stripe — the gifts ledger's vocabulary
      // has no separate "card" literal (see `GIFT_METHODS`); every other
      // Stripe-settled gift (a pledge's billing cycle, `donationMethodToGift`'s
      // event-donation mapping) records `method: "stripe"` too.
      method: "stripe",
      externalRef,
      note: "One-time gift via /give",
    });
    return true;
  },
});
