/**
 * pw-router — the Cloudflare Worker that makes https://publicworship.life the
 * single public domain for the landing site, the Convex-served public pages,
 * and the authenticated Expo web app, plus 301s from legacy subdomains.
 *
 * All the routing *decisions* live in ./route.ts as a pure function so they
 * can be unit-tested without the Workers runtime. This module just turns
 * those decisions into actual Requests/Responses.
 */
import { route } from "./route";

interface Env {
  // Static-assets binding, configured in wrangler.jsonc, pointing at the
  // Astro landing build (apps/landing/dist).
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const decision = route(url);

    switch (decision.kind) {
      case "redirect":
        return Response.redirect(decision.location, 301);

      case "proxy": {
        const target = new URL(decision.target);
        // Passing the original `request` as the second argument copies its
        // method, headers, and body onto the new URL — the standard
        // Cloudflare Workers proxy idiom (see
        // https://developers.cloudflare.com/workers/examples/respond-with-another-site/).
        const proxyRequest = new Request(target, request);
        proxyRequest.headers.set("Host", target.host);
        return fetch(proxyRequest);
      }

      case "assets":
        return env.ASSETS.fetch(request);
    }
  },
};
