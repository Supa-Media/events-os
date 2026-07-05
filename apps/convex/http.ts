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
import { registerTicketApiRoutes } from "./lib/ticketApiRoutes";
import { siteUrl } from "./lib/siteUrl";
import { verifyStripeSignature } from "./stripe";

const http = httpRouter();

// Auth routes (handles OTP verification callbacks)
auth.addHttpRoutes(http);

// JSON API for the landing page's client script (/api/tickets/*).
registerTicketApiRoutes(http);

// ── Helpers ──────────────────────────────────────────────────────────────────

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
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
