import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
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

/** Map a thrown ConvexError to its friendly message (generic fallback). */
function errorJson(err: unknown): Response {
  const message =
    (err as { data?: { message?: string } })?.data?.message ??
    "Something went wrong. Please try again.";
  return json({ error: message }, 400);
}

type JsonBody = Record<string, unknown>;

/**
 * Wrap a public JSON POST endpoint: parse the body, run the handler, return its
 * result as JSON (or `{ ok: true }` for handlers that return nothing), and map
 * any thrown ConvexError to a 400. Every /api/tickets/* route shares this shape.
 */
function jsonPost(run: (ctx: ActionCtx, body: JsonBody) => Promise<unknown>) {
  return httpAction(async (ctx, req) => {
    try {
      const body = (await req.json()) as JsonBody;
      return json((await run(ctx, body)) ?? { ok: true });
    } catch (err) {
      return errorJson(err);
    }
  });
}

/** Optional string field from an untrusted JSON body. */
function optStr(value: unknown): string | undefined {
  return value ? String(value) : undefined;
}

/** Coerce an untrusted cart payload into checkout line items (validated server-side). */
function toCartItems(
  raw: unknown,
): Array<{ ticketTypeId: Id<"ticketTypes">; quantity: number }> {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => ({
    ticketTypeId: (item as { ticketTypeId: Id<"ticketTypes"> }).ticketTypeId,
    quantity: Number((item as { quantity: unknown }).quantity),
  }));
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
  handler: jsonPost((ctx, body) =>
    ctx.runMutation(api.ticketing.submitRsvp, {
      slug: String(body.slug ?? ""),
      name: optStr(body.name),
      email: optStr(body.email),
      phone: optStr(body.phone),
      status: body.status as "going" | "maybe" | "not_going",
      token: optStr(body.token),
    }),
  ),
});

http.route({
  path: "/api/tickets/comment",
  method: "POST",
  handler: jsonPost((ctx, body) =>
    ctx.runMutation(api.ticketing.addComment, {
      slug: String(body.slug ?? ""),
      token: String(body.token ?? ""),
      body: String(body.body ?? ""),
      parentId: body.parentId as never,
      replyToRsvpId: body.replyToRsvpId as never,
    }),
  ),
});

http.route({
  path: "/api/tickets/react",
  method: "POST",
  handler: jsonPost((ctx, body) =>
    ctx.runMutation(api.ticketing.toggleReaction, {
      slug: String(body.slug ?? ""),
      token: String(body.token ?? ""),
      targetType: body.targetType as "rsvp" | "comment",
      targetId: String(body.targetId ?? ""),
      emoji: String(body.emoji ?? ""),
    }),
  ),
});

http.route({
  path: "/api/tickets/checkout",
  method: "POST",
  handler: jsonPost((ctx, body) =>
    ctx.runAction(api.stripe.createCheckout, {
      slug: String(body.slug ?? ""),
      name: String(body.name ?? ""),
      email: String(body.email ?? ""),
      token: optStr(body.token),
      items: toCartItems(body.items),
    }),
  ),
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
