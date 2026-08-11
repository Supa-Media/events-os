/**
 * pw-router — the Cloudflare Worker that makes https://publicworship.life the
 * single public domain for the landing site, the Convex-served public pages,
 * and the authenticated Expo web app, plus 301s from legacy subdomains.
 *
 * All the routing *decisions* live in ./route.ts as a pure function so they
 * can be unit-tested without the Workers runtime. This module just turns
 * those decisions into actual Requests/Responses.
 *
 * The one decision with state attached is `gate: "draft"` — unpublished blog
 * posts, held behind a shared password. Its rules live in ./draftGate.ts
 * (also pure); this module owns the request/response plumbing around them.
 */
import { route } from "./route";
import {
  decideDraftAccess,
  draftCookieHeader,
  type DraftDecision,
} from "./draftGate";

interface Env {
  // Static-assets binding, configured in wrangler.jsonc, pointing at the
  // Astro landing build (apps/landing/dist).
  ASSETS: Fetcher;
  // Shared password for unpublished blog posts, set out-of-band with
  // `wrangler secret put DRAFT_PASSWORD`. Optional on purpose: when it is
  // missing the draft prefix fails CLOSED (see draftGate.ts), so a Worker
  // deployed before the secret exists doesn't quietly publish drafts.
  DRAFT_PASSWORD?: string;
}

/** The password form. Deliberately self-contained — a draft URL must not
 *  depend on the landing site's CSS bundle to be usable. */
function challengePage(wrongPassword: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Draft — Public Worship</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; min-height:100dvh; display:grid; place-items:center;
         background:#FDF6F6; color:#210909; padding:24px;
         font-family: "DM Sans", ui-sans-serif, system-ui, sans-serif; }
  .card { width:100%; max-width:24rem; text-align:center; }
  h1 { font-family: Georgia, serif; font-weight:400; font-size:1.75rem; margin:0 0 .5rem; }
  p { margin:0 0 1.5rem; line-height:1.5; color:#210909; opacity:.75; }
  form { display:flex; flex-direction:column; gap:.75rem; }
  input { padding:.75rem 1rem; font-size:1rem; border:1px solid #EFA0A0;
          border-radius:9999px; background:#fff; color:inherit; text-align:center; }
  input:focus-visible { outline:2px solid rgba(210,59,58,.6); outline-offset:2px; }
  button { padding:.75rem 1rem; font-size:1rem; font-weight:600; cursor:pointer;
           border:0; border-radius:9999px; background:#D23B3A; color:#FDF6F6; }
  .err { color:#B62F2F; font-weight:500; margin:0 0 1rem; }
</style>
</head>
<body>
  <main class="card">
    <h1>This post is still a draft</h1>
    <p>It hasn't been published yet. If someone shared it with you, they'll have sent the password too.</p>
    ${wrongPassword ? '<p class="err">That password didn\'t work. Try again.</p>' : ""}
    <form method="POST">
      <input type="password" name="password" placeholder="Password"
             aria-label="Draft password" autocomplete="current-password" autofocus required />
      <button type="submit">Read the draft</button>
    </form>
  </main>
</body>
</html>`;
}

const NOINDEX = { "X-Robots-Tag": "noindex, nofollow" } as const;

function htmlResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // A password prompt must never be cached — neither the challenge nor
      // the draft behind it.
      "Cache-Control": "no-store",
      ...NOINDEX,
    },
  });
}

/** The password the caller just submitted, from a POST form or `?pw=`. */
async function readSubmittedPassword(
  request: Request,
  url: URL,
): Promise<string | null> {
  if (request.method === "POST") {
    const form = await request.formData().catch(() => null);
    const value = form?.get("password");
    return typeof value === "string" ? value : null;
  }
  // `?pw=` exists so one link can carry its own key ("here's the draft, the
  // password is in the URL"). It is swapped for a cookie and redirected away
  // immediately so it doesn't linger in history or a Referer header.
  return url.searchParams.get("pw");
}

async function serveDraft(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const submitted = await readSubmittedPassword(request, url);
  const decision: DraftDecision = await decideDraftAccess({
    password: env.DRAFT_PASSWORD,
    cookieHeader: request.headers.get("Cookie"),
    submitted,
  });

  switch (decision.kind) {
    case "unavailable":
      return htmlResponse(
        "<!doctype html><meta charset=utf-8><title>Unavailable</title>" +
          "<p>Draft sharing isn't configured for this site yet.</p>",
        503,
      );

    case "challenge":
      // 401 on a fresh visit is the honest status; a wrong password re-renders
      // the form the browser just posted to.
      return htmlResponse(challengePage(decision.wrongPassword), 401);

    case "grant": {
      // Land on the same path with `?pw=` stripped, carrying the cookie.
      const clean = new URL(url.toString());
      clean.searchParams.delete("pw");
      return new Response(null, {
        status: 303,
        headers: {
          Location: `${clean.pathname}${clean.search}`,
          "Set-Cookie": draftCookieHeader(
            decision.token,
            url.protocol === "https:",
          ),
          "Cache-Control": "no-store",
          ...NOINDEX,
        },
      });
    }

    case "allow": {
      const assetResponse = await env.ASSETS.fetch(request);
      // Copy so the noindex header and no-store survive onto the asset — the
      // page's own <meta robots> covers crawlers that read HTML, this covers
      // the ones that only read headers, and no-store keeps an authorized
      // draft out of shared caches.
      const headers = new Headers(assetResponse.headers);
      headers.set("X-Robots-Tag", NOINDEX["X-Robots-Tag"]);
      headers.set("Cache-Control", "no-store");
      return new Response(assetResponse.body, {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers,
      });
    }
  }
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
          return fetch(proxyRequest, {
            cf: { cacheEverything: true, cacheTtl: 31536000 },
          });
        }

        return fetch(proxyRequest);
      }

      case "assets":
        if (decision.gate === "draft") return serveDraft(request, env, url);
        return env.ASSETS.fetch(request);
    }
  },
};
