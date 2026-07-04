import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { auth } from "./auth";
import {
  renderIcs,
  renderLandingPage,
  renderNotFound,
  renderTicketPage,
} from "./lib/landingPage";
import { verifyStripeSignature } from "./stripe";

const http = httpRouter();

// Auth routes (handles OTP verification callbacks)
auth.addHttpRoutes(http);

// ── Helpers ──────────────────────────────────────────────────────────────────

function siteUrl(): string {
  return (process.env.CONVEX_SITE_URL ?? "").replace(/\/$/, "");
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Map thrown ConvexErrors to a friendly JSON error payload. */
function errorJson(err: unknown): Response {
  const data = (err as { data?: { message?: string } })?.data;
  const message =
    data?.message ??
    (err instanceof Error && !err.message.includes("Uncaught")
      ? "Something went wrong. Please try again."
      : "Something went wrong. Please try again.");
  return json({ error: message }, 400);
}

// ── Public event pages: /e/<slug>[/cover|/calendar.ics] ─────────────────────

http.route({
  pathPrefix: "/e/",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean); // ["e", slug, ...]
    const slug = decodeURIComponent(segments[1] ?? "");
    const sub = segments[2] ?? null;
    if (!slug) return html(renderNotFound(), 404);

    // Cover image — public so OG scrapers (iMessage) can fetch it.
    if (sub === "cover") {
      const storageId = await ctx.runQuery(
        internal.ticketing.getCoverStorageId,
        { slug },
      );
      if (!storageId) return new Response("Not found", { status: 404 });
      const blob = await ctx.storage.get(storageId);
      if (!blob) return new Response("Not found", { status: 404 });
      return new Response(blob, {
        headers: {
          "Content-Type": blob.type || "image/jpeg",
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    const page = await ctx.runQuery(api.ticketing.getPublicPage, { slug });
    if (!page) return html(renderNotFound(), 404);

    if (sub === "calendar.ics") {
      const ics = renderIcs({
        slug,
        eventName: page.eventName,
        startDate: page.startDate,
        endDate: page.endDate,
        venueName: page.venueName,
        address: page.address,
        description: page.tagline,
        siteUrl: siteUrl(),
      });
      return new Response(ics, {
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Content-Disposition": `attachment; filename="${slug}.ics"`,
        },
      });
    }

    if (sub) return html(renderNotFound(), 404);
    return html(renderLandingPage(page, siteUrl()));
  }),
});

// ── Public ticket page: /t/<code> ────────────────────────────────────────────

http.route({
  pathPrefix: "/t/",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const code = decodeURIComponent(url.pathname.split("/").filter(Boolean)[1] ?? "");
    const ticket = code
      ? await ctx.runQuery(api.ticketing.getPublicTicket, { code })
      : null;
    if (!ticket) return html(renderNotFound(), 404);
    return html(renderTicketPage(ticket, siteUrl()));
  }),
});

// ── JSON API for the landing page's client script ────────────────────────────

http.route({
  path: "/api/tickets/page",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const slug = url.searchParams.get("slug") ?? "";
    const token = url.searchParams.get("token") ?? undefined;
    const page = await ctx.runQuery(api.ticketing.getPublicPage, {
      slug,
      token,
    });
    if (!page) return json({ error: "Not found" }, 404);
    return json(page);
  }),
});

http.route({
  path: "/api/tickets/rsvp",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    try {
      const body = await req.json();
      const result = await ctx.runMutation(api.ticketing.submitRsvp, {
        slug: String(body.slug ?? ""),
        name: body.name ? String(body.name) : undefined,
        email: body.email ? String(body.email) : undefined,
        phone: body.phone ? String(body.phone) : undefined,
        status: body.status,
        token: body.token ? String(body.token) : undefined,
      });
      return json(result);
    } catch (err) {
      return errorJson(err);
    }
  }),
});

http.route({
  path: "/api/tickets/comment",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    try {
      const body = await req.json();
      await ctx.runMutation(api.ticketing.addComment, {
        slug: String(body.slug ?? ""),
        token: String(body.token ?? ""),
        body: String(body.body ?? ""),
        parentId: body.parentId ?? undefined,
        replyToRsvpId: body.replyToRsvpId ?? undefined,
      });
      return json({ ok: true });
    } catch (err) {
      return errorJson(err);
    }
  }),
});

http.route({
  path: "/api/tickets/react",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    try {
      const body = await req.json();
      const result = await ctx.runMutation(api.ticketing.toggleReaction, {
        slug: String(body.slug ?? ""),
        token: String(body.token ?? ""),
        targetType: body.targetType,
        targetId: String(body.targetId ?? ""),
        emoji: String(body.emoji ?? ""),
      });
      return json(result);
    } catch (err) {
      return errorJson(err);
    }
  }),
});

http.route({
  path: "/api/tickets/checkout",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    try {
      const body = await req.json();
      const result = await ctx.runAction(api.stripe.createCheckout, {
        slug: String(body.slug ?? ""),
        name: String(body.name ?? ""),
        email: String(body.email ?? ""),
        token: body.token ? String(body.token) : undefined,
        items: Array.isArray(body.items)
          ? body.items.map((i: { ticketTypeId: string; quantity: number }) => ({
              ticketTypeId: i.ticketTypeId,
              quantity: Number(i.quantity),
            }))
          : [],
      });
      return json(result);
    } catch (err) {
      return errorJson(err);
    }
  }),
});

// ── Stripe webhook ───────────────────────────────────────────────────────────

http.route({
  path: "/stripe/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      console.error("[stripe] STRIPE_WEBHOOK_SECRET not set");
      return new Response("Not configured", { status: 500 });
    }
    const payload = await req.text();
    const valid = await verifyStripeSignature(
      payload,
      req.headers.get("Stripe-Signature"),
      secret,
    );
    if (!valid) return new Response("Invalid signature", { status: 400 });

    const event = JSON.parse(payload) as {
      type: string;
      data: { object: { id: string; payment_intent?: string | null } };
    };
    if (event.type === "checkout.session.completed") {
      await ctx.runMutation(internal.ticketing.markSessionPaid, {
        sessionId: event.data.object.id,
        paymentIntentId: event.data.object.payment_intent ?? undefined,
      });
    } else if (event.type === "checkout.session.expired") {
      await ctx.runMutation(internal.ticketing.cancelPendingOrder, {
        sessionId: event.data.object.id,
      });
    }
    return new Response("ok", { status: 200 });
  }),
});

export default http;
