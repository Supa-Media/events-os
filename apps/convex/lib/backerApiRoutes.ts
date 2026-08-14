/**
 * The backer portal's same-origin JSON API — `/api/backer/*`.
 *
 * Same `jsonPost` shape as `giveApiRoutes.ts` and `contractApiRoutes.ts`, kept
 * local rather than shared for the same reason they each keep their own: none
 * of these route files should depend on another's internals.
 *
 * ── THE SESSION RIDES IN A COOKIE, NOT IN THE BODY ─────────────────────────
 * `HttpOnly` (script can't read it, so one XSS isn't everybody's giving
 * history), `Secure`, `SameSite=Lax` (survives the click back from Stripe's
 * billing portal; refuses a cross-site POST), `Path=/`. The token is minted
 * server-side by `verifyCode` and never travels through the page's JavaScript.
 *
 * ── AND EVERY RESPONSE IS UNCACHEABLE ──────────────────────────────────────
 * `no-store, private` on the JSON here and on the page in `http.ts`. These
 * carry one person's record and are reached with a credential; the `/finances`
 * preview-token branch documents the same rule for the same reason.
 */
import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { SESSION_COOKIE, SESSION_TTL_MS } from "./backerAccess";
import type { Id } from "../_generated/dataModel";

function json(body: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, private",
      ...extraHeaders,
    },
  });
}

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
      const body = (await req.json().catch(() => ({}))) as JsonBody;
      const result = await run(ctx, body, req);
      if (result instanceof Response) return result;
      return json(result ?? { ok: true });
    } catch (err) {
      return errorJson(err);
    }
  });
}

/**
 * The caller's IP, last hop first — character-for-character the reasoning in
 * `contractApiRoutes.ts#clientIpFromRequest`: proxies APPEND to
 * `x-forwarded-for`, so the LAST entry is the one the client cannot spoof, and
 * a rate limiter keyed on the first entry is a rate limiter with a bypass.
 */
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

/** The portal session token from the request's cookies, if any. */
export function sessionTokenFromRequest(req: Request): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=") || undefined;
  }
  return undefined;
}

function setSessionCookie(token: string): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function registerBackerApiRoutes(http: HttpRouter): void {
  // Ask for a sign-in code. Answers identically for an address we know and one
  // we've never seen — see `backerPortal.ts#requestCode`.
  http.route({
    path: "/api/backer/code",
    method: "POST",
    handler: jsonPost(async (ctx, body, req) => {
      await ctx.runMutation(internal.backerPortal.requestCode, {
        email: String(body.email ?? ""),
        clientIp: clientIpFromRequest(req),
      });
      return { ok: true };
    }),
  });

  // Trade a code for a session. The token goes STRAIGHT into an HttpOnly
  // cookie and is never returned in the body — the page's script must not be
  // able to read it.
  http.route({
    path: "/api/backer/verify",
    method: "POST",
    handler: jsonPost(async (ctx, body, req) => {
      const result = await ctx.runMutation(internal.backerPortal.verifyCode, {
        email: String(body.email ?? ""),
        code: String(body.code ?? ""),
        clientIp: clientIpFromRequest(req),
      });
      // A WRONG code comes back as a value rather than a throw, so its attempt
      // counter commits — see `verifyCode`. It is still a 400 to the client.
      if (!result.ok) return json({ error: result.error }, 400);
      return json({ ok: true }, 200, {
        "Set-Cookie": setSessionCookie(result.token),
      });
    }),
  });

  // Sign out — delete the row AND clear the cookie. Either alone leaves a
  // half-signed-out state that looks like a bug from one side or the other.
  http.route({
    path: "/api/backer/signout",
    method: "POST",
    handler: jsonPost(async (ctx, _body, req) => {
      const token = sessionTokenFromRequest(req);
      if (token) {
        await ctx.runMutation(internal.backerPortal.signOut, { token });
      }
      return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
    }),
  });

  // Open Stripe's billing portal for one of the caller's own pledges. The
  // session is the authorization — see `givingPledges.createPortalSession`,
  // which used to take a bare email from anybody.
  http.route({
    path: "/api/backer/billing-portal",
    method: "POST",
    handler: jsonPost(async (ctx, body, req) => {
      const result: { url: string } = await ctx.runAction(
        api.givingPledges.createPortalSession,
        {
          sessionToken: sessionTokenFromRequest(req) ?? "",
          pledgeId: String(body.pledgeId ?? "") as Id<"pledges">,
          flow: body.flow === "cancel" ? "cancel" : "card",
        },
      );
      return { url: result.url };
    }),
  });

  // Change a monthly amount. Ours rather than Stripe's, because Stripe's portal
  // cannot hold a minimum — see `givingPledges.changePledgeAmount`.
  http.route({
    path: "/api/backer/amount",
    method: "POST",
    handler: jsonPost(async (ctx, body, req) => {
      await ctx.runAction(api.givingPledges.changePledgeAmount, {
        sessionToken: sessionTokenFromRequest(req) ?? "",
        pledgeId: String(body.pledgeId ?? "") as Id<"pledges">,
        amount: String(body.amount ?? ""),
      });
      return { ok: true };
    }),
  });
}
