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
  // `gate: "draft"` marks the unpublished-blog-post prefix, which index.ts
  // puts behind a shared password before serving the asset. See draftGate.ts.
  | { kind: "assets"; gate?: "draft" };

export const EXPO_ORIGIN = "https://events-os.expo.app";
export const CONVEX_ORIGIN = "https://vivid-rhinoceros-688.convex.site";

// The Expo web app's base path — mirrored (hand-synced, not imported) as
// APP_BASE_PATH in apps/mobile/lib/appUrl.ts and experiments.baseUrl in
// apps/mobile/app.config.js. infra/router/src/drift.test.ts asserts all
// three stay in sync.
export const OS_PREFIX = "/os";

// Unpublished blog posts. Astro builds a `draft: true` post to
// /blog/drafts/<slug> instead of /blog/<slug> (apps/landing/src/pages/blog/)
// precisely so this one prefix can be gated — see draftGate.ts. Everything
// under it, HTML and assets alike, needs the password.
export const DRAFTS_PREFIX = "/blog/drafts";

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
  // Inline campaign polls (`apps/convex/http.ts`'s `/poll/` GET + POST). Same
  // shape as `/unsubscribe/`: a link inside a sent email, resolved per
  // recipient, so it must reach Convex rather than the static site.
  "/poll/",
  // The public financial ledger (`publicworship.life/finances`,
  // `/finances/<YYYY-MM>`, CSVs, `?preview=` drafts). Registered in http.ts
  // via a `/${LEDGER_PATH}` TEMPLATE LITERAL, which is why the drift guard
  // stayed green while this entry was missing and the whole transparency
  // site 404'd at the edge from the day it shipped (2026-08-12, confirmed
  // with live curls: the Worker served an empty static-asset 404 and Convex
  // was never consulted). drift.test.ts now resolves template literals too.
  "/finances/",
  // The contractor's own payment page (`apps/convex/http.ts`'s `/contract/`
  // GET, plus the `/api/contract/*` posts already covered by `/api/`). Same
  // shape as `/reimburse/`: a private link texted or emailed to somebody with
  // no account, which has to reach Convex rather than the static site.
  //
  // Missing this is not a degraded experience, it is a dead link — the Worker
  // would serve an empty static-asset 404 and Convex would never be consulted,
  // exactly as happened to `/finances/` above. A contractor cannot work around
  // it, cannot report it usefully, and the org finds out when they ask where
  // their money is. The drift guard in `drift.test.ts` caught this one before
  // it shipped, which is the whole reason that test exists.
  "/contract/",
  // Mailchimp's webhook (`apps/convex/http.ts`'s `/mailchimp/webhook`, GET +
  // POST). Bulk email lives in Mailchimp now, and this is the route that
  // carries an unsubscribe BACK into `emailSuppressions` so it silences event
  // blasts too. Missing it is silent in the worst way: Mailchimp posts, the
  // Worker answers from static assets, Mailchimp sees a 2xx and never retries
  // — so unsubscribes would be dropped on the floor and we would keep mailing
  // people who asked us to stop, with nothing anywhere reporting a failure.
  // The GET matters too: Mailchimp refuses to SAVE a webhook whose URL doesn't
  // 200 on a GET, so without this the integration cannot even be configured.
  "/mailchimp/",
] as const;

function isConvexPath(pathname: string): boolean {
  if (pathname === "/give" || pathname.startsWith("/give/")) return true;
  // Same exact-path + prefix pair as /give: `/finances` (no slash) is the
  // redirect-to-newest-month route, `/finances/...` the statement pages.
  if (pathname === "/finances") return true;
  // The backer portal (`apps/convex/http.ts`'s `/backer` GET; its posts are
  // already covered by `/api/`). An EXACT path with nothing beneath it — one
  // route renders the sign-in screen or the portal depending on the session
  // cookie, which is what lets every email link to a single URL.
  //
  // Without this entry the Worker serves the Astro landing build's 404 and
  // Convex is never consulted — the same edge-level miss that took the whole
  // finance ledger down on 2026-08-12 and that `drift.test.ts` exists to
  // catch. It caught this one before it shipped.
  if (pathname === "/backer") return true;
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

  // A SHORT LINK FOR THE ONE PAGE THAT ACTUALLY GETS SENT TO PEOPLE.
  //
  // `/code` is the spender's own charges (`apps/mobile/app/code.tsx`), which
  // lives in the Expo app and is therefore really at `/os/code`. The founder
  // asked for it by the name they'd say out loud — "a page I can send people
  // to, like /code" — and `/os` is an artefact of how the app is mounted at
  // the apex, not something anyone should have to read down a phone. One
  // redirect keeps both true: the app keeps its single mount point, and the
  // link stays sayable.
  //
  // Without this the path falls through to `assets` and the Astro landing
  // build 404s it — the same edge-level miss that took the whole finance
  // ledger down on 2026-08-12, which is why this ships with the route rather
  // than after someone reports the link is broken.
  //
  // EXACT PATH, not a prefix: `/code` is one page with nothing beneath it, so
  // a prefix rule would only invent ways for a typo to land somewhere odd.
  // `search` is carried because every coding reminder already links with
  // `?filter=uncoded`.
  if (pathname === "/code") {
    return {
      kind: "redirect",
      location: `https://${APEX}${OS_PREFIX}/code${search}`,
    };
  }

  if (isConvexPath(pathname)) {
    return { kind: "proxy", target: `${CONVEX_ORIGIN}${pathname}${search}` };
  }

  // Draft posts are still static assets — they just don't get served until
  // index.ts has checked the password.
  if (pathname === DRAFTS_PREFIX || pathname.startsWith(`${DRAFTS_PREFIX}/`)) {
    return { kind: "assets", gate: "draft" };
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
