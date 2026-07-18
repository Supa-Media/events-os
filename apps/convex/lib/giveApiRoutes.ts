/**
 * The public giving map's same-origin JSON API (F-6 P3): the `/give/<slug>`
 * page's become-a-backer form (`givePageClient.ts`) posts here. Mirrors
 * `ticketApiRoutes.ts`'s `/api/tickets/donate` shape exactly — same `jsonPost`
 * wrapper, same "resolve → call the real action → return its Stripe URL"
 * flow. Registered onto the main router by `http.ts` via
 * `registerGiveApiRoutes`.
 */
import type { HttpRouter } from "convex/server";
import { ConvexError } from "convex/values";
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

/** Wrap a public JSON POST endpoint (identical shape to
 *  `ticketApiRoutes.ts`'s `jsonPost` — kept local rather than shared so
 *  neither file depends on the other's internals). */
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

export function registerGiveApiRoutes(http: HttpRouter): void {
  http.route({
    path: "/api/give/pledge",
    method: "POST",
    handler: jsonPost(async (ctx, body) => {
      const slug = String(body.slug ?? "");
      const resolved = await ctx.runQuery(
        internal.territories.resolveTerritoryForCheckout,
        { slug },
      );
      if (!resolved) {
        throw new ConvexError({
          message: "This territory isn't available for backing right now.",
        });
      }
      return ctx.runAction(api.givingPledges.startPledgeCheckout, {
        chapterId: resolved.chapterId,
        amountCents: Math.floor(Number(body.amountCents)),
        name: String(body.name ?? ""),
        email: String(body.email ?? ""),
      });
    }),
  });
}
