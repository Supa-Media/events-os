/**
 * The landing page's same-origin JSON API: every /api/tickets/* route the
 * client script (landingPageClient.ts) calls. Registered onto the main router
 * by http.ts via `registerTicketApiRoutes`.
 */
import type { HttpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { httpAction } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

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

export function registerTicketApiRoutes(http: HttpRouter): void {
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
    path: "/api/tickets/verify-email",
    method: "POST",
    handler: jsonPost(async (ctx, body) => {
      const result = await ctx.runMutation(
        api.ticketingVerification.verifyRsvpEmail,
        {
          slug: String(body.slug ?? ""),
          token: String(body.token ?? ""),
          code: String(body.code ?? ""),
        },
      );
      // A wrong code is a soft failure (so the attempt count persists);
      // surface it to the client as the same 400 shape as thrown errors.
      if (!result.ok) throw new ConvexError({ message: result.error });
      return result;
    }),
  });

  http.route({
    path: "/api/tickets/resend-code",
    method: "POST",
    handler: jsonPost((ctx, body) =>
      ctx.runMutation(api.ticketingVerification.resendRsvpEmailCode, {
        slug: String(body.slug ?? ""),
        token: String(body.token ?? ""),
      }),
    ),
  });

  // Phone verification (Attendance F) — the SMS mirror of verify-email /
  // resend-code, plus begin-phone (phone verification has no public submission
  // entry yet, so a phone guest starts the flow explicitly).
  http.route({
    path: "/api/tickets/begin-phone",
    method: "POST",
    handler: jsonPost((ctx, body) =>
      ctx.runMutation(api.ticketingVerification.beginRsvpPhoneVerification, {
        slug: String(body.slug ?? ""),
        token: String(body.token ?? ""),
      }),
    ),
  });

  http.route({
    path: "/api/tickets/verify-phone",
    method: "POST",
    handler: jsonPost(async (ctx, body) => {
      const result = await ctx.runMutation(
        api.ticketingVerification.verifyRsvpPhone,
        {
          slug: String(body.slug ?? ""),
          token: String(body.token ?? ""),
          code: String(body.code ?? ""),
        },
      );
      // A wrong code is a soft failure (so the attempt count persists);
      // surface it as the same 400 shape as thrown errors.
      if (!result.ok) throw new ConvexError({ message: result.error });
      return result;
    }),
  });

  http.route({
    path: "/api/tickets/resend-phone-code",
    method: "POST",
    handler: jsonPost((ctx, body) =>
      ctx.runMutation(api.ticketingVerification.resendRsvpPhoneCode, {
        slug: String(body.slug ?? ""),
        token: String(body.token ?? ""),
      }),
    ),
  });

  // Guest sign-in: look up a guest by email/phone, send a code, then trade the
  // code for their guest token. `start` always returns {ok:true} (no
  // enumeration); `verify` returns {token} or the same generic 400 as a wrong
  // code. `method` is coerced to the "email"|"phone" union the mutation accepts.
  http.route({
    path: "/api/tickets/signin-start",
    method: "POST",
    handler: jsonPost((ctx, body) =>
      ctx.runMutation(api.ticketingVerification.startGuestSignIn, {
        slug: String(body.slug ?? ""),
        method: body.method === "phone" ? "phone" : "email",
        contact: String(body.contact ?? ""),
      }),
    ),
  });

  http.route({
    path: "/api/tickets/signin-verify",
    method: "POST",
    handler: jsonPost(async (ctx, body) => {
      const result = await ctx.runMutation(
        api.ticketingVerification.verifyGuestSignIn,
        {
          slug: String(body.slug ?? ""),
          method: body.method === "phone" ? "phone" : "email",
          contact: String(body.contact ?? ""),
          code: String(body.code ?? ""),
        },
      );
      // Wrong/expired code (or unknown contact) is a soft failure so attempt
      // counts persist — surface it as the same 400 shape as thrown errors.
      if (!result.ok) throw new ConvexError({ message: result.error });
      return result;
    }),
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
        phone: optStr(body.phone),
        token: optStr(body.token),
        items: toCartItems(body.items),
        // Optional add-on gift bundled into the SAME checkout (the "also
        // donate?" upsell) — undefined/absent means tickets only.
        donationCents:
          body.donationCents === undefined
            ? undefined
            : Math.floor(Number(body.donationCents)),
      }),
    ),
  });

  http.route({
    path: "/api/tickets/donate",
    method: "POST",
    handler: jsonPost((ctx, body) =>
      ctx.runAction(api.stripe.createDonationCheckout, {
        slug: String(body.slug ?? ""),
        name: String(body.name ?? ""),
        email: String(body.email ?? ""),
        amountCents: Math.floor(Number(body.amountCents)),
        token: optStr(body.token),
      }),
    ),
  });
}
