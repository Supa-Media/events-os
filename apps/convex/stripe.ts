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
import { action, internalAction } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { rsvpPageUrl, appUrl, sponsorPortalUrl } from "./lib/siteUrl";

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
    // Buyer phone — required for tickets (validated/normalized in prepareOrder).
    phone: v.optional(v.string()),
    token: v.optional(v.string()),
    items: v.array(
      v.object({
        ticketTypeId: v.id("ticketTypes"),
        quantity: v.number(),
        // Per-admission recipient names (index-aligned to quantity). Passed
        // straight through to prepareOrder; never sent to Stripe.
        attendeeNames: v.optional(v.array(v.string())),
      }),
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
      phone: args.phone,
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

/** Result of createRepaymentCheckout: always a Stripe redirect (amount > 0). */
type RepaymentCheckoutResult = { kind: "stripe"; url: string };

/**
 * The Stripe rail for a personal-charge repayment's "card" method
 * (`cards.ts`'s "Stripe repayment" section) — the CALLER'S own outstanding
 * repayments (or a manager paying back on the payer's behalf, mirroring
 * `beginRepayment`'s OR-gate), bundled into ONE Checkout session (one line
 * item per charge), same multi-line-item shape `createCheckout` uses for a
 * ticket cart. Authorization + amount are resolved SERVER-SIDE in
 * `cards.prepareRepaymentCheckout` — the client only ever supplies which
 * repayments it wants to pay, never an amount.
 */
export const createRepaymentCheckout = action({
  args: {
    repaymentIds: v.array(v.id("personalRepayments")),
    /** Which rail. Optional for backward compatibility with any caller that
     *  predates the bank-debit option; card is what they meant. */
    method: v.optional(v.union(v.literal("card"), v.literal("ach"))),
  },
  handler: async (
    ctx,
    { repaymentIds, method },
  ): Promise<RepaymentCheckoutResult> => {
    const rail = method ?? "card";
    const prepared = await ctx.runMutation(
      internal.cards.prepareRepaymentCheckout,
      { repaymentIds, method: rail },
    );

    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new ConvexError({
        code: "PAYMENTS_NOT_CONFIGURED",
        message: "Card repayment isn't available yet — payments are still being set up.",
      });
    }

    // Back to the repayments page, which is where the payer started and where
    // the remaining balance lives — not the Cards tab, which is where this
    // flow USED to be filed before it got its own surface (2026-08-14).
    const returnUrl = appUrl("/finances/repayments");
    if (!returnUrl) {
      // Degrade LOUDLY rather than start a Checkout with no return URL — the
      // same "conditional link ships silently broken" trap this feature was
      // explicitly warned to avoid (see `cards.ts#notifyPersonalChargeFlagged`).
      console.error(
        "[stripe] createRepaymentCheckout: APP_URL is unset — refusing to start a checkout with no return URL",
      );
      throw new ConvexError({
        code: "PAYMENTS_NOT_CONFIGURED",
        message: "Card repayment isn't available yet — payments are still being set up.",
      });
    }

    const body = new URLSearchParams();
    body.set("mode", "payment");
    if (prepared.payerEmail) body.set("customer_email", prepared.payerEmail);
    // Card sessions send NOTHING here and take Stripe's default, so the
    // wallets the account already accepts (Apple/Google Pay — same price as a
    // card) stay available. A bank-debit session pins `us_bank_account`,
    // which is what makes Stripe collect bank credentials instead of a card
    // number. See `cards.stripePaymentMethodTypes`.
    prepared.paymentMethodTypes?.forEach((type, i) => {
      body.set(`payment_method_types[${i}]`, type);
    });
    body.set("success_url", `${returnUrl}?repay=success`);
    body.set("cancel_url", returnUrl);
    // Bundled into ONE session — the webhook reads this back to know which
    // repayments to settle (`http.ts`'s `checkout.session.completed` branch).
    body.set("metadata[repaymentIds]", repaymentIds.join(","));
    // The fee-coverage line's amount, carried so the webhook can subtract it
    // before reconciling Stripe's total against the sum of the debts. Without
    // it, `applyRepaymentPaidFromStripe`'s discrepancy alarm fires on every
    // fee-covered payment (see that mutation's doc).
    if (prepared.feeCents > 0) {
      body.set("metadata[repaymentFeeCents]", String(prepared.feeCents));
    }
    prepared.lines.forEach((line, i) => {
      body.set(`line_items[${i}][quantity]`, "1");
      body.set(`line_items[${i}][price_data][currency]`, "usd");
      body.set(
        `line_items[${i}][price_data][unit_amount]`,
        String(line.amountCents),
      );
      body.set(
        `line_items[${i}][price_data][product_data][name]`,
        `Repayment — ${line.merchantName ?? "personal charge"}`,
      );
    });
    // ONE fee-coverage line for the whole batch, never one per charge —
    // Stripe's fixed 30¢ is per PAYMENT, so per-line coverage would
    // over-collect it on every charge past the first (see
    // `cards.prepareRepaymentCheckout`'s doc). Named with the rate so the
    // payer reads WHY on Stripe's own page, not just a mystery surcharge.
    if (prepared.feeCents > 0) {
      const i = prepared.lines.length;
      body.set(`line_items[${i}][quantity]`, "1");
      body.set(`line_items[${i}][price_data][currency]`, "usd");
      body.set(`line_items[${i}][price_data][unit_amount]`, String(prepared.feeCents));
      body.set(
        `line_items[${i}][price_data][product_data][name]`,
        prepared.feeRateLabel
          ? `Card processing fee (${prepared.feeRateLabel})`
          : "Card processing fee",
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
      console.error("[stripe] repayment checkout session failed:", await response.text());
      throw new ConvexError({
        code: "STRIPE_ERROR",
        message: "Couldn't start checkout. Please try again.",
      });
    }
    const session = (await response.json()) as { id: string; url: string };
    await ctx.runMutation(internal.cards.attachRepaymentStripeSession, {
      repaymentIds,
      sessionId: session.id,
    });
    return { kind: "stripe", url: session.url };
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

/**
 * The NO-LOGIN pay-back checkout — the Stripe half of `repaymentLinks.ts`.
 *
 * Same session shape, same `repaymentIds` metadata, same fee-coverage metadata
 * and therefore the same webhook settling it (`http.ts` →
 * `cards.applyRepaymentPaidFromStripe`). The ONLY difference from
 * `createRepaymentCheckout` is where authority comes from: a token in a URL
 * rather than a signed-in session. Everything after that is deliberately one
 * code path, because two ways to settle money is how the two drift.
 *
 * Line-item names carry an AMOUNT AND NOTHING ELSE. They show on Stripe's own
 * page and on the receipt email, so a merchant or a person's name there would
 * undo the anonymity the link page is built around (founder: "we don't need to
 * put, like, 'hey Michael, you have these charges'").
 */
export const createPublicRepaymentCheckout = action({
  args: {
    token: v.string(),
    repaymentIds: v.array(v.id("personalRepayments")),
    method: v.optional(v.union(v.literal("card"), v.literal("ach"))),
  },
  handler: async (
    ctx,
    { token, repaymentIds, method },
  ): Promise<RepaymentCheckoutResult> => {
    const rail = method ?? "card";
    const prepared = await ctx.runMutation(
      internal.repaymentLinks.preparePublicCheckout,
      { token, repaymentIds, method: rail },
    );

    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new ConvexError({
        code: "PAYMENTS_NOT_CONFIGURED",
        message: "Card payment isn't available yet — payments are still being set up.",
      });
    }
    // Back to the SAME link they came from, which re-reads its own state and
    // shows the thank-you once nothing is left.
    const returnUrl = appUrl(`/pay/${token}`);
    if (!returnUrl) {
      console.error(
        "[stripe] createPublicRepaymentCheckout: APP_URL is unset — refusing to start a checkout with no return URL",
      );
      throw new ConvexError({
        code: "PAYMENTS_NOT_CONFIGURED",
        message: "Payment isn't available yet — payments are still being set up.",
      });
    }

    const body = new URLSearchParams();
    body.set("mode", "payment");
    body.set("success_url", `${returnUrl}?paid=1`);
    body.set("cancel_url", returnUrl);
    body.set("metadata[repaymentIds]", prepared.repaymentIds.join(","));
    if (prepared.feeCents > 0) {
      body.set("metadata[repaymentFeeCents]", String(prepared.feeCents));
    }
    prepared.paymentMethodTypes?.forEach((type, i) => {
      body.set(`payment_method_types[${i}]`, type);
    });
    prepared.lines.forEach((line, i) => {
      body.set(`line_items[${i}][quantity]`, "1");
      body.set(`line_items[${i}][price_data][currency]`, "usd");
      body.set(`line_items[${i}][price_data][unit_amount]`, String(line.amountCents));
      body.set(
        `line_items[${i}][price_data][product_data][name]`,
        `${prepared.chapterName} — personal charge`,
      );
    });
    // ONE fee line for the whole batch — Stripe's fixed component is per
    // PAYMENT, so per-line coverage over-collects it on every charge past the
    // first (see `cards.prepareRepaymentCheckout`'s own note).
    if (prepared.feeCents > 0) {
      const i = prepared.lines.length;
      body.set(`line_items[${i}][quantity]`, "1");
      body.set(`line_items[${i}][price_data][currency]`, "usd");
      body.set(`line_items[${i}][price_data][unit_amount]`, String(prepared.feeCents));
      body.set(
        `line_items[${i}][price_data][product_data][name]`,
        prepared.feeRateLabel
          ? `Processing fee (${prepared.feeRateLabel})`
          : "Processing fee",
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
      console.error(
        "[stripe] public repayment checkout session failed:",
        await response.text(),
      );
      throw new ConvexError({
        code: "STRIPE_ERROR",
        message: "Couldn't start checkout. Please try again.",
      });
    }
    const session = (await response.json()) as { id: string; url: string };
    await ctx.runMutation(internal.repaymentLinks.attachPublicSession, {
      repaymentIds: prepared.repaymentIds,
      sessionId: session.id,
    });
    return { kind: "stripe", url: session.url };
  },
});

/**
 * THE PARTNER PORTAL'S rail — a sponsorship agreement's balance, paid by the
 * partner from the page they signed on (`lib/sponsorPortalPage.ts`).
 *
 * No auth: the portal token IS the authorization, and it authorizes exactly
 * this. Everything that decides the money — is it signed, is this rail offered,
 * is it allowed at this size, how much is actually owed — is resolved
 * SERVER-SIDE in `sponsorPortal.preparePayment`. This action's only job is to
 * turn that answer into a Checkout Session.
 *
 * ── WHY BANK TRANSFER IS USUALLY THE ONLY OPTION ───────────────────────────
 * Stripe's ACH debit is 0.8% capped at $5; a card takes ~2.9% + 30¢ with no cap
 * — $101.80 on a $3,500 Production Partner spot against $5.00. Agreements
 * default to bank-only and the preparer refuses a rail the agreement doesn't
 * offer, so the card branch below only ever runs for a small spot where a
 * manager deliberately turned it on.
 */
/**
 * INTERNAL — called only by the `/api/partner/pay` http route (via runAction),
 * which supplies the trusted last-hop `clientIp` for `preparePayment`'s per-IP
 * rate limit. Not public, so a direct caller cannot forge the IP to bypass it.
 */
export const createSponsorPortalCheckout = internalAction({
  args: {
    token: v.string(),
    method: v.union(v.literal("ach"), v.literal("card")),
    /** A part payment. Omitted = the whole remaining balance. The preparer
     *  clamps it; the client never supplies a ceiling. */
    amountCents: v.optional(v.number()),
    coverFee: v.optional(v.boolean()),
    clientIp: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ kind: "stripe"; url: string }> => {
    const prepared = await ctx.runMutation(
      internal.sponsorPortal.preparePayment,
      {
        token: args.token,
        rail: args.method,
        ...(args.amountCents != null ? { amountCents: args.amountCents } : {}),
        ...(args.coverFee != null ? { coverFee: args.coverFee } : {}),
        ...(args.clientIp ? { clientIp: args.clientIp } : {}),
      },
    );

    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new ConvexError({
        code: "PAYMENTS_NOT_CONFIGURED",
        message: "Online payment isn't available yet — please reply to your contact and we'll invoice you.",
      });
    }

    // Back to the portal itself, which is where the partner started and where
    // the remaining balance lives. Composed from `sponsorPortalPath` so the
    // link they opened, the link the email sent, and the link Stripe returns
    // them to can never be three different pages.
    const returnUrl = sponsorPortalUrl(args.token);
    if (!returnUrl) {
      // Degrade LOUDLY rather than start a Checkout with no return URL — a
      // partner stranded on Stripe's success page with no way back is worse
      // than being told to try later. Same posture as
      // `createRepaymentCheckout`.
      console.error(
        "[stripe] createSponsorPortalCheckout: no public site URL — refusing to start a checkout with no return URL",
      );
      throw new ConvexError({
        code: "PAYMENTS_NOT_CONFIGURED",
        message: "Online payment isn't available yet — please reply to your contact and we'll invoice you.",
      });
    }

    const body = new URLSearchParams();
    body.set("mode", "payment");
    if (prepared.payerEmail) body.set("customer_email", prepared.payerEmail);
    // A bank-debit session pins `us_bank_account`, which is what makes Stripe
    // collect bank credentials instead of a card number. A card session sends
    // nothing and takes Stripe's default so the wallets the account already
    // accepts stay available. Resolved in the preparer; see its doc.
    prepared.paymentMethodTypes?.forEach((type, i) => {
      body.set(`payment_method_types[${i}]`, type);
    });
    body.set("success_url", `${returnUrl}?paid=1`);
    body.set("cancel_url", returnUrl);
    // What the webhook reads back to know what this was. The AMOUNT is never
    // read from metadata on settle — Stripe's own `amount_total` is — but the
    // fee-coverage line is our arithmetic about a line item we added, so it
    // rides here for the settler to subtract.
    body.set("metadata[sponsorshipId]", String(prepared.sponsorshipId));
    body.set("metadata[sponsorIntendedCents]", String(prepared.intendedCents));
    if (prepared.feeCents > 0) {
      body.set("metadata[sponsorFeeCents]", String(prepared.feeCents));
    }

    body.set("line_items[0][quantity]", "1");
    body.set("line_items[0][price_data][currency]", "usd");
    body.set(
      "line_items[0][price_data][unit_amount]",
      String(prepared.intendedCents),
    );
    body.set(
      "line_items[0][price_data][product_data][name]",
      `${prepared.title} — ${prepared.orgName}`,
    );
    // ONE fee-coverage line, named with the rate so the partner reads WHY on
    // Stripe's own page rather than seeing a mystery surcharge.
    if (prepared.feeCents > 0) {
      body.set("line_items[1][quantity]", "1");
      body.set("line_items[1][price_data][currency]", "usd");
      body.set("line_items[1][price_data][unit_amount]", String(prepared.feeCents));
      body.set(
        "line_items[1][price_data][product_data][name]",
        prepared.feeRateLabel
          ? `Processing fee (${prepared.feeRateLabel})`
          : "Processing fee",
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
      console.error(
        "[stripe] sponsor portal checkout session failed:",
        await response.text(),
      );
      throw new ConvexError({
        code: "STRIPE_ERROR",
        message: "Couldn't start checkout. Please try again.",
      });
    }
    const session = (await response.json()) as { id: string; url: string };
    return { kind: "stripe", url: session.url };
  },
});
