/**
 * Stripe integration — Checkout Sessions over Stripe's REST API via `fetch`
 * (default Convex runtime; no SDK, no "use node"). Card details never touch
 * our code: buyers pay on Stripe-hosted Checkout and return to the RSVP page.
 *
 * Flow: landing page → `createCheckout` (validates cart, pending order) →
 * Stripe-hosted payment → `checkout.session.completed` webhook (http.ts) →
 * `ticketing.markSessionPaid` issues tickets + emails them.
 *
 * Env: STRIPE_SECRET_KEY (sk_test_... to start), STRIPE_WEBHOOK_SECRET.
 * Free carts skip Stripe entirely and fulfill immediately.
 */
import { action } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { rsvpPageUrl } from "./lib/siteUrl";

const STRIPE_API = "https://api.stripe.com/v1";

/** Result of createCheckout: either done (free) or a Stripe redirect. */
type CheckoutResult =
  | { kind: "free"; token: string; needsEmailVerification: boolean }
  | { kind: "stripe"; url: string; token: string };

/**
 * PUBLIC entry point for the landing page's "Get tickets" flow. No auth —
 * the published page + on-sale ticket types are the access control
 * (validated inside `prepareOrder`).
 */
export const createCheckout = action({
  args: {
    slug: v.string(),
    name: v.string(),
    email: v.string(),
    token: v.optional(v.string()),
    items: v.array(
      v.object({ ticketTypeId: v.id("ticketTypes"), quantity: v.number() }),
    ),
    // Optional add-on gift bundled into this SAME checkout (the "also want
    // to donate?" upsell) — one card charge, split on fulfillment into ticket
    // revenue + a gift. Absent/0 = tickets only (today's behavior).
    donationCents: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<CheckoutResult> => {
    const prepared = await ctx.runMutation(internal.ticketing.prepareOrder, {
      slug: args.slug,
      name: args.name,
      email: args.email,
      token: args.token,
      items: args.items,
      donationCents: args.donationCents,
    });

    // Free path only when there's truly nothing to charge — a $0 cart with an
    // add-on donation still needs a real Stripe charge for the donation.
    if (prepared.totalCents === 0 && prepared.donationCents === 0) {
      await ctx.runMutation(internal.ticketing.fulfillOrder, {
        orderId: prepared.orderId,
      });
      return {
        kind: "free",
        token: prepared.guestToken,
        needsEmailVerification: prepared.needsEmailVerification,
      };
    }

    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new ConvexError({
        code: "PAYMENTS_NOT_CONFIGURED",
        message:
          "Paid tickets aren't available yet — payments are still being set up.",
      });
    }

    // Stripe's REST API takes form-encoded bodies with bracketed array keys.
    const body = new URLSearchParams();
    body.set("mode", "payment");
    body.set("customer_email", args.email.trim().toLowerCase());
    body.set(
      "success_url",
      `${rsvpPageUrl(args.slug)}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    );
    body.set("cancel_url", `${rsvpPageUrl(args.slug)}?checkout=canceled`);
    body.set("metadata[orderId]", String(prepared.orderId));
    prepared.lines.forEach((line, i) => {
      body.set(`line_items[${i}][quantity]`, String(line.quantity));
      body.set(`line_items[${i}][price_data][currency]`, "usd");
      body.set(
        `line_items[${i}][price_data][unit_amount]`,
        String(line.unitPriceCents),
      );
      body.set(
        `line_items[${i}][price_data][product_data][name]`,
        `${prepared.eventName} — ${line.name}`,
      );
    });
    // Add-on donation: ONE extra line item in the SAME session, same shape as
    // `createDonationCheckout`'s line — kept split so the buyer sees exactly
    // what they're paying for even though it settles as one card charge.
    if (prepared.donationCents > 0) {
      const i = prepared.lines.length;
      body.set(`line_items[${i}][quantity]`, "1");
      body.set(`line_items[${i}][price_data][currency]`, "usd");
      body.set(
        `line_items[${i}][price_data][unit_amount]`,
        String(prepared.donationCents),
      );
      body.set(
        `line_items[${i}][price_data][product_data][name]`,
        `Donation — ${prepared.eventName}`,
      );
    }

    const response = await fetch(`${STRIPE_API}/checkout/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!response.ok) {
      console.error("[stripe] checkout session failed:", await response.text());
      throw new ConvexError({
        code: "STRIPE_ERROR",
        message: "Couldn't start checkout. Please try again.",
      });
    }
    const session = (await response.json()) as { id: string; url: string };
    await ctx.runMutation(internal.ticketing.attachStripeSession, {
      orderId: prepared.orderId,
      sessionId: session.id,
    });
    return { kind: "stripe", url: session.url, token: prepared.guestToken };
  },
});

/** Result of createDonationCheckout: always a Stripe redirect (amount > 0). */
type DonationResult = { kind: "stripe"; url: string; token: string };

/**
 * PUBLIC entry point for the landing page's "Give" flow. No auth — the
 * published page + `givingEnabled` are the access control (validated inside
 * `prepareDonation`). Always a Stripe redirect: donations are always > 0, so
 * there is no free path. Mirrors `createCheckout`.
 */
export const createDonationCheckout = action({
  args: {
    slug: v.string(),
    name: v.string(),
    email: v.string(),
    amountCents: v.number(),
    token: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<DonationResult> => {
    const prepared = await ctx.runMutation(internal.giving.prepareDonation, {
      slug: args.slug,
      name: args.name,
      email: args.email,
      amountCents: args.amountCents,
      token: args.token,
    });

    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new ConvexError({
        code: "PAYMENTS_NOT_CONFIGURED",
        message:
          "Giving isn't available yet — payments are still being set up.",
      });
    }

    // One line item: the donation itself.
    const body = new URLSearchParams();
    body.set("mode", "payment");
    body.set("customer_email", args.email.trim().toLowerCase());
    body.set("success_url", `${rsvpPageUrl(args.slug)}?donated=1`);
    body.set("cancel_url", rsvpPageUrl(args.slug));
    body.set("metadata[donationId]", String(prepared.donationId));
    body.set("line_items[0][quantity]", "1");
    body.set("line_items[0][price_data][currency]", "usd");
    body.set(
      "line_items[0][price_data][unit_amount]",
      String(prepared.amountCents),
    );
    body.set(
      "line_items[0][price_data][product_data][name]",
      `Donation — ${prepared.eventName}`,
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
      console.error("[stripe] donation session failed:", await response.text());
      throw new ConvexError({
        code: "STRIPE_ERROR",
        message: "Couldn't start your donation. Please try again.",
      });
    }
    const session = (await response.json()) as { id: string; url: string };
    await ctx.runMutation(internal.giving.attachDonationSession, {
      donationId: prepared.donationId,
      sessionId: session.id,
    });
    return { kind: "stripe", url: session.url, token: prepared.guestToken };
  },
});

// ── Webhook signature verification (used by http.ts) ────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Verify a `Stripe-Signature` header against the raw payload:
 * HMAC-SHA256(`${t}.${payload}`) with the webhook signing secret, constant-time
 * compare against every `v1` candidate, 5-minute timestamp tolerance.
 */
export async function verifyStripeSignature(
  payload: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader) return false;
  const parts = new Map<string, string[]>();
  for (const kv of signatureHeader.split(",")) {
    const [k, val] = kv.split("=", 2);
    if (!k || !val) continue;
    const list = parts.get(k.trim()) ?? [];
    list.push(val.trim());
    parts.set(k.trim(), list);
  }
  const timestamp = Number(parts.get("t")?.[0]);
  const candidates = parts.get("v1") ?? [];
  if (!Number.isFinite(timestamp) || candidates.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${timestamp}.${payload}`),
    ),
  );

  for (const candidate of candidates) {
    if (candidate.length !== mac.length * 2) continue;
    const candidateBytes = hexToBytes(candidate);
    let diff = 0;
    for (let i = 0; i < mac.length; i++) diff |= mac[i] ^ candidateBytes[i];
    if (diff === 0) return true;
  }
  return false;
}
