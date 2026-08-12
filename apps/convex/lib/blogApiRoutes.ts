/**
 * The blog's same-origin JSON API — what the emoji bar under each post talks
 * to. Mirrors `giveApiRoutes.ts` / `ticketApiRoutes.ts`'s shape (local `json`
 * + `errorJson` helpers, registered onto the main router from `http.ts`).
 *
 *   GET  /api/blog/reactions?slug=<slug>&actorKey=<key>  → counts + mine + readers
 *   POST /api/blog/reactions  {slug, emoji, actorKey}    → toggled state
 *   POST /api/blog/read       {slug, actorKey}           → read counted (once
 *                              per browser), returns the same full state —
 *                              the page's single load-time call
 *
 * Same-origin in production: publicworship.life/blog/<slug> is static HTML
 * served by pw-router from the Astro build, and the Worker proxies `/api/*`
 * here (infra/router/src/route.ts). So the browser makes a plain relative
 * fetch and no CORS is involved.
 *
 * The permissive CORS headers below are for LOCAL DEVELOPMENT only, where the
 * landing site runs on localhost:4321 and this backend on a .convex.site
 * origin. They are safe to leave on in production because these two endpoints
 * are already fully public and unauthenticated (anyone can read a count or
 * tap an emoji, from anywhere) and they never read a cookie or an auth header
 * — so there is no ambient authority for a cross-site caller to borrow.
 */
import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { api } from "../_generated/api";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
} as const;

function json(body: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extra },
  });
}

/** A thrown ConvexError's friendly message, with a generic fallback. */
function errorJson(err: unknown): Response {
  const message =
    (err as { data?: { message?: string } })?.data?.message ??
    "Couldn't record that reaction. Please try again.";
  return json({ error: message }, 400);
}

export function registerBlogApiRoutes(http: HttpRouter): void {
  // Preflight — only reached from a cross-origin dev server; production is
  // same-origin through pw-router and never sends one.
  http.route({
    path: "/api/blog/reactions",
    method: "OPTIONS",
    handler: httpAction(async () => new Response(null, { status: 204, headers: CORS_HEADERS })),
  });

  http.route({
    path: "/api/blog/reactions",
    method: "GET",
    handler: httpAction(async (ctx, req) => {
      const url = new URL(req.url);
      const slug = url.searchParams.get("slug") ?? "";
      const actorKey = url.searchParams.get("actorKey") ?? undefined;
      try {
        const state = await ctx.runQuery(api.blog.getReactions, {
          slug,
          ...(actorKey ? { actorKey } : {}),
        });
        // A short edge cache keeps a popular post from hitting the backend on
        // every view. `private` because the response carries `mine` — this
        // reader's own taps — which must never be served to another browser
        // out of a shared cache.
        return json(state, 200, { "Cache-Control": "private, max-age=30" });
      } catch (err) {
        return errorJson(err);
      }
    }),
  });

  http.route({
    path: "/api/blog/reactions",
    method: "POST",
    handler: httpAction(async (ctx, req) => {
      try {
        const body = (await req.json()) as Record<string, unknown>;
        const state = await ctx.runMutation(api.blog.toggleReaction, {
          slug: String(body.slug ?? ""),
          emoji: String(body.emoji ?? ""),
          actorKey: String(body.actorKey ?? ""),
        });
        return json(state);
      } catch (err) {
        return errorJson(err);
      }
    }),
  });

  // Same preflight posture as /api/blog/reactions — dev-only in practice.
  http.route({
    path: "/api/blog/read",
    method: "OPTIONS",
    handler: httpAction(async () => new Response(null, { status: 204, headers: CORS_HEADERS })),
  });

  http.route({
    path: "/api/blog/read",
    method: "POST",
    handler: httpAction(async (ctx, req) => {
      try {
        const body = (await req.json()) as Record<string, unknown>;
        const state = await ctx.runMutation(api.blog.recordRead, {
          slug: String(body.slug ?? ""),
          actorKey: String(body.actorKey ?? ""),
        });
        return json(state);
      } catch (err) {
        return errorJson(err);
      }
    }),
  });
}
