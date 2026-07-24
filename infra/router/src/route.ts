/**
 * Pure routing logic for the pw-router Cloudflare Worker.
 *
 * Kept free of any Workers-runtime APIs (Request/Response/fetch) so it can be
 * unit-tested with plain `URL` objects under Vitest/Node. `src/index.ts` is
 * the thin fetch handler that turns a `RouteDecision` into an actual
 * Response.
 *
 * Architecture (see infra/router/README section in wrangler.jsonc comments
 * for the hostnames this attaches to):
 *
 *  - publicworship.life (apex):
 *      /os[...]              -> strip "/os" prefix, proxy to the Expo web app
 *      Convex prefixes below -> proxy unchanged to the Convex HTTP actions
 *      everything else       -> static assets (the Astro landing build)
 *  - www.publicworship.life     -> 301 https://publicworship.life<path><search>
 *  - events.publicworship.life  -> 301 https://publicworship.life/os<path><search>
 *  - rsvp.publicworship.life    -> 301 https://publicworship.life<path><search>
 */

export type RouteDecision =
  | { kind: "redirect"; location: string }
  | { kind: "proxy"; target: string; cache?: "immutable" }
  | { kind: "assets" };

export const EXPO_ORIGIN = "https://events-os.expo.app";
export const CONVEX_ORIGIN = "https://vivid-rhinoceros-688.convex.site";

// The Expo web app's base path — mirrored (hand-synced, not imported) as
// APP_BASE_PATH in apps/mobile/lib/appUrl.ts and experiments.baseUrl in
// apps/mobile/app.config.js. infra/router/src/drift.test.ts asserts all
// three stay in sync.
export const OS_PREFIX = "/os";

const APEX = "publicworship.life";
const WWW_HOST = "www.publicworship.life";
const EVENTS_HOST = "events.publicworship.life";
const RSVP_HOST = "rsvp.publicworship.life";

// Kept in sync with apps/convex/http.ts's public route table: the
// server-rendered public pages (/rsvp/ — the guest RSVP page — with its short
// /r/ alias and the pre-rename /event/ + /e/ prefixes all serving it, /t/, /p/,
// /reimburse/), the
// client-script JSON APIs (/api/tickets/*, /api/reimburse/*, /api/give/*,
// /api/auth/*, all under /api/), the inbound webhooks
// (/stripe/webhook, /increase/webhook, /resend/inbound — the receipt-email
// ingest, /twilio/receipts — the receipt-SMS ingest, /resend/webhook — the
// email-campaigns bounce/complaint/reply webhook, /twilio/webhook — the SMS
// STOP/START opt-out webhook), and the email-campaigns unsubscribe page
// (/unsubscribe/<token>). /give is handled separately below
// since it's an exact-path route (the map) plus a pathPrefix route
// (/give/<slug>), not a plain prefix. Exported so drift.test.ts can assert
// against apps/convex/http.ts's literals.
export const CONVEX_PREFIXES = [
  "/rsvp/",
  "/r/",
  "/event/",
  "/e/",
  "/t/",
  "/p/",
  "/reimburse/",
  "/api/",
  "/stripe/",
  "/increase/",
  "/resend/",
  "/twilio/",
  "/unsubscribe/",
] as const;

function isConvexPath(pathname: string): boolean {
  if (pathname === "/give" || pathname.startsWith("/give/")) return true;
  return CONVEX_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** Strips a leading "/os" prefix, mapping bare "/os" or "/os/" to "/". */
function stripOsPrefix(pathname: string): string {
  const rest = pathname.slice(OS_PREFIX.length);
  return rest === "" ? "/" : rest;
}

export function route(url: URL): RouteDecision {
  const { hostname, pathname, search } = url;

  if (hostname === WWW_HOST) {
    return { kind: "redirect", location: `https://${APEX}${pathname}${search}` };
  }

  if (hostname === EVENTS_HOST) {
    const suffix = stripOsPrefixInverse(pathname);
    return { kind: "redirect", location: `https://${APEX}${suffix}${search}` };
  }

  if (hostname === RSVP_HOST) {
    return { kind: "redirect", location: `https://${APEX}${pathname}${search}` };
  }

  // Apex (and any other/unexpected host, e.g. a workers.dev preview URL):
  // apply the same path rules as the apex.
  if (pathname === OS_PREFIX || pathname.startsWith(`${OS_PREFIX}/`)) {
    const strippedPath = stripOsPrefix(pathname);
    // Expo's content-hashed bundle output (/_expo/*) is immutable — safe to
    // cache at the edge indefinitely (see index.ts's proxy branch).
    const cache = strippedPath.startsWith("/_expo/") ? "immutable" : undefined;
    return {
      kind: "proxy",
      target: `${EXPO_ORIGIN}${strippedPath}${search}`,
      ...(cache ? { cache } : {}),
    };
  }

  if (isConvexPath(pathname)) {
    return { kind: "proxy", target: `${CONVEX_ORIGIN}${pathname}${search}` };
  }

  return { kind: "assets" };
}

/**
 * events.publicworship.life redirects to the /os-prefixed apex path, i.e.
 * the inverse of stripOsPrefix: "/" -> "/os", "/songs/x" -> "/os/songs/x".
 */
function stripOsPrefixInverse(pathname: string): string {
  return pathname === "/" ? OS_PREFIX : `${OS_PREFIX}${pathname}`;
}
