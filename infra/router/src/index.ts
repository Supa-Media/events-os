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
import { EXPO_ORIGIN, route } from "./route";

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
  if (!isRealFile(upstream)) return upstream;
  const response = new Response(upstream.body, upstream);
  response.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return response;
}

function isRealFile(upstream: Response): boolean {
  const type = upstream.headers.get("Content-Type") ?? "";
  return upstream.ok && !type.includes("text/html");
}

/**
 * A hashed bundle file the origin doesn't have is a 404, never EAS's SPA
 * fallback page.
 *
 * Why (Dev2, 2026-11-10, /os/code stuck on the splash with "Requiring
 * unknown module 1421"): a page opened before a deploy still asks for the
 * OLD build's route chunks. EAS answers each with index.html and a 200. The
 * chunk loader adds a <script> tag, and a script tag fires `load` even when
 * its body is HTML (that is only a syntax error), so the loader believes the
 * chunk arrived and the app crashes when it requires a module that never
 * did. A 404 fires `error` instead: the loader rejects, and public/index.html
 * reloads the page onto the current build.
 *
 * It also kept that HTML out of the edge cache: with `cacheEverything` it
 * was stored under the script's name for a year.
 */
export function bundleFileOrMissing(
  upstream: Response,
  cache: "immutable" | "revalidate" = "immutable",
): Response {
  // A 304 answers the browser's own "has it changed?" check: it has no body
  // or Content-Type and must pass straight through. Treating it as missing
  // (because a 304 isn't `ok`) 404'd every revalidated file and broke the
  // app for anyone who had loaded it before (2026-11-10, #905).
  if (upstream.status === 304) return upstream;
  if (!isRealFile(upstream)) {
    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
    });
  }
  if (cache === "immutable") return withBrowserCache(upstream);
  // Expo's bundle files: see route.ts for why their names can't be trusted.
  const response = new Response(upstream.body, upstream);
  response.headers.set("Cache-Control", "no-cache");
  return response;
}

/**
 * The app's HTML shell is revalidated on every visit. It names the build's
 * hashed entry scripts, so a browser holding an old copy runs an old build
 * whose files no longer exist. EAS sends no Cache-Control on it, which lets a
 * browser guess a freshness lifetime from Last-Modified; `no-cache` stops the
 * guessing and costs only a conditional request.
 */
export function withShellRevalidation(upstream: Response): Response {
  const type = upstream.headers.get("Content-Type") ?? "";
  if (!type.includes("text/html")) return upstream;
  const response = new Response(upstream.body, upstream);
  response.headers.set("Cache-Control", "no-cache");
  return response;
}

/** Bumped when what the edge may hold under a URL changes: v1 entries were
 *  written by `cacheEverything` and can be SPA-fallback HTML; v2 held Expo
 *  bundle files, which are no longer edge-cached at all. */
const EDGE_CACHE_KEY_PREFIX = "https://edge-cache.internal/v3/";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
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

        if (decision.cache === "revalidate") {
          return bundleFileOrMissing(await fetch(proxyRequest), "revalidate");
        }

        if (decision.cache === "immutable") {
          // Truly content-hashed files (fonts, icons): kept in the edge
          // cache by hand, so that only a real file is ever stored.
          // Cookie-bearing requests are ineligible for edge caching anyway.
          proxyRequest.headers.delete("Cookie");
          const cacheable = request.method === "GET";
          const key = new Request(`${EDGE_CACHE_KEY_PREFIX}${target.host}${target.pathname}${target.search}`);
          const edge = caches.default;
          if (cacheable) {
            const hit = await edge.match(key);
            if (hit) return hit;
          }
          const response = bundleFileOrMissing(await fetch(proxyRequest));
          if (cacheable && response.status === 200) {
            ctx.waitUntil(edge.put(key, response.clone()));
          }
          return response;
        }

        const upstream = await fetch(proxyRequest);
        return target.origin === EXPO_ORIGIN
          ? withShellRevalidation(upstream)
          : upstream;
      }

      case "assets":
        return env.ASSETS.fetch(request);
    }
  },
};
