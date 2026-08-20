/**
 * The partner portal's same-origin JSON API — every `/api/partner/*` route the
 * client script in `sponsorPortalPage.ts` calls, registered onto the main
 * router by http.ts via `registerSponsorPortalApiRoutes`.
 *
 * Mirrors `contractApiRoutes.ts` deliberately: the same `jsonPost` wrapper, the
 * same ConvexError → 400 mapping, the same last-hop IP extraction. These are
 * the same kind of endpoint with the same threat model, and a second style of
 * public endpoint is a second set of mistakes.
 *
 * NO AUTH on any of these. A sponsorship's secret portal token scopes
 * everything, and it authorizes exactly two acts: signing that one agreement
 * and paying it.
 *
 * ── WHAT THESE ROUTES CANNOT CARRY ──────────────────────────────────────────
 * Note what is absent from the payloads forwarded below: the amount owed, the
 * terms, the benefits, the commitments, the title. `signAgreement` and
 * `preparePayment` have no parameters for any of them — the agreement is the
 * org's testimony and is unrepresentable here, so a crafted POST cannot edit
 * what somebody is signing or move the price of what they are paying. This file
 * does not filter those keys out; there is nothing to filter them into.
 *
 * `amountCents` IS forwarded, and is the one exception that proves the rule:
 * it can only make a payment SMALLER. `preparePayment` clamps it to
 * `(0, balance]` after resolving the balance server-side, so the worst a
 * crafted value achieves is paying part of what is owed — which is a thing the
 * page offers anyway.
 */
import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { api, internal } from "../_generated/api";

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

function jsonPost(
  run: (ctx: ActionCtx, body: JsonBody, req: Request) => Promise<unknown>,
) {
  return httpAction(async (ctx, req) => {
    try {
      const body = (await req.json()) as JsonBody;
      return json((await run(ctx, body, req)) ?? { ok: true });
    } catch (err) {
      return errorJson(err);
    }
  });
}

/** The caller's IP from standard proxy headers. `x-forwarded-for` is a
 *  comma-separated hop chain that proxies APPEND to, so the LAST entry is the
 *  address the platform's own edge proxy observed — the one entry a client
 *  cannot spoof. Character-for-character the same as
 *  `contractApiRoutes.ts`'s; if the hop reasoning ever changes, both move
 *  together. */
function clientIpFromRequest(req: Request): string | undefined {
  const forwarded = req.headers.get("x-forwarded-for");
  const last = forwarded
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();
  if (last) return last;
  const real = req.headers.get("x-real-ip")?.trim();
  return real || undefined;
}

function optStr(value: unknown): string | undefined {
  return value ? String(value) : undefined;
}

export function registerSponsorPortalApiRoutes(http: HttpRouter): void {
  // "They opened it." Fire-and-forget read receipt; always answers 200 so a
  // failure here can never look to the page like a broken agreement.
  http.route({
    path: "/api/partner/viewed",
    method: "POST",
    handler: jsonPost(async (ctx, body) => {
      await ctx.runMutation(api.sponsorPortal.noteView, {
        token: String(body.token ?? ""),
      });
      return { ok: true };
    }),
  });

  // The partner signs → { signedAt, termsVersion }.
  //
  // `clientIp` is forwarded so the mutation can rate-limit per IP and stamp
  // `signedIp` on the signature — a Convex mutation cannot read a request
  // header for itself, which is the whole reason this hop exists.
  http.route({
    path: "/api/partner/sign",
    method: "POST",
    handler: jsonPost(async (ctx, body, req) => {
      return await ctx.runMutation(internal.sponsorPortal.signAgreement, {
        token: String(body.token ?? ""),
        name: String(body.name ?? ""),
        title: optStr(body.title),
        email: optStr(body.email),
        clientIp: clientIpFromRequest(req),
      });
    }),
  });

  // Start a Stripe Checkout for the balance → { url }.
  //
  // An ACTION, not a mutation, because it makes a network call to Stripe — and
  // it is called from here rather than from the browser so the session is
  // created against a server-resolved amount and a server-checked rail. The
  // page never holds anything it could substitute.
  http.route({
    path: "/api/partner/pay",
    method: "POST",
    handler: jsonPost(async (ctx, body, req) => {
      const rawAmount = Number(body.amountCents);
      return await ctx.runAction(internal.stripe.createSponsorPortalCheckout, {
        token: String(body.token ?? ""),
        // Anything but the two known rails is refused by the action's own
        // validator; defaulting to the cheap one here means a malformed value
        // can never quietly become a card charge.
        method: body.method === "card" ? "card" : "ach",
        ...(Number.isFinite(rawAmount) && rawAmount > 0
          ? { amountCents: Math.round(rawAmount) }
          : {}),
        coverFee: body.coverFee === true,
        clientIp: clientIpFromRequest(req),
      });
    }),
  });
}
