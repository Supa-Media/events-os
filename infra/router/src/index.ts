/**
 * pw-router — the Cloudflare Worker that makes https://publicworship.life the
 * single public domain for the landing site, the Convex-served public pages,
 * and the authenticated Expo web app, plus 301s from legacy subdomains.
 *
 * All the routing *decisions* live in ./route.ts as a pure function so they
 * can be unit-tested without the Workers runtime. This module just turns
 * those decisions into actual Requests/Responses — and since the blog moved
 * to Convex there is no stateful decision left here: the shared-password gate
 * that used to guard /blog/drafts/* is gone (see below), so every branch is
 * now a redirect, a proxy, or a static asset.
 *
 * THE DRAFT GATE IS RETIRED. An unpublished post used to be built to
 * /blog/drafts/<slug> and held behind one shared password (the deleted
 * ./draftGate.ts). Posts are Convex rows now: a draft has no URL of its own,
 * and it is shared with a PER-POST preview token
 * (`packages/shared/src/marketingBlog.ts#BLOG_PREVIEW_PARAM`) that the
 * backend checks before it will render the post at all. That is strictly
 * better than what was here — the old password was a plaintext var in
 * wrangler.jsonc in a public repository, covered every draft at once, and
 * could only be revoked by rotating it for everybody. Nothing at the edge
 * needs to know about drafts any more, which is why this file no longer
 * reads a cookie, a form body, or a secret.
 */
import { route } from "./route";

interface Env {
  // Static-assets binding, configured in wrangler.jsonc, pointing at the
  // Astro landing build (apps/landing/dist).
  ASSETS: Fetcher;
}

/**
 * Tell the BROWSER, not just the edge, that a content-hashed file never
 * changes. The origin (EAS Hosting) sends `public, max-age=3600`, so a phone
 * that opened the app more than an hour ago asks again for every script, font
 * and stylesheet before it can paint — one round trip each, which on a slow
 * connection is most of a "white screen" (Dev2, 2026-11-08). A new deploy
 * changes the file names, so a long-lived copy can never go stale.
 *
 * Only for a real file: EAS answers a path it doesn't have with the SPA's
 * index.html and a 200, and pinning THAT under a script's name for a year
 * would break the app in that browser until the cache is cleared.
 */
export function withBrowserCache(upstream: Response): Response {
  const type = upstream.headers.get("Content-Type") ?? "";
  if (!upstream.ok || type.includes("text/html")) return upstream;
  const response = new Response(upstream.body, upstream);
  response.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return response;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const decision = route(url);

    switch (decision.kind) {
      case "redirect":
        // Deterministic (legacy-host) redirects are safe to cache — a plain
        // 301 Response.redirect() isn't cacheable at the edge, so build the
        // Response by hand with an explicit Cache-Control instead.
        return new Response(null, {
          status: 301,
          headers: {
            Location: decision.location,
            "Cache-Control": "public, max-age=86400",
          },
        });

      case "proxy": {
        const target = new URL(decision.target);
        // Passing the original `request` as the second argument copies its
        // method, headers, and body onto the new URL — the standard
        // Cloudflare Workers proxy idiom (see
        // https://developers.cloudflare.com/workers/examples/respond-with-another-site/).
        const proxyRequest = new Request(target, request);
        proxyRequest.headers.set("Host", target.host);

        if (decision.cache === "immutable") {
          // Content-hashed bundle output (Expo's /_expo/*) — safe to cache
          // at the edge indefinitely. Cookie-bearing requests are ineligible
          // for edge caching, so strip it before handing off to `fetch`.
          proxyRequest.headers.delete("Cookie");
          const upstream = await fetch(proxyRequest, {
            cf: { cacheEverything: true, cacheTtl: 31536000 },
          });
          return withBrowserCache(upstream);
        }

        return fetch(proxyRequest);
      }

      case "assets":
        return env.ASSETS.fetch(request);
    }
  },
};
