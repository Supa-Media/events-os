/**
 * The Marketing desk's public HTTP surface — three routes, registered onto the
 * main router by `http.ts` via `registerMarketingApiRoutes`.
 *
 *   GET  /api/site/home                     the homepage's content
 *   GET  /api/site/link-image/<id>/<which>  an uploaded link-card image
 *   POST /api/subscribe                     the mailing-list signup form
 *
 * The GETs mirror `/api/team/roles` exactly: same-origin JSON the landing site
 * fetches at runtime, so an edit in the OS shows on publicworship.life with no
 * rebuild. The POST mirrors `giveApiRoutes.ts` / `joinApiRoutes.ts`: coerce the
 * body, call the real mutation, let its `ConvexError` become the user's
 * message.
 *
 * On `publicworship.life` all three are reachable because pw-router already
 * proxies everything under `/api/` to Convex (`infra/router/src/route.ts`) — no
 * router change was needed, and none should be for the next route under this
 * prefix.
 *
 * ── The read/write asymmetry is the point ───────────────────────────────────
 * `GET /api/site/home` returns content written to be read by strangers, so it
 * is unauthenticated and cached. There is deliberately NO GET for the mailing
 * list, at any path, ever: `/api/subscribe` is write-only, and its response is
 * uniform whether or not the address was already known, so it cannot be used to
 * probe who is in the database. Same one-way stance `joinApiRoutes.ts`
 * documents for applications.
 */
import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { api, internal } from "../_generated/api";

/** How long a CDN or browser may hold the homepage feed. 60s matches the
 *  events and roles feeds — long enough to keep the backend quiet, short
 *  enough that "I changed the headline" feels immediate. */
const CONTENT_MAX_AGE = 60;
/** Uploaded card art is immutable per storage id but reachable by a stable
 *  path, so it caches like the RSVP cover route does: minutes, not forever. */
const IMAGE_MAX_AGE = 300;

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

export function registerMarketingApiRoutes(http: HttpRouter): void {
  // ── The homepage's content ────────────────────────────────────────────────
  // One document rather than three endpoints: the page needs all of it to
  // render one screen, and three round-trips would be three chances to paint
  // half an update. Includes the live event cards ALREADY selected — see
  // `marketingSite.ts`'s "Why the events row resolves HERE".
  http.route({
    path: "/api/site/home",
    method: "GET",
    handler: httpAction(async (ctx) => {
      const content = await ctx.runQuery(internal.marketingSite.publicSiteContent, {});
      return new Response(JSON.stringify(content), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${CONTENT_MAX_AGE}`,
        },
      });
    }),
  });

  // ── An uploaded link-card image ───────────────────────────────────────────
  // `/api/site/link-image/<linkId>/(thumb|bg)`. A path prefix rather than a
  // signed storage URL, for the same reason `/rsvp/<slug>/cover` is one: the
  // image is public content on a public page, and a URL that expires is a URL
  // that eventually 404s inside somebody's cached HTML.
  http.route({
    pathPrefix: "/api/site/link-image/",
    method: "GET",
    handler: httpAction(async (ctx, req) => {
      const url = new URL(req.url);
      // ["api", "site", "link-image", <id>, <which>]
      const segments = url.pathname.split("/").filter(Boolean);
      const linkId = decodeURIComponent(segments[3] ?? "");
      const which = segments[4] ?? "";
      if (!linkId || (which !== "thumb" && which !== "bg") || segments.length > 5) {
        return new Response("Not found", { status: 404 });
      }
      const storageId = await ctx.runQuery(
        internal.marketingSite.getLinkImageStorageId,
        { linkId, which },
      );
      if (!storageId) return new Response("Not found", { status: 404 });
      const blob = await ctx.storage.get(storageId);
      if (!blob) return new Response("Not found", { status: 404 });
      return new Response(blob, {
        headers: {
          "Content-Type": blob.type || "image/jpeg",
          "Cache-Control": `public, max-age=${IMAGE_MAX_AGE}`,
        },
      });
    }),
  });

  // ── The mailing-list signup ───────────────────────────────────────────────
  // What replaced the Google Form. Validation, normalization, and the
  // match-or-create all live in `mailingList.subscribe`; this is the coercion
  // layer and nothing else.
  http.route({
    path: "/api/subscribe",
    method: "POST",
    handler: httpAction(async (ctx, req) => {
      try {
        const body = (await req.json()) as Record<string, unknown>;

        // Honeypot: a field styled off-screen that a human never sees and a
        // naive bot always fills. Answer 200 rather than an error — a bot told
        // it failed tries again with the field blank, and the real form has no
        // way to trip this. Same treatment as the careers form.
        if (String(body.website ?? "").trim()) return json({ ok: true });

        const email = String(body.email ?? "").trim();
        const phone = String(body.phone ?? "").trim();
        const chapterSlug = String(body.chapterSlug ?? "").trim();

        await ctx.runMutation(api.mailingList.subscribe, {
          name: String(body.name ?? ""),
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
          ...(chapterSlug ? { chapterSlug } : {}),
        });
        return json({ ok: true });
      } catch (err) {
        return errorJson(err);
      }
    }),
  });
}
