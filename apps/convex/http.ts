/**
 * The Convex HTTP router — the entire public, unauthenticated-by-default HTTP
 * surface of the backend, as opposed to the `query`/`mutation`/`action`
 * functions elsewhere in `apps/convex/`, which go through the Convex client
 * and are gated by `lib/access.ts`.
 *
 * Routes fall into four groups: the auth callback routes
 * (`auth.addHttpRoutes`); the JSON APIs backing the public ticketing,
 * reimbursement, and giving client scripts (`/api/tickets/*`,
 * `/api/reimburse/*`, `/api/give/*`); the server-rendered public pages
 * (`/rsvp/` — the guest RSVP page, with `/event/`, `/e/`, and `/r/` kept as
 * back-compat aliases, see the comment at its route below — `/t/`, `/give`,
 * `/finances`, `/p/`, `/reimburse/`); the payment-provider webhook receivers
 * (`/stripe/webhook`, `/increase/webhook`, `/twilio/webhook`,
 * `/twilio/receipts`); and the email-campaign surfaces (`/unsubscribe/`,
 * `/resend/webhook`) alongside the pre-existing `/resend/inbound` receipt-OCR
 * webhook — two distinct Resend webhook endpoints that must both stay wired.
 *
 * This module's default export is what Convex's HTTP actions router
 * dispatches on. Removing or misconfiguring it drops every public event
 * page, ticket page, giving page, and reimbursement page, and all three
 * webhooks — whose signature verification (`verifyStripeSignature`,
 * `verifyIncreaseSignature`, `validateTwilioSignature`) happens exactly here.
 */
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { auth } from "./auth";
import {
  renderIcs,
  renderLandingPage,
  renderNotFound,
  renderTicketPage,
} from "./lib/landingPage";
import { registerTicketApiRoutes } from "./lib/ticketApiRoutes";
import { registerReimburseApiRoutes } from "./lib/reimburseApiRoutes";
import { registerGiveApiRoutes } from "./lib/giveApiRoutes";
import { registerBlogApiRoutes } from "./lib/blogApiRoutes";
import {
  renderReimburseForm,
  renderReimburseStatus,
  renderReimburseNotFound,
} from "./lib/reimbursePage";
import { registerContractApiRoutes } from "./lib/contractApiRoutes";
import {
  renderContractAgreement,
  renderContractForm,
  renderContractNotFound,
  renderContractStatus,
} from "./lib/contractPage";
import {
  renderGiveMapPage,
  renderGiveTerritoryPage,
  renderGiveNotFound,
} from "./lib/givePage";
import {
  renderProjectActionGone,
  renderProjectActionPage,
  renderProjectActionResult,
} from "./lib/projectActionPage";
import {
  LEDGER_PATH,
  renderLedgerEmpty,
  renderLedgerPage,
  renderLedgerYearPage,
} from "./lib/publicLedgerPage";
import { givingCsv, ledgerCsv } from "./lib/publicLedgerCsv";
import { EMAIL_ACTION_STATUSES, type EmailActionStatus } from "./projectActions";
import { appUrl, rsvpPath, siteUrl } from "./lib/siteUrl";
import { verifyStripeSignature } from "./stripe";
import { verifyIncreaseSignature } from "./increase";
import {
  normalizePhone,
  resolveTwilioCredentials,
  validateTwilioSignature,
  verifyTwilioSignature,
} from "./lib/twilio";
import { verifyResendWebhookSignature } from "./lib/resend";
import {
  renderUnsubscribeConfirm,
  renderUnsubscribeDone,
  renderUnsubscribeNotFound,
} from "./lib/unsubscribePage";
import {
  renderPollConfirm,
  renderPollNotFound,
  renderPollThanks,
} from "./lib/pollPage";
import { verifyStandardWebhookSignature } from "./lib/standardWebhook";
import { isReceiptInboxAddress } from "./receiptInbox";
import { resolveTwilioReceiptsWebhookUrl } from "./smsReceipts";

const http = httpRouter();

// Auth routes (handles OTP verification callbacks)
auth.addHttpRoutes(http);

// JSON API for the landing page's client script (/api/tickets/*).
registerTicketApiRoutes(http);

// JSON API for the public reimbursement page's client script (/api/reimburse/*).
registerReimburseApiRoutes(http);

// JSON API for the public contractor page's client script (/api/contract/*).
registerContractApiRoutes(http);

// JSON API for the public giving map's become-a-backer form (/api/give/*).
registerGiveApiRoutes(http);

// JSON API for the marketing blog's emoji reactions (/api/blog/reactions).
registerBlogApiRoutes(http);

// ── Helpers ──────────────────────────────────────────────────────────────────

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/** An empty TwiML `<Response/>` — Twilio expects TwiML (or a 2xx no-body) back
 *  from an inbound-message webhook; an empty `<Response/>` tells it "received,
 *  no auto-reply" without Twilio itself sending anything. */
function emptyTwiml(status = 200): Response {
  return new Response("<Response/>", {
    status,
    headers: { "Content-Type": "text/xml" },
  });
}

// ── Public RSVP pages: /rsvp/<slug>[/cover|/calendar.ics] ───────────────────
// The guest-facing event page — renamed to the "RSVP page" (Events-director
// vocabulary). Served under the branded "/rsvp/" prefix; the older "/event/"
// and legacy "/e/" prefixes are kept as aliases (same handler) so already-
// shared links and OG-cached cover URLs keep resolving. The handler derives
// slug/sub from the trailing path segments, so it works unchanged under any of
// the three prefixes.

const publicRsvpPage = httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean); // ["rsvp"|"r"|"event"|"e", slug, ...]
    const slug = decodeURIComponent(segments[1] ?? "");
    const sub = segments[2] ?? null;
    // Admin draft preview: `?preview=<token>` renders an unpublished page.
    const previewToken = url.searchParams.get("preview") ?? undefined;
    if (!slug) return html(renderNotFound(), 404);

    // Cover image — public so OG scrapers (iMessage) can fetch it.
    if (sub === "cover") {
      const storageId = await ctx.runQuery(
        internal.ticketing.getCoverStorageId,
        { slug, previewToken },
      );
      if (!storageId) return new Response("Not found", { status: 404 });
      const blob = await ctx.storage.get(storageId);
      if (!blob) return new Response("Not found", { status: 404 });
      return new Response(blob, {
        headers: {
          "Content-Type": blob.type || "image/jpeg",
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    const page = await ctx.runQuery(api.ticketing.getPublicPage, {
      slug,
      previewToken,
    });
    if (!page) return html(renderNotFound(), 404);

    if (sub === "calendar.ics") {
      const ics = renderIcs({
        slug,
        eventName: page.eventName,
        startDate: page.startDate,
        endDate: page.endDate,
        venueName: page.venueName,
        address: page.address,
        description: page.tagline,
        siteUrl: siteUrl(),
      });
      return new Response(ics, {
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Content-Disposition": `attachment; filename="${slug}.ics"`,
        },
      });
    }

    if (sub) return html(renderNotFound(), 404);
    return html(renderLandingPage(page, siteUrl()));
});

http.route({ pathPrefix: "/rsvp/", method: "GET", handler: publicRsvpPage });
// Aliases (same handler) so every prefix resolves identically: "/r/" is the
// short form of "/rsvp/"; "/event/" and its short "/e/" are the pre-rename
// prefixes, kept so already-shared/emailed links never break. Canonical URLs
// (OG tags, emails, ICS, Stripe returns) point at "/rsvp/".
http.route({ pathPrefix: "/r/", method: "GET", handler: publicRsvpPage });
http.route({ pathPrefix: "/event/", method: "GET", handler: publicRsvpPage });
http.route({ pathPrefix: "/e/", method: "GET", handler: publicRsvpPage });

// ── Public ticket page: /t/<code> ────────────────────────────────────────────

http.route({
  pathPrefix: "/t/",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const code = decodeURIComponent(url.pathname.split("/").filter(Boolean)[1] ?? "");
    const ticket = code
      ? await ctx.runQuery(api.ticketing.getPublicTicket, { code })
      : null;
    if (!ticket) return html(renderNotFound(), 404);
    return html(renderTicketPage(ticket, siteUrl()));
  }),
});

// ── Public upcoming-events feed: GET /api/events/upcoming ────────────────────
// Same-origin JSON the marketing site's "Important Links" section (apps/landing)
// fetches at runtime to auto-list published RSVP pages — so publishing an event
// in the OS surfaces it on publicworship.life with no rebuild, and it drops off
// the Eastern day after the event ends. Read-only, no PII; a short cache keeps it fresh
// without hammering the backend on every homepage view.

http.route({
  path: "/api/events/upcoming",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const limitParam = Number(url.searchParams.get("limit"));
    const events = await ctx.runQuery(api.ticketing.listPublishedUpcoming, {
      ...(Number.isFinite(limitParam) && limitParam > 0
        ? { limit: Math.floor(limitParam) }
        : {}),
    });
    const body = events.map((e) => ({
      title: e.eventName,
      tagline: e.tagline,
      venueName: e.venueName,
      startDate: e.startDate,
      endDate: e.endDate,
      href: rsvpPath(e.slug),
      coverUrl: e.hasCover ? rsvpPath(e.slug, "cover") : null,
      coverFocalX: e.coverFocalX,
      coverFocalY: e.coverFocalY,
    }));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60",
      },
    });
  }),
});

// ── Public giving map: /give (the map) + /give/<slug> (a territory's page) ───
// Territories (docs/plans/giving-territories.md): the map is aggregates-only,
// no auth (`api.territories.getPublicMapData`/`getPublicTerritory` never expose
// donor PII). URLs stay `/give` + `/give/<slug>` so already-shared links
// survive the cityCampaigns → territories cutover. The territory route reads
// `?pledge=success|canceled` off the URL (the Stripe return param
// `givingPledges.startPledgeCheckout` sets) to render the thank-you banner
// server-side — no extra client round-trip.

http.route({
  path: "/give",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    // A central (no-slug) one-time gift returns here with `?donated=1` — show a
    // thank-you banner (the territory page handles its own thank-you states).
    const thankYou = new URL(req.url).searchParams.get("donated") === "1";
    const [territories, interestStats, feeRates] = await Promise.all([
      ctx.runQuery(api.territories.getPublicMapData, {}),
      ctx.runQuery(api.givingInterest.publicInterestStats, {}),
      // Stamped into the page so the form can price "cover the fees" live as
      // somebody types. The SAME query the checkout action reads, so the
      // number quoted here and the number charged there cannot diverge.
      ctx.runQuery(internal.feeSchedule.givePageRates, {}),
    ]);
    return html(
      renderGiveMapPage(
        territories,
        interestStats,
        thankYou,
        siteUrl(),
        feeRates,
      ),
    );
  }),
});

http.route({
  pathPrefix: "/give/",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean); // ["give", slug, sub?]
    const slug = decodeURIComponent(segments[1] ?? "");
    const sub = segments[2];
    if (!slug) return html(renderGiveNotFound(), 404);

    // Share-card image: GET /give/<slug>/og — the uploaded OG card, served from
    // Convex storage so social scrapers (iMessage/X/etc.) get a real PNG.
    // Public so OG scrapers can fetch it; 404 when the territory has no card.
    if (sub === "og" && segments.length === 3) {
      const storageId = await ctx.runQuery(
        internal.territories.getTerritoryOgStorageId,
        { slug },
      );
      if (!storageId) return new Response("Not found", { status: 404 });
      const blob = await ctx.storage.get(storageId);
      if (!blob) return new Response("Not found", { status: 404 });
      return new Response(blob, {
        headers: {
          "Content-Type": blob.type || "image/png",
          "Cache-Control": "public, max-age=300",
        },
      });
    }
    if (segments.length > 2) return html(renderGiveNotFound(), 404);

    const [data, interestStats, activity, feeRates] = await Promise.all([
      ctx.runQuery(api.territories.getPublicTerritory, { slug }),
      ctx.runQuery(api.givingInterest.publicInterestStats, {}),
      ctx.runQuery(api.givingActivity.getTerritoryActivity, { slug }),
      ctx.runQuery(internal.feeSchedule.givePageRates, {}),
    ]);
    if (!data) return html(renderGiveNotFound(), 404);
    // A one-time gift returns with `?donated=1`; a recurring backer with
    // `?pledge=success|canceled`. Fold the former into the same `pledgeParam`
    // the renderer switches on (it treats `"donated"` as the gift thank-you).
    const pledgeParam =
      url.searchParams.get("donated") === "1"
        ? "donated"
        : url.searchParams.get("pledge");
    return html(
      renderGiveTerritoryPage(
        data,
        interestStats,
        activity,
        siteUrl(),
        pledgeParam,
        feeRates,
      ),
    );
  }),
});

// ── Public finances: /finances (latest), /finances/<YYYY-MM>, + CSVs ────────
// The published ledger (docs/plans/public-ledger.md). Anonymous by design —
// that IS the feature — and safe to be, because every route below reads only
// FROZEN, human-approved rows out of `financePublicationEntries`; none of them
// can reach the live books, and a published gift entry never carried a donor
// field to leak (see schema/publicLedger.ts).
//
// `/finances` with no month redirects to the newest published one rather than
// rendering it in place, so the URL a reader shares always names the month
// they were looking at instead of silently meaning something else next month.
//
// Cache-Control is short and PUBLIC: a published month is immutable until it
// is amended, but an amendment has to reach readers quickly — a correction
// nobody sees is not a correction. Sixty seconds is the same figure
// `/api/events/upcoming` settled on for the same reason.

const LEDGER_CACHE = "public, max-age=60";

/** The published months and years, which every ledger route needs (the two
 *  dropdowns, and the "which month is latest" redirect). Read through one
 *  helper rather than four copies of the same pair of query calls. */
async function ledgerPeriods(ctx: ActionCtx) {
  const [months, years] = await Promise.all([
    ctx.runQuery(api.publicLedger.publishedMonths, {}),
    ctx.runQuery(api.publicLedger.publishedYears, {}),
  ]);
  return { months, years };
}

function csv(body: string, filename: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": LEDGER_CACHE,
    },
  });
}

function ledgerHtml(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": LEDGER_CACHE,
    },
  });
}

function redirectTo(path: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: path, "Cache-Control": LEDGER_CACHE },
  });
}

/**
 * The console's draft-preview response (`?preview=<token>`, below) — deliberately
 * NOT `ledgerHtml`. That helper stamps the public `LEDGER_CACHE` header, and a
 * preview must never be cached or handed to a second viewer of the same
 * link: it renders the books as they stand at THIS instant, and a CDN or
 * browser cache holding onto that instant would silently go stale the
 * moment the preparer's next edit lands. `no-store` on the 404 too — an
 * invalid/expired token shouldn't get remembered as "not found" either.
 */
function previewHtml(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, private",
    },
  });
}

/**
 * `/finances` — the entry point, and the target of the period picker's form.
 *
 * With `?year=&month=` (what the picker submits) it redirects to the canonical
 * path, so the URL a reader ends up on and shares always names the period
 * rather than carrying a query string that means something different next
 * year. With nothing, it redirects to the newest published month.
 *
 * The picker is a plain GET form precisely so this route exists — it is what
 * makes the dropdowns work with JavaScript disabled.
 */
http.route({
  path: `/${LEDGER_PATH}`,
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const params = new URL(req.url).searchParams;
    // A preview token only ever names a MONTH (`/finances/<YYYY-MM>?preview=…`)
    // — there is no month in this bare URL to preview, so it can never be a
    // legitimate preview request. Refuse it here, uncached, rather than
    // falling into the redirect/empty-state logic below, which is publicly
    // cacheable (`LEDGER_CACHE`) and would otherwise hand out a `public,
    // max-age=60` response for a URL carrying a live secret in its query
    // string (same class of leak as the pathPrefix route below — see its
    // `notFound` comment).
    if (params.get("preview") != null) {
      return previewHtml(renderNotFound(), 404);
    }
    const year = params.get("year");
    const month = params.get("month");
    if (year && /^\d{4}$/.test(year)) {
      // A month of "" is the picker's "All months" — the year rollup.
      const target =
        month && /^(0[1-9]|1[0-2])$/.test(month)
          ? `/${LEDGER_PATH}/${year}-${month}`
          : `/${LEDGER_PATH}/${year}`;
      return redirectTo(target);
    }
    const { months, years } = await ledgerPeriods(ctx);
    if (months.length === 0) return ledgerHtml(renderLedgerEmpty(months, years));
    return redirectTo(`/${LEDGER_PATH}/${months[0].periodKey}`);
  }),
});

/**
 * `/finances/<YYYY-MM>` (a month), `/finances/<YYYY>` (the year rollup), and
 * the `.csv` of either. One prefix route because they share the same 404
 * page, the same period parsing, and the same "is anything published?" answer.
 */
http.route({
  pathPrefix: `/${LEDGER_PATH}/`,
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    // ["finances", "2026-08"] | ["finances", "2026"] | ["finances", "2026.csv"]
    //                         | ["finances", "2026-08", "giving.csv"]
    const segments = url.pathname.split("/").filter(Boolean);
    const raw = decodeURIComponent(segments[1] ?? "");
    const sub = segments[2];

    // `?preview=<token>` must NEVER end up in a cacheable response, on ANY
    // branch below — including a malformed-URL 404. A shared/CDN cache keys
    // on the full URL (query string included), so a `public, max-age=60`
    // 404 for a URL carrying a live secret is a leak surface — the cache
    // ENTRY itself, not the 404 body, which never differs — even though the
    // request never resolves to draft data. So the one thing that decides
    // which `notFound` a request gets is whether it carries a preview token,
    // decided HERE, before any of the early-reject checks below run, so
    // none of them can hand a preview request a publicly-cacheable
    // response. (Confirmed gap: `GET /finances/<month>/bogus?preview=…` and
    // `GET /finances/?preview=…` both used to 404 through the OTHER
    // branch below, `public, max-age=60`, before this token check moved up.)
    const previewToken = url.searchParams.get("preview");
    const notFound: (requested?: string) => Promise<Response> =
      previewToken != null
        ? async () => previewHtml(renderNotFound(), 404)
        : async (requested) => {
            const { months, years } = await ledgerPeriods(ctx);
            return ledgerHtml(renderLedgerEmpty(months, years, requested), 404);
          };
    if (!raw || segments.length > 3) return notFound();

    const wantsCsv = raw.endsWith(".csv");
    const key = wantsCsv ? raw.slice(0, -".csv".length) : raw;
    const wantsGivingCsv = sub === "giving.csv";
    if (sub != null && !wantsGivingCsv) return notFound();

    const isMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(key);
    const isYear = /^\d{4}$/.test(key);
    // A malformed period reaches the query, which rejects it — catching it
    // here keeps a typo'd URL a 404 page instead of a 500.
    if (!isMonth && !isYear) return notFound();
    // There is no year-level giving roll: the giving CSV is per month, where
    // its rows are small enough to be worth reading one at a time.
    if (wantsGivingCsv && !isMonth) return notFound();

    // ── Draft preview: `?preview=<token>` ───────────────────────────────────
    // The publish console's "Preview the page" button
    // (`apps/mobile/…/finances/publish.tsx`, `publicLedger.mintLedgerPreviewToken`).
    // Renders THIS month from the LIVE books rather than
    // `financePublicationEntries` — see `publicLedger.previewByToken`. Same
    // mechanism as the RSVP admin preview (`?preview=<token>` on
    // `/rsvp/<slug>`), narrowed to a plain month URL: no CSV, no giving
    // roll, no year rollup — those combinations 404 through the SAME
    // `notFound` selected above, so every preview-path 404 (malformed URL,
    // wrong shape, invalid token, expired token, period mismatch) is byte-
    // and header-identical to every other one — no oracle for which case it
    // was, and every one of them is `no-store, private`.
    if (previewToken != null) {
      if (!isMonth || wantsCsv || wantsGivingCsv) return notFound();
      const preview = await ctx.runQuery(internal.publicLedger.previewByToken, {
        token: previewToken,
        periodKey: key,
      });
      if (!preview) return notFound();
      const { totalBooks, ...statement } = preview;
      return previewHtml(
        renderLedgerPage(statement, [], [], totalBooks, { preview: true }),
      );
    }

    // ── The year rollup ─────────────────────────────────────────────────────
    if (isYear) {
      // The CSV is the COMPLETE year (see lib/publicLedgerCsv.ts); the page is
      // summary-level by design and carries no lines at all.
      const statement = await ctx.runQuery(api.publicLedger.publicYearStatement, {
        year: key,
        ...(wantsCsv ? { entryLimit: 20_000 } : {}),
      });
      if (!statement) {
        return wantsCsv
          ? new Response("Not found", { status: 404 })
          : notFound(key);
      }
      if (wantsCsv) {
        return csv(
          ledgerCsv(statement.entries),
          `public-worship-ledger-${key}.csv`,
        );
      }
      const [{ months, years }, totalBooks] = await Promise.all([
        ledgerPeriods(ctx),
        ctx.runQuery(api.publicLedger.publicBookCount, {}),
      ]);
      return ledgerHtml(
        renderLedgerYearPage(statement, months, years, totalBooks),
      );
    }

    // ── One month ───────────────────────────────────────────────────────────
    const statement = await ctx.runQuery(api.publicLedger.publicStatement, {
      periodKey: key,
      ...(wantsCsv || wantsGivingCsv ? { entryLimit: 5000 } : {}),
    });
    if (!statement) {
      return wantsCsv || wantsGivingCsv
        ? new Response("Not found", { status: 404 })
        : notFound(key);
    }
    if (wantsGivingCsv) {
      return csv(givingCsv(statement.gifts), `public-worship-giving-${key}.csv`);
    }
    if (wantsCsv) {
      return csv(ledgerCsv(statement.entries), `public-worship-ledger-${key}.csv`);
    }

    const [{ months, years }, totalBooks] = await Promise.all([
      ledgerPeriods(ctx),
      ctx.runQuery(api.publicLedger.publicBookCount, {}),
    ]);
    return ledgerHtml(renderLedgerPage(statement, months, years, totalBooks));
  }),
});

// ── Project email-action pages: /p/<token> ──────────────────────────────────
// Where reminder-email links land. GET is read-only (mail scanners prefetch
// links); the status change is the POST below, behind an explicit button.

http.route({
  pathPrefix: "/p/",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean); // ["p", token]
    const token = decodeURIComponent(segments[1] ?? "");
    if (!token || segments.length > 2) {
      return html(renderProjectActionGone(), 404);
    }
    const data = await ctx.runQuery(internal.projectActions.pageData, {
      token,
    });
    if (!data) return html(renderProjectActionGone(), 404);
    return html(
      renderProjectActionPage(
        data,
        token,
        url.searchParams.get("intent"),
        // Deep link straight to the project's own page, when APP_URL is set.
        appUrl(`/project/${data.project._id}`),
      ),
    );
  }),
});

http.route({
  pathPrefix: "/p/",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean); // ["p", token, "status"]
    const token = decodeURIComponent(segments[1] ?? "");
    if (!token || segments[2] !== "status" || segments.length > 3) {
      return html(renderProjectActionGone(), 404);
    }
    // The page's <form> posts application/x-www-form-urlencoded. Parsed via
    // URLSearchParams (not req.formData()) so this file also typechecks under
    // the mobile app's React Native lib, whose FormData type has no .get().
    const form = new URLSearchParams(await req.text());
    const status = form.get("status") ?? "";
    if (!(EMAIL_ACTION_STATUSES as readonly string[]).includes(status)) {
      return html(renderProjectActionGone(), 400);
    }
    const result = await ctx.runMutation(
      internal.projectActions.setStatusFromToken,
      { token, status: status as EmailActionStatus },
    );
    if (!result) return html(renderProjectActionGone(), 404);
    return html(
      renderProjectActionResult(result.projectName, result.status, token),
    );
  }),
});

// ── Stripe webhook ───────────────────────────────────────────────────────────

/** The Checkout Session fields the settle/cancel fan-outs below read. */
type StripeCheckoutSession = {
  id: string;
  payment_intent?: string | null;
  customer?: string | null;
  subscription?: string | null;
  metadata?: Record<string, string> | null;
  amount_total?: number;
  payment_status?: string;
};

/**
 * Has the money actually ARRIVED, or has the donor merely finished the form?
 *
 * For a card these are the same instant, which is why this question did not
 * exist until 2026-08: `checkout.session.completed` fired, the card had already
 * authorised, and settling on the spot was right. ACH debit breaks that
 * equivalence. `checkout.session.completed` fires the moment the donor submits
 * their bank details, with `payment_status: "unpaid"`, and the funds land about
 * four business days later — or never. Settling on completion would post a
 * `gifts` row, email tickets, and light up the public activity wall for money
 * that does not exist yet and may never, and nothing would ever take it back.
 * That is precisely the class of bug the whole reconciliation effort has been
 * cleaning up, so it does not get to walk in through the front door.
 *
 * ABSENT COUNTS AS SETTLED, deliberately. Every card session Stripe has ever
 * sent this endpoint carries `payment_status: "paid"`, but a replay from an
 * older API version, or a hand-crafted test payload, might omit the field
 * entirely — and treating "missing" as "unpaid" would silently stop settling
 * real card gifts, which is a worse failure than the one being fixed. An
 * explicit value that isn't `paid`/`no_payment_required` is treated as NOT
 * settled: an unrecognised future status is far more likely to be a new kind of
 * pending than a new kind of paid.
 */
function checkoutSessionHasSettled(session: StripeCheckoutSession): boolean {
  const status = session.payment_status;
  if (status == null) return true;
  return status === "paid" || status === "no_payment_required";
}

/**
 * Turn a settled Checkout Session into whatever it was — the four-way fan-out
 * on session metadata.
 *
 * ONE function, called from BOTH `checkout.session.completed` (a card, settled
 * instantly) and `checkout.session.async_payment_succeeded` (a bank debit,
 * settled days later). Those two events mean the identical thing — "this money
 * is now real" — and the single most likely way to get delayed settlement wrong
 * is to write the ACH path as a second copy that slowly drifts from the card
 * path. Every branch below is already idempotent, which is what makes it safe
 * to reach twice; Stripe delivers at least once.
 */
async function settleCheckoutSession(
  ctx: ActionCtx,
  obj: StripeCheckoutSession,
): Promise<void> {
  // FIRST, and unconditionally: this session is no longer in flight. Every
  // branch below books real money, and the moment any of them does, a
  // `pendingGifts` row for the same session would be a second copy of it in the
  // giving digest. No-ops for the card sessions that were never pending, which
  // is almost all of them. See `givingPending.resolvePendingGift`.
  //
  // ── WHY DELETE-THEN-WRITE, AND WHAT MAKES IT FREE ────────────────────────
  // Each `runMutation` from an action is its own transaction, so there is a
  // real instant between this delete and the gift being written. The ordering
  // decides what that instant looks like: delete-first holds the money in
  // NEITHER place for a moment; write-first would hold it in BOTH. A digest
  // that misses a gift for a few hundred milliseconds is invisible and
  // self-correcting; one that reports it twice is a number somebody quotes.
  //
  // And the gap costs nothing, because of a constant that lives in another
  // file: `DIGEST_LAG_MS` (60s) closes every digest window at `now − 60s`. A
  // gift written δ<60s after this delete has a `receivedAt` BEYOND the current
  // window's close, so it lands in the next window and is reported exactly
  // once — never lost. ⚠ THAT IS A DEPENDENCY, not a coincidence: shrinking
  // `DIGEST_LAG_MS` towards zero would open a window in which a gift settling
  // mid-sweep is in no digest at all. See `lib/givingNotificationRules.ts`.
  await ctx.runMutation(internal.givingPending.resolvePendingGift, {
    sessionId: obj.id,
    outcome: "settled",
  });

  if (obj.metadata?.giveDonation === "1") {
    // A one-time "give" checkout — settle it via the single gifts write
    // path (`recordGiveDonationPaid`, idempotent on the session id). Amount
    // is read from the session's own `amount_total`, never a client value.
    // Handled BEFORE the pledge/order/donation fan-out: a give session
    // carries no pledgeId and is neither an order nor an event donation, so
    // without this branch it would fall through to the "unknown session"
    // error log.
    // `giveIntendedCents` is present when the donor covered the processing
    // fees: the charge is intended + coverage, and the GIFT is the intended
    // half (see `gifts.feeCoverageCents`). Parsed permissively and validated
    // inside the mutation — metadata is a string map and an unparseable value
    // has to degrade to "the whole charge was the gift", never to a throw.
    const intended = Number(obj.metadata.giveIntendedCents);
    const intendedCents = Number.isFinite(intended) ? intended : undefined;

    await ctx.runMutation(internal.givingDonations.recordGiveDonationPaid, {
      sessionId: obj.id,
      amountTotalCents: obj.amount_total ?? 0,
      donorId: obj.metadata.giveDonorId ?? "",
      scope: obj.metadata.giveScope ?? "",
      ...(intendedCents !== undefined ? { intendedCents } : {}),
    });
    // Flip the giver's optional activity-wall entry visible with the amount
    // they GAVE, not the amount they were charged (no-op if they didn't opt
    // in). A donor who covered fees agreed to show a $100 gift, not to
    // announce that they also paid $3.30 to Stripe. See givingActivity.ts.
    await ctx.runMutation(internal.givingActivity.markActivityVisible, {
      refKey: `give:${obj.id}`,
      amountCents: intendedCents ?? obj.amount_total ?? 0,
    });
  } else if (obj.metadata?.repaymentIds) {
    // A personal-charge repayment Checkout (`stripe.ts#createRepaymentCheckout`,
    // `cards.ts`'s "Stripe repayment" section) — bundled, so metadata
    // carries a comma-joined list. Settled through the SAME idempotent
    // core every other repayment rail uses (`cards.ts#settleRepayment`,
    // guarded on `creditTransactionId`), so Stripe's at-least-once /
    // possibly out-of-order redelivery can never post a second
    // offsetting credit. Handled BEFORE the ticket/donation fan-out: a
    // repayment session carries no pledgeId and is neither an order nor
    // an event donation.
    // `repaymentFeeCents` is the fee-coverage line the checkout added on top
    // of the debt; the settler subtracts it before reconciling against the sum
    // of the repayments, or every fee-covered payment trips its discrepancy
    // alarm. Absent (→ 0) on sessions created before fee coverage shipped, and
    // parsed defensively: metadata is a string map, and a non-numeric value
    // must degrade to "no coverage" rather than NaN its way into the
    // comparison.
    const feeCoverageCents = Number(obj.metadata.repaymentFeeCents ?? 0);
    await ctx.runMutation(internal.cards.applyRepaymentPaidFromStripe, {
      repaymentIds: obj.metadata.repaymentIds.split(",") as Id<
        "personalRepayments"
      >[],
      sessionId: obj.id,
      paymentIntentId: obj.payment_intent ?? undefined,
      amountTotalCents: obj.amount_total ?? 0,
      feeCoverageCents: Number.isFinite(feeCoverageCents) ? feeCoverageCents : 0,
    });
  } else if (obj.metadata?.pledgeId) {
    const pledgeId = obj.metadata.pledgeId;
    // A BACKER (subscription) checkout — identified by our pledge id in the
    // session metadata (a ticket/donation session carries none). Activate
    // the pledge + link its Stripe customer/subscription. Idempotent, and a
    // no-op if the id doesn't resolve — so it can't touch other rows.
    await ctx.runMutation(internal.givingPledges.activatePledgeFromCheckout, {
      pledgeId,
      ...(obj.customer ? { stripeCustomerId: obj.customer } : {}),
      ...(obj.subscription ? { stripeSubscriptionId: obj.subscription } : {}),
    });
    // Flip the backer's optional activity-wall entry visible. No amount is
    // passed — the wall shows the recurring MONTHLY pledge amount stored at
    // pending time (a subscription session's `amount_total` is $0/prorated).
    await ctx.runMutation(internal.givingActivity.markActivityVisible, {
      refKey: String(pledgeId),
    });
  } else {
    const paymentIntentId = obj.payment_intent ?? undefined;
    // One shared session id is either a ticket order OR a donation. Try the
    // order first; only if it wasn't an order do we try the donation. Each
    // path is idempotent (safe on webhook redelivery) and no-ops when the
    // session isn't theirs, so neither can touch the other's rows.
    const wasOrder = await ctx.runMutation(internal.ticketing.markSessionPaid, {
      sessionId: obj.id,
      paymentIntentId,
    });
    if (!wasOrder) {
      const wasDonation = await ctx.runMutation(
        internal.giving.markDonationPaid,
        { sessionId: obj.id, paymentIntentId },
      );
      if (!wasDonation) {
        console.error(`[stripe] webhook for unknown session ${obj.id}`);
      }
    }
  }
}

/**
 * Release whatever a Checkout Session was holding, without settling it.
 *
 * Shared by `checkout.session.expired` (the donor walked away) and
 * `checkout.session.async_payment_failed` (the bank refused the debit). Both
 * mean "no money is coming from this session", and both must leave the books
 * exactly as they were. Each mutation no-ops when the session isn't its own.
 *
 * There is deliberately nothing to undo for a `/give` one-time gift or a
 * pledge: neither writes a `gifts` row before settlement (see
 * `givingDonations.ts`'s module doc — "an abandoned checkout leaves no trace"),
 * so a failed debit has left nothing behind to reverse. That property is why
 * gating settlement is a complete fix for the pre-settlement window.
 *
 * WHAT IS NEW SINCE THAT WAS WRITTEN: an in-flight ACH debit now leaves exactly
 * one trace, a `pendingGifts` row, so the giving digest can say how much of its
 * total hasn't cleared. Dropping it here is what stops a refused debit becoming
 * a phantom — the amount is gone from every digest after this instant. It is
 * still not a `gifts` row and still never was, so the sentence above holds for
 * the ledger and for book value.
 */
async function cancelCheckoutSession(
  ctx: ActionCtx,
  sessionId: string,
  outcome: "failed" | "expired",
): Promise<void> {
  // `failed`, not `settled`: this leaves the row behind as a TOMBSTONE. No
  // gift exists to act as the key on this path — the bank refused the money —
  // so the row is the only thing that can recognise a resent `completed` and
  // refuse it. See `givingPending.resolvePendingGift`.
  await ctx.runMutation(internal.givingPending.resolvePendingGift, {
    sessionId,
    outcome: "failed",
  });
  await ctx.runMutation(internal.ticketing.cancelPendingOrder, { sessionId });
  await ctx.runMutation(internal.giving.cancelPendingDonation, { sessionId });
  // A repayment's bank debit that was refused or abandoned: put the charges
  // back to outstanding so the payer can try again. `failed` on a refusal
  // (the payer needs telling), plain `pending` on an expiry (nothing was ever
  // attempted). Scoped to the rows THIS session is holding — see
  // `cards.releaseRepaymentCheckout`. No-ops when the session wasn't a
  // repayment's, like every other line here.
  await ctx.runMutation(internal.cards.releaseRepaymentCheckout, {
    sessionId,
    outcome,
  });
}

/**
 * Is this the FIRST time Stripe has handed us this event?
 *
 * Stripe delivers at least once, and it retries anything that doesn't answer
 * 200 — so every branch below can run twice. The money paths tolerate that by
 * construction: each one is idempotent on a session/invoice/payout id, so a
 * second pass writes nothing new. **An email is not idempotent.** Sending
 * "your gift cleared" twice is not a rounding error the donor forgives; it
 * reads as either a double charge or a system that doesn't know what it did.
 *
 * So the donor comms — and only the donor comms — are gated on the shared
 * dedup ledger (`webhooks.ts#recordWebhookEvent`, the same one the payout and
 * Financial Connections branches use), keyed on Stripe's own event id.
 *
 * ORDER MATTERS, and it is deliberately "money first, then record, then
 * email": if the settle/cancel work throws, nothing has been recorded, so
 * Stripe's retry re-runs the money path (harmless, it's idempotent) AND still
 * gets to send the email. Recording first would trade a lost email for
 * nothing. The reverse risk — a crash between recording and sending — costs
 * one email and never money, which is the correct side to fail on.
 */
async function isFirstDelivery(
  ctx: ActionCtx,
  event: { id: string; type: string },
): Promise<boolean> {
  const { isNew } = await ctx.runMutation(internal.webhooks.recordWebhookEvent, {
    provider: "stripe",
    eventId: event.id,
    summary: event.type,
  });
  return isNew;
}

http.route({
  path: "/stripe/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      console.error("[stripe] STRIPE_WEBHOOK_SECRET not set");
      return new Response("Not configured", { status: 500 });
    }
    const payload = await req.text();
    const valid = await verifyStripeSignature(
      payload,
      req.headers.get("Stripe-Signature"),
      secret,
    );
    if (!valid) return new Response("Invalid signature", { status: 400 });

    const event = JSON.parse(payload) as {
      id: string;
      type: string;
      data: {
        object: {
          id: string;
          payment_intent?: string | null;
          // checkout.session.completed (subscription mode): the backer session
          // carries our pledge id in metadata + the created customer/subscription.
          customer?: string | null;
          subscription?: string | null;
          metadata?: Record<string, string> | null;
          // checkout.session.completed (one-time give): the settled total.
          amount_total?: number;
          // checkout.session.*: "paid" | "unpaid" | "no_payment_required".
          // THE FIELD THAT DECIDES WHETHER THE MONEY EXISTS — see
          // `checkoutSessionHasSettled`.
          payment_status?: string;
          // invoice.paid / invoice.payment_failed:
          amount_paid?: number;
          // customer.subscription.updated / .deleted, AND charge.dispute.*
          // (where it is the dispute status — `warning_*` means an
          // authorization inquiry that moves no money; see
          // `givingReversals.ts#disputeMovesMoney`).
          status?: string;
          // charge.dispute.created / .closed: `data.object` is the Dispute, so
          // `id` is the `dp_…` id and these point back at the payment.
          charge?: string | null;
          reason?: string | null;
          /** The disputed amount in cents. */
          amount?: number;
          current_period_end?: number; // unix SECONDS
          items?: {
            data?: Array<{ price?: { unit_amount?: number | null } }>;
          };
        };
      };
    };
    const sessionId = event.data.object.id;
    if (event.type.startsWith("financial_connections.")) {
      // Financial Connections (legacy read-sync). Dedup on the provider event id
      // — FC refreshes can redeliver — then hand off to stripeFinance, which
      // schedules a per-account transaction sync. `data.object` here is the FC
      // Account, so its id is the account id. The ticketing/donation paths below
      // are already idempotent and stay untouched (no behavior change for them).
      const { isNew } = await ctx.runMutation(
        internal.webhooks.recordWebhookEvent,
        { provider: "stripe", eventId: event.id, summary: event.type },
      );
      if (isNew) {
        await ctx.runMutation(internal.stripeFinance.onFcWebhookEvent, {
          stripeAccountId: event.data.object.id,
          eventType: event.type,
        });
      }
    } else if (event.type === "checkout.session.completed") {
      const obj = event.data.object;
      if (checkoutSessionHasSettled(obj)) {
        await settleCheckoutSession(ctx, obj);
      } else {
        // A DELAYED payment method — today that means ACH direct debit, which
        // Stripe enabled on this account on 2026-08-09. The donor has finished
        // the form and authorised the debit; the money has not moved. Record no
        // MONEY: no gift, no fulfilled order, no activity-wall entry, nothing
        // in the ledger and nothing in book value. The pending rows the prepare
        // step wrote stay pending, and one of `async_payment_succeeded` /
        // `async_payment_failed` resolves them in a few business days.
        //
        // ONE THING IS WRITTEN, and it is not money: a `pendingGifts` row, so
        // the weekly giving digest can report how much of its total is a bank
        // transfer still clearing. This is the only instant at which that can
        // be recorded honestly — before it the donor might still walk away,
        // after it the money either exists or doesn't. Nothing outside the
        // digest reads that table; see `schema/givingPlatform.ts#pendingGifts`.
        //
        // This log is deliberately not an error — it is the correct, expected
        // path for a bank debit, and it is the breadcrumb that says an ACH
        // payment is in flight if one later goes missing.
        console.log(
          `[stripe] checkout ${sessionId} completed but unsettled ` +
            `(payment_status=${obj.payment_status}) — waiting for async settlement`,
        );
        // Idempotent on the session id, and it resolves the shape itself (a
        // `/give` gift, an event donation, a ticket order's add-on gift, or
        // none of those). AWAITED, unlike the email below: it is a single
        // bounded mutation, and a digest that silently missed in-flight money
        // would be indistinguishable from there being none.
        // A personal-charge repayment paid by BANK DEBIT. The payer has
        // authorised it and the money has not moved, so the debt stays
        // outstanding — but it moves to `processing` so their repayments page
        // says "on its way" instead of "you owe this", which is what stops
        // them paying the same charge twice while it clears. No credit is
        // posted until `async_payment_succeeded`. See
        // `cards.markRepaymentsProcessing`.
        if (obj.metadata?.repaymentIds) {
          await ctx.runMutation(internal.cards.markRepaymentsProcessing, {
            repaymentIds: obj.metadata.repaymentIds.split(",") as Id<
              "personalRepayments"
            >[],
            sessionId,
          });
        }
        const intendedMeta = Number(obj.metadata?.giveIntendedCents);
        await ctx.runMutation(internal.givingPending.recordPendingGift, {
          sessionId,
          amountTotalCents: obj.amount_total ?? 0,
          isGiveDonation: obj.metadata?.giveDonation === "1",
          ...(obj.metadata?.giveDonorId
            ? { giveDonorId: obj.metadata.giveDonorId }
            : {}),
          ...(Number.isFinite(intendedMeta)
            ? { giveIntendedCents: intendedMeta }
            : {}),
        });
        // …and TELL THEM. From the donor's side this is the moment they
        // finished giving; from ours it's the moment we decided to record
        // nothing for days. Silence across that gap reads as "did that
        // work?", which is exactly the anxiety `onAchSubmitted` exists to
        // answer. Scheduled rather than awaited: composing the email costs a
        // round-trip to Stripe, and a webhook receiver's job is to answer 200
        // quickly. It no-ops for anything that isn't a `/give` donation.
        if (await isFirstDelivery(ctx, event)) {
          await ctx.scheduler.runAfter(0, internal.givingComms.onAchSubmitted, {
            sessionId,
          });
        }
      }
    } else if (event.type === "checkout.session.async_payment_succeeded") {
      // The bank debit cleared. THIS is when an ACH gift becomes real, and it
      // runs the identical fan-out a card runs on completion.
      await settleCheckoutSession(ctx, event.data.object);
      if (await isFirstDelivery(ctx, event)) {
        await ctx.scheduler.runAfter(0, internal.givingComms.onAchSettled, {
          sessionId,
        });
      }
    } else if (event.type === "checkout.session.async_payment_failed") {
      // The bank refused the debit (no funds, closed account, blocked debit).
      // Nothing was ever recorded, so this only releases the pending rows.
      await cancelCheckoutSession(ctx, sessionId, "failed");
      // The donor was told days ago that this was on its way, so they are
      // owed the other half of that sentence — plus a link to try again.
      // `onAchFailed` also pulls any activity-wall entry down.
      if (await isFirstDelivery(ctx, event)) {
        await ctx.scheduler.runAfter(0, internal.givingComms.onAchFailed, {
          sessionId,
        });
      }
    } else if (event.type === "checkout.session.expired") {
      // Same fan-out for the abandoned-checkout case — each no-ops if not theirs.
      await cancelCheckoutSession(ctx, sessionId, "expired");
    } else if (event.type === "invoice.paid") {
      // A backer's billing cycle settled — record ONE gift for it (idempotent on
      // the invoice id) + bump the donor rollups. No-op if the subscription
      // isn't a pledge's. Amount is read from the invoice, never a client value.
      const inv = event.data.object;
      if (inv.subscription) {
        await ctx.runMutation(internal.givingPledges.recordPledgeInvoice, {
          subscriptionId: inv.subscription,
          invoiceId: inv.id,
          amountPaidCents: inv.amount_paid ?? 0,
        });
      }
    } else if (event.type === "invoice.payment_failed") {
      const inv = event.data.object;
      if (inv.subscription) {
        await ctx.runMutation(internal.givingPledges.markPledgePastDue, {
          subscriptionId: inv.subscription,
        });
      }
    } else if (event.type === "customer.subscription.updated") {
      // Sync status / period / amount. `data.object` is the subscription, so its
      // id IS the subscription id. `current_period_end` is unix seconds → ms.
      const sub = event.data.object;
      await ctx.runMutation(internal.givingPledges.syncPledgeSubscription, {
        subscriptionId: sub.id,
        stripeStatus: sub.status ?? "",
        ...(sub.current_period_end
          ? { currentPeriodEnd: sub.current_period_end * 1000 }
          : {}),
        ...(sub.items?.data?.[0]?.price?.unit_amount != null
          ? { amountCents: sub.items.data[0].price.unit_amount }
          : {}),
      });
    } else if (event.type === "customer.subscription.deleted") {
      await ctx.runMutation(internal.givingPledges.cancelPledgeSubscription, {
        subscriptionId: event.data.object.id,
      });
    } else if (event.type === "charge.dispute.created") {
      // MONEY COMING BACK OUT, weeks after it went in. A bank can return a
      // settled ACH debit for up to 60 calendar days, and Stripe raises that
      // as a dispute — so a gift recorded in September can evaporate in
      // November with the donor's lifetime total, the scope rollup and the
      // launch pot all still counting it.
      //
      // `data.object` here is the Dispute, so its id is the `dp_…` id, and
      // `charge`/`payment_intent` are what point back at a gift.
      //
      // Handed to an action because resolving a dispute to a gift needs Stripe
      // (a `/give` gift persists no charge or PaymentIntent id — see
      // `givingReversals.ts`). NOT gated on the event-id ledger, on purpose:
      // the reversal is idempotent on the DISPUTE id, which also survives a
      // replay after a failed attempt. Gating here would let one crash lose a
      // reversal permanently.
      const dispute = event.data.object;
      await ctx.scheduler.runAfter(0, internal.givingReversals.onDisputeCreated, {
        disputeId: dispute.id,
        ...(dispute.charge ? { chargeId: dispute.charge } : {}),
        ...(dispute.payment_intent
          ? { paymentIntentId: dispute.payment_intent }
          : {}),
        ...(dispute.reason ? { reason: dispute.reason } : {}),
        ...(dispute.status ? { status: dispute.status } : {}),
        ...(dispute.amount !== undefined ? { amountCents: dispute.amount } : {}),
      });
    } else if (event.type === "charge.dispute.closed") {
      // Won means the money came back and the reversal has to be reversed.
      // Every other closing status either confirms the reversal (`lost`) or
      // never moved money in the first place (the `warning_*` inquiry ones).
      const dispute = event.data.object;
      await ctx.scheduler.runAfter(0, internal.givingReversals.onDisputeClosed, {
        disputeId: dispute.id,
        ...(dispute.status ? { status: dispute.status } : {}),
      });
    } else if (event.type.startsWith("payout.")) {
      // Morning reconciliation engine fast-path: a payout event
      // (`payout.paid` is the one that matters; created/updated/failed keep
      // the stored status fresh) schedules a single-payout engine pass —
      // detect, allocate the per-book transfer pairs, and try the deposit
      // match — so the books don't wait for the morning cron. Dedup on the
      // provider event id (Stripe redelivers); the engine itself is
      // idempotent on top of that, so a duplicate slipping through books
      // nothing twice. `data.object` is the Payout, so its id is the `po_…`
      // id. NOTE: Stripe only sends these if payout events are enabled on
      // the webhook endpoint — the daily cron is the backstop either way.
      const { isNew } = await ctx.runMutation(
        internal.webhooks.recordWebhookEvent,
        { provider: "stripe", eventId: event.id, summary: event.type },
      );
      if (isNew) {
        await ctx.scheduler.runAfter(
          0,
          internal.reconciliation.processPayoutEvent,
          { stripePayoutId: event.data.object.id },
        );
      }
    }
    return new Response("ok", { status: 200 });
  }),
});

// ── Increase webhook ─────────────────────────────────────────────────────────

http.route({
  path: "/increase/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.INCREASE_WEBHOOK_SECRET;
    if (!secret) {
      console.error("[increase] INCREASE_WEBHOOK_SECRET not set");
      return new Response("Not configured", { status: 500 });
    }
    const payload = await req.text();
    // Standard Webhooks (https://increase.com/documentation/webhooks): three
    // headers — verify the raw body against them.
    const valid = await verifyIncreaseSignature(payload, {
      webhookId: req.headers.get("webhook-id"),
      webhookTimestamp: req.headers.get("webhook-timestamp"),
      webhookSignature: req.headers.get("webhook-signature"),
    }, secret);
    if (!valid) return new Response("Invalid signature", { status: 400 });

    // Increase Event: { id, created_at, category, associated_object_type,
    // associated_object_id, type:"event" } — NO inline object, dispatch by
    // `category` and fetch details by `associated_object_id`.
    const event = JSON.parse(payload) as {
      id: string;
      category: string;
      associated_object_id?: string;
      type: string;
    };
    const objectId = event.associated_object_id;

    if (event.category === "real_time_decision.card_authorization_requested") {
      // SYNCHRONOUS card decision (the network holds the auth). NOT deduped —
      // Increase retries until it gets an action, and the decision is idempotent
      // on the RTD id. handleIncreaseRealTimeDecision fetches the RTD object,
      // decides, and POSTs the verdict; we await it before responding 200.
      if (objectId) {
        await ctx.runAction(internal.cards.handleIncreaseRealTimeDecision, {
          realTimeDecisionId: objectId,
        });
      }
      return new Response("ok", { status: 200 });
    }

    if (event.category === "real_time_decision.digital_wallet_token_requested") {
      // SYNCHRONOUS wallet-add decision (step 1 of 2 — WP-C.3). Same shape as
      // card_authorization above: NOT deduped (Increase retries until
      // actioned), awaited before responding 200.
      if (objectId) {
        await ctx.runAction(
          internal.cards.handleIncreaseDigitalWalletTokenRequested,
          { realTimeDecisionId: objectId },
        );
      }
      return new Response("ok", { status: 200 });
    }

    if (
      event.category === "real_time_decision.digital_wallet_authentication_requested"
    ) {
      // SYNCHRONOUS wallet-add 2FA (step 2 of 2 — WP-C.3): deliver the
      // already-generated one-time passcode and report delivery success.
      if (objectId) {
        await ctx.runAction(
          internal.cards.handleIncreaseDigitalWalletAuthenticationRequested,
          { realTimeDecisionId: objectId },
        );
      }
      return new Response("ok", { status: 200 });
    }

    // Everything else (ach_transfer.* …) → async: dedup on the event id, then
    // fetch-the-object + advance the matching payout's state machine.
    const { isNew } = await ctx.runMutation(
      internal.webhooks.recordWebhookEvent,
      { provider: "increase", eventId: event.id, summary: event.category },
    );
    if (isNew && objectId) {
      await ctx.runAction(internal.increase.handleIncreaseWebhook, {
        category: event.category,
        associatedObjectId: objectId,
      });
    }
    return new Response("ok", { status: 200 });
  }),
});

// ── Twilio inbound SMS webhook ────────────────────────────────────────────────
// Point a Messaging Service's inbound webhook at
// `https://<deployment>.convex.site/twilio/webhook` (see
// docs/plans/sms-comms.md's OPS section). Handles the STOP/START keyword
// family as a defense-in-depth mirror of Twilio's own Advanced Opt-Out
// (`smsOptOuts.ts`) — everything else is a silent no-op. Always responds with
// empty TwiML (`<Response/>`) so Twilio never auto-replies on our behalf.

// Uses the `emptyTwiml` helper defined above (── Helpers ──) — a `Response`'s
// body stream can only be read once, so a single shared instance can't
// safely back more than one webhook reply (this route can return it from
// more than one place per request, and is called on every redelivery).

const STOP_KEYWORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
]);
const START_KEYWORDS = new Set(["START", "UNSTOP", "YES"]);

http.route({
  path: "/twilio/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const creds = await resolveTwilioCredentials(ctx);
    if (!creds) {
      console.error("[twilio] webhook received but Twilio isn't configured");
      return new Response("Not configured", { status: 500 });
    }

    // Twilio POSTs application/x-www-form-urlencoded (From, Body, MessageSid…).
    const rawBody = await req.text();
    const form = new URLSearchParams(rawBody);
    const params: Record<string, string> = {};
    for (const [key, value] of form.entries()) params[key] = value;

    // Twilio signs against the exact URL it was configured to POST to — per
    // docs/plans/sms-comms.md's OPS section, that's the canonical
    // `<deployment>.convex.site/twilio/webhook` URL, i.e. `CONVEX_SITE_URL`
    // (Convex-provided) + this route's path. `req.url` is normally identical,
    // but isn't guaranteed to be — a fronting proxy, an unexpected scheme, or
    // a trailing slash can all make it diverge, which would silently reject
    // every real STOP/START (a compliance risk, not just a bug). Try the
    // canonical URL first when the env var is set, then fall back to
    // `req.url` — the fallback is also what keeps convex-test's simulated
    // `t.fetch` (which has no real CONVEX_SITE_URL-matching origin) working.
    const signatureHeader = req.headers.get("X-Twilio-Signature");
    const canonicalUrl = process.env.CONVEX_SITE_URL
      ? `${process.env.CONVEX_SITE_URL.replace(/\/+$/, "")}/twilio/webhook`
      : null;
    const valid =
      (canonicalUrl
        ? await validateTwilioSignature(canonicalUrl, params, signatureHeader, creds.authToken)
        : false) ||
      (await validateTwilioSignature(req.url, params, signatureHeader, creds.authToken));
    if (!valid) return new Response("Invalid signature", { status: 400 });

    // Dedup on MessageSid — Twilio can redeliver the same inbound webhook.
    const messageSid = params.MessageSid ?? params.SmsMessageSid ?? "";
    if (messageSid) {
      const { isNew } = await ctx.runMutation(
        internal.webhooks.recordWebhookEvent,
        {
          provider: "twilio",
          eventId: messageSid,
          summary: (params.Body ?? "").slice(0, 80),
        },
      );
      if (!isNew) return emptyTwiml();
    }

    const from = normalizePhone(params.From ?? "");
    const keyword = (params.Body ?? "").trim().toUpperCase();
    if (from) {
      if (STOP_KEYWORDS.has(keyword)) {
        await ctx.runMutation(internal.smsOptOuts.recordOptOut, {
          phone: from,
          source: "stop_webhook",
        });
      } else if (START_KEYWORDS.has(keyword)) {
        await ctx.runMutation(internal.smsOptOuts.clearOptOut, { phone: from });
      }
      // Any other message (a reply, a stray text) is a silent no-op — nothing
      // else in this app expects two-way SMS conversation.
    }
    return emptyTwiml();
  }),
});

// ── Resend inbound receipt webhook ───────────────────────────────────────────
// Receipts emailed to `reply.publicworship.life` land here as Resend
// `email.received` events (delivered via Svix / Standard Webhooks — the SAME
// signature scheme as Increase, so both share `verifyStandardWebhookSignature`,
// just under `svix-*` header names). We verify, DEDUPE + record the email
// (`recordInboundReceipt`, idempotent on the provider's `email_id`), then
// schedule the OCR→match pipeline and ack 200 fast. See `receiptInbox.ts`.
//
// NOTE: this is a DIFFERENT route from `/resend/webhook` below (campaign
// bounce/complaint + reply-forwarding events) — both are Resend webhooks, but
// point at different Resend endpoints/domains and must never be collapsed
// into one handler.
//
// The signing secret resolves stored-setting-first (`integrationSettings`,
// set in-app at profile > integrations by a superuser), falling back to the
// `RESEND_INBOUND_WEBHOOK_SECRET` env var — same discipline as
// `givebutterSync.ts` / `lib/twilio.ts`.

http.route({
  path: "/resend/inbound",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret =
      (await ctx.runQuery(
        internal.integrationSettings.readResendInboundWebhookSecret,
        {},
      )) ?? process.env.RESEND_INBOUND_WEBHOOK_SECRET;
    if (!secret) {
      console.error(
        "[receiptInbox] Resend inbound webhook secret not configured (stored setting or RESEND_INBOUND_WEBHOOK_SECRET)",
      );
      return new Response("Not configured", { status: 500 });
    }
    const payload = await req.text();
    const valid = await verifyStandardWebhookSignature(
      payload,
      {
        id: req.headers.get("svix-id"),
        timestamp: req.headers.get("svix-timestamp"),
        signature: req.headers.get("svix-signature"),
      },
      secret,
    );
    if (!valid) return new Response("Invalid signature", { status: 400 });

    // Resend inbound: { type:"email.received", data:{ email_id, from, to[],
    // cc[], received_for[], subject, ... } }. Attachments/body are fetched
    // later via the Resend API (the webhook carries metadata only).
    //
    // `received_for` is the ENVELOPE recipient (RCPT TO), which is NOT the
    // same as the `to` header whenever the mail was relayed — exactly the
    // Google Group shape we run on: a human mails the group
    // (`receipts@publicworship.life`, which stays in `to`) and Google relays
    // the post to the group member that is our Resend inbound address
    // (`receipts@reply.publicworship.life`, which appears ONLY in
    // `received_for`). Route on all three or every group-forwarded receipt is
    // ack'd and dropped.
    let event: {
      type?: string;
      data?: {
        email_id?: string;
        from?: string;
        to?: string[] | string;
        cc?: string[] | string;
        received_for?: string[] | string;
        subject?: string;
      };
    };
    try {
      event = JSON.parse(payload);
    } catch {
      return new Response("Bad payload", { status: 400 });
    }
    // Ack anything that isn't an inbound email (Resend also delivers delivery/
    // bounce events to the same webhook if subscribed) — 200 so it isn't retried.
    if (event.type !== "email.received" || !event.data?.email_id || !event.data.from) {
      return new Response("ok", { status: 200 });
    }
    // Only mail addressed to the RECEIPTS inbox is a receipt — the inbound
    // domain will carry other addresses for other purposes, so everything else
    // is ack'd WITHOUT recording (see `isReceiptInboxAddress`).
    const asList = (v: string[] | string | undefined): string[] =>
      Array.isArray(v) ? v : v ? [v] : [];
    const toList = asList(event.data.to);
    const ccList = asList(event.data.cc);
    const receivedForList = asList(event.data.received_for);
    if (!isReceiptInboxAddress([...toList, ...ccList, ...receivedForList])) {
      return new Response("ok", { status: 200 });
    }
    // What the sender actually addressed (the group, on relayed mail), falling
    // back to the envelope recipient when there's no usable `to` header.
    const to = toList[0] ?? receivedForList[0];

    const { isNew, receiptId } = await ctx.runMutation(
      internal.receiptInbox.recordInboundReceipt,
      {
        envelope: {
          emailId: event.data.email_id,
          fromEmail: event.data.from,
          toEmail: to,
          subject: event.data.subject,
        },
      },
    );
    if (isNew) {
      await ctx.scheduler.runAfter(
        0,
        internal.receiptInbox.processInboundReceipt,
        { receiptId },
      );
    }
    return new Response("ok", { status: 200 });
  }),
});

// ── Twilio inbound SMS/MMS receipt webhook ───────────────────────────────────
// Receipts texted to the org's dedicated receipts number land here as a
// Twilio inbound-message webhook (form-encoded: `MessageSid`, `From`, `Body`,
// `NumMedia`, `MediaUrl{N}`, `MediaContentType{N}`). We verify Twilio's own
// signature scheme (`X-Twilio-Signature` — NOT Standard Webhooks, hence its
// own `verifyTwilioSignature`), DEDUPE + record the message
// (`recordSmsReceipt`, idempotent on `MessageSid`), then schedule the
// OCR→match pipeline and ack fast with an empty TwiML `<Response/>` (Twilio
// errors on a non-2xx/non-TwiML reply and will retry). See `smsReceipts.ts`.
//
// NOTE: this is a DIFFERENT route from `/twilio/webhook` above (the STOP/START
// opt-out handler) — same provider, disjoint paths, both must stay registered.
//
// The auth token resolves stored-setting-first (`integrationSettings`, set
// in-app at profile > integrations by a superuser), falling back to the
// `TWILIO_AUTH_TOKEN` env var — the SAME discipline (and the SAME trio) every
// other Twilio call in this repo uses (`lib/twilio.ts#resolveTwilioCredentials`).
//
// SIGNATURE SUBTLETY: Twilio signs the EXACT URL it posted to. If the number's
// webhook points directly at this Convex deployment's site origin (the
// documented setup — see `docs/plans/receipt-email-ingest.md`'s SMS section),
// `req.url` here already matches. If it were instead pointed at the
// `pw-router`-proxied `publicworship.life` path, the Worker rewrites the
// request's host before forwarding, so `req.url` would differ from what
// Twilio signed — `TWILIO_RECEIPTS_WEBHOOK_URL` exists to override the
// default for that case (see `smsReceipts.ts#resolveTwilioReceiptsWebhookUrl`).

http.route({
  path: "/twilio/receipts",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const creds = await resolveTwilioCredentials(ctx);
    if (!creds) {
      console.error(
        "[smsReceipts] Twilio not configured (stored setting or TWILIO_* env) — can't verify inbound signature.",
      );
      return new Response("Not configured", { status: 500 });
    }

    const bodyText = await req.text();
    const params = Object.fromEntries(new URLSearchParams(bodyText));
    const url = resolveTwilioReceiptsWebhookUrl(req);
    const signature = req.headers.get("X-Twilio-Signature");
    const valid = await verifyTwilioSignature(url, params, creds.authToken, signature);
    if (!valid) return new Response("Invalid signature", { status: 403 });

    const messageSid = params.MessageSid;
    const from = params.From;
    if (!messageSid || !from) {
      // Malformed/unexpected payload from an otherwise-authenticated request —
      // ack anyway so Twilio doesn't retry-storm a request it will never fix.
      return emptyTwiml();
    }

    const numMedia = Math.max(0, parseInt(params.NumMedia ?? "0", 10) || 0);
    const media: { url: string; contentType?: string }[] = [];
    for (let i = 0; i < numMedia; i++) {
      const mediaUrl = params[`MediaUrl${i}`];
      if (mediaUrl) {
        media.push({ url: mediaUrl, contentType: params[`MediaContentType${i}`] });
      }
    }

    const { isNew, receiptId } = await ctx.runMutation(
      internal.smsReceipts.recordSmsReceipt,
      {
        envelope: { messageSid, fromPhone: from, body: params.Body },
      },
    );
    if (isNew) {
      await ctx.scheduler.runAfter(0, internal.smsReceipts.processSmsReceipt, {
        receiptId,
        body: params.Body,
        media,
      });
    }
    return emptyTwiml();
  }),
});

// ── Public reimbursement page: /reimburse/<chapterSlug>[?token=] ─────────────
// The accountless claimant surface (matches reimburse.html). No token → the
// blank submission form for the chapter; with a token → that request's status
// timeline. The client script POSTs to the /api/reimburse/* routes above.

http.route({
  pathPrefix: "/reimburse/",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean); // ["reimburse", slug]
    const rawSlug = segments[1];
    if (!rawSlug) return html(renderReimburseNotFound(), 404);
    let slug: string;
    try {
      slug = decodeURIComponent(rawSlug);
    } catch {
      return html(renderReimburseNotFound(), 404);
    }

    const chapter = await ctx.runQuery(
      api.lib.reimburseApiRoutes.chapterForReimburse,
      { slug },
    );
    if (!chapter) return html(renderReimburseNotFound(), 404);

    const token = url.searchParams.get("token");
    if (token) {
      const view = await ctx.runQuery(
        api.reimbursements.getPublicReimbursement,
        { token },
      );
      return view
        ? html(renderReimburseStatus(view, chapter.name, token, slug))
        : html(renderReimburseNotFound(), 404);
    }
    return html(renderReimburseForm(chapter));
  }),
});

// ── Public contractor page: /contract/<chapterSlug>[?token=] ────────────────
// The accountless contractor surface, sibling of /reimburse/ above and served
// the same way. Three states, chosen by the token and by the payment's own
// status:
//   no token          → the BLANK self-serve request form for the chapter.
//   token + canEdit   → the PRE-FILLED agreement (terms read-only), which is
//                       also where a sent-back payment lands.
//   token + !canEdit  → the read-only status timeline.
// `contractorCanEdit` is the single answer to "is this link still open?" — the
// server enforces it in every public mutation and this route merely reflects
// it, so a stale bookmark renders status rather than an editable form whose
// submit would be refused. The client script POSTs to /api/contract/* above.

http.route({
  pathPrefix: "/contract/",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean); // ["contract", slug]
    const rawSlug = segments[1];
    if (!rawSlug) return html(renderContractNotFound(), 404);
    let slug: string;
    try {
      slug = decodeURIComponent(rawSlug);
    } catch {
      return html(renderContractNotFound(), 404);
    }

    const chapter = await ctx.runQuery(
      api.contractorPayments.chapterForContract,
      { chapterSlug: slug },
    );
    if (!chapter) return html(renderContractNotFound(), 404);

    const token = url.searchParams.get("token");
    if (token) {
      const view = await ctx.runQuery(api.contractorPayments.publicByToken, {
        token,
      });
      if (!view) return html(renderContractNotFound(), 404);
      return view.canEdit
        ? html(renderContractAgreement(view, slug, token))
        : html(renderContractStatus(view, slug));
    }
    // The chapter row's own `slug` is optional in the schema; the page needs a
    // definite one to POST with, so the decoded path segment (which is what
    // resolved the chapter in the first place) is what it gets.
    return html(renderContractForm({ ...chapter, slug }));
  }),
});

// ── Bulk email: /unsubscribe/<token> ─────────────────────────────────────────
// Where a bulk email's unsubscribe link (and its `List-Unsubscribe` header)
// lands — BOTH a campaign recipient's token and an event BLAST recipient's
// (`blasts.ts`; the resolvers in `campaigns.ts` check both tables, so this
// route stays a single code path — see its section note there).
// GET is read-only (mail scanners prefetch links); the actual
// suppression write only happens on POST — either the page's own confirm
// button, or a mail client's automatic RFC 8058 one-click
// `List-Unsubscribe-Post: List-Unsubscribe=One-Click` POST (same handler,
// same immediate effect — no separate confirmation step for either).

http.route({
  pathPrefix: "/unsubscribe/",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean); // ["unsubscribe", token]
    const token = decodeURIComponent(segments[1] ?? "");
    if (!token || segments.length > 2) return html(renderUnsubscribeNotFound(), 404);
    const recipient = await ctx.runQuery(internal.campaigns.getRecipientByToken, { token });
    if (!recipient) return html(renderUnsubscribeNotFound(), 404);
    return html(renderUnsubscribeConfirm(recipient.email, token));
  }),
});

http.route({
  pathPrefix: "/unsubscribe/",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean); // ["unsubscribe", token]
    const token = decodeURIComponent(segments[1] ?? "");
    if (!token || segments.length > 2) return html(renderUnsubscribeNotFound(), 404);
    const result = await ctx.runMutation(internal.campaigns.unsubscribeByToken, { token });
    if (!result) return html(renderUnsubscribeNotFound(), 404);
    return html(renderUnsubscribeDone(result.email));
  }),
});

// ── Email campaigns: /poll/<campaignId>/<token>/<blockId>/<optionId> ─────────
// Where a `poll` block's option link lands. EXACTLY the same GET-reads /
// POST-writes split as /unsubscribe/ above, and for a sharper version of the
// same reason: Apple Mail Privacy Protection and corporate link scanners
// prefetch EVERY href in a message, so recording a vote on GET would hand
// every option in every poll a phantom vote at delivery time — the tally would
// be wrong before the first human opened the email. GET renders a confirm page
// and writes nothing; the vote is recorded only by that page's POST.
//
// The token is the recipient's own `unsubscribeToken` (reused rather than
// minting a second per-recipient secret). `campaignPolls.ts` verifies all four
// segments line up — including that `optionId` is really one of that block's
// options — so a hand-edited URL 404s instead of inventing a tally row.

/** Split a `/poll/` path into its four segments, or `null` if it isn't shaped
 *  like one. Shared by both handlers so GET and POST can never disagree about
 *  what a valid poll URL looks like. */
function parsePollPath(
  pathname: string,
): { campaignId: string; token: string; blockId: string; optionId: string } | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 5) return null;
  try {
    const [, campaignId, token, blockId, optionId] = segments.map(decodeURIComponent);
    if (!campaignId || !token || !blockId || !optionId) return null;
    return { campaignId, token, blockId, optionId };
  } catch {
    return null; // malformed percent-encoding
  }
}

http.route({
  pathPrefix: "/poll/",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const parsed = parsePollPath(url.pathname);
    if (!parsed) return html(renderPollNotFound(), 404);
    // `v.id("campaigns")` throws on a string that isn't a well-formed id for
    // the table, so a guessed/garbage first segment is caught here and turned
    // into the same 404 every other mismatch produces (the
    // `findCampaignByPlusAddress` precedent).
    let view;
    try {
      view = await ctx.runQuery(internal.campaignPolls.getPollContext, {
        campaignId: parsed.campaignId as Id<"campaigns">,
        token: parsed.token,
        blockId: parsed.blockId,
        optionId: parsed.optionId,
      });
    } catch {
      return html(renderPollNotFound(), 404);
    }
    if (!view) return html(renderPollNotFound(), 404);
    return html(
      renderPollConfirm({
        theme: view.theme,
        question: view.question,
        optionLabel: view.optionLabel,
        // Post back to the very path this page was fetched at — already
        // percent-encoded, since it came off the request URL.
        actionPath: url.pathname,
      }),
    );
  }),
});

http.route({
  pathPrefix: "/poll/",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const parsed = parsePollPath(url.pathname);
    if (!parsed) return html(renderPollNotFound(), 404);
    let result;
    try {
      result = await ctx.runMutation(internal.campaignPolls.recordPollVote, {
        campaignId: parsed.campaignId as Id<"campaigns">,
        token: parsed.token,
        blockId: parsed.blockId,
        optionId: parsed.optionId,
      });
    } catch {
      return html(renderPollNotFound(), 404);
    }
    if (!result) return html(renderPollNotFound(), 404);
    // Tally is read in a SEPARATE transaction from the vote write. Computing
    // it inside `recordPollVote` made every voter's read set overlap every
    // other voter's write on the same index range — guaranteed OCC contention
    // under a real blast. A count that is a moment stale on a confirmation
    // page is a much better trade than a contended write path.
    const tally = await ctx.runQuery(internal.campaignPolls.getPollTally, {
      campaignId: parsed.campaignId as Id<"campaigns">,
      blockId: parsed.blockId,
    });
    return html(
      renderPollThanks({
        theme: result.theme,
        optionLabel: result.optionLabel,
        tally: tally
          ? {
              question: tally.question,
              totalVotes: tally.totalVotes,
              options: tally.options,
            }
          : { question: result.question, totalVotes: 0, options: [] },
      }),
    );
  }),
});

// ── Resend webhook (bounces/complaints/inbound replies) ─────────────────────
// Verified via Svix (`lib/resend.ts#verifyResendWebhookSignature`) against
// the stored `resendWebhookSecret` (superuser-set,
// `integrationSettings.setEmailCampaignSettings`) — unverifiable (no secret
// on file) is a 401, never a silent accept. Deduped on the `svix-id` header
// through the shared `webhookEvents` ledger.

type ResendWebhookPayload = {
  type?: string;
  data?: {
    to?: string[] | string;
    from?: string;
    subject?: string;
    text?: string;
    html?: string;
    /** Present on `email.bounced`. Resend forwards the SES-shaped bounce
     *  classification: `type` is "Permanent" | "Transient" | "Undetermined",
     *  `subType` the finer reason ("General", "MailboxFull",
     *  "Suppressed", …). Older/other payload shapes say "hard"/"soft"
     *  instead, which `classifyBounce` also understands. */
    bounce?: { type?: string; subType?: string; message?: string };
  };
};

/**
 * Is this bounce PERMANENT (the address is genuinely dead) or TRANSIENT (a
 * full mailbox, a greylisting 4xx, a momentarily unreachable server)?
 *
 * Every `email.bounced` event used to be treated as permanent, which meant one
 * temporary 4xx from a recipient's mail server put a perfectly good address on
 * the do-not-email list FOREVER — with no un-suppress mutation to undo it and
 * no screen that would have shown it happened. Soft bounces are common and
 * self-resolving; suppressing on one is a self-inflicted deliverability wound.
 *
 * "Undetermined" (and a payload with no classification at all) stays on the
 * SUPPRESS side deliberately: a bounce we can't classify is more likely a real
 * delivery failure than a transient blip, and continuing to mail an address
 * that hard-bounces is what actually damages the sending domain's reputation.
 * The un-suppress mutation (`emailSuppressions.unsuppressEmail`) is the
 * recovery path for the rare wrong call — which is precisely why it had to
 * exist before this could be relaxed at all.
 */
function classifyBounce(
  bounce: { type?: string; subType?: string } | undefined,
): "permanent" | "transient" {
  const raw = (bounce?.type ?? "").trim().toLowerCase();
  if (raw === "transient" || raw === "soft") return "transient";
  return "permanent";
}

/** "Name <email>" → { name, email }; a bare address → { name: null, email }. */
function parseFromHeader(raw: string): { name: string | null; email: string } {
  const match = /^(.*)<(.+)>$/.exec(raw.trim());
  if (match) {
    const name = match[1].trim().replace(/^"|"$/g, "");
    return { name: name || null, email: match[2].trim() };
  }
  return { name: null, email: raw.trim() };
}

/** Bare addresses from a `to` field — Resend may deliver each entry as a
 *  bare address OR the same "Display Name <addr>" form `from` carries (e.g.
 *  a reply sent via a mail client that copies the campaign's plus-address
 *  into `To:` with a name attached), so this reuses `parseFromHeader`'s
 *  angle-bracket stripping rather than matching on the raw string — an
 *  unparsed "Jane <campaign+x@dom>" would never match the plus-address regex
 *  in `findCampaignByPlusAddress`. */
function toAddressList(to: string[] | string | undefined): string[] {
  if (!to) return [];
  const list = Array.isArray(to) ? to : [to];
  return list.map((raw) => parseFromHeader(raw).email);
}

http.route({
  path: "/resend/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = await ctx.runQuery(internal.integrationSettings.readResendWebhookSecret, {});
    if (!secret) {
      console.error("[resend] webhook received but resendWebhookSecret isn't set");
      return new Response("Not configured", { status: 401 });
    }
    const payload = await req.text();
    const valid = await verifyResendWebhookSignature(payload, {
      svixId: req.headers.get("svix-id"),
      svixTimestamp: req.headers.get("svix-timestamp"),
      svixSignature: req.headers.get("svix-signature"),
    }, secret);
    if (!valid) return new Response("Invalid signature", { status: 401 });

    const svixId = req.headers.get("svix-id") ?? "";
    if (svixId) {
      const { isNew } = await ctx.runMutation(internal.webhooks.recordWebhookEvent, {
        provider: "resend",
        eventId: svixId,
      });
      if (!isNew) return new Response("ok", { status: 200 });
    }

    const event = JSON.parse(payload) as ResendWebhookPayload;
    const type = event.type ?? "";
    const toList = toAddressList(event.data?.to);

    if (type === "email.bounced" || type === "email.complained") {
      const reason = type === "email.bounced" ? "bounce" : "complaint";
      // A complaint is always the recipient's own deliberate "stop" — only a
      // BOUNCE gets classified (see `classifyBounce`).
      const permanent =
        type === "email.complained" || classifyBounce(event.data?.bounce) === "permanent";
      if (!permanent) {
        console.log(
          `[resend] soft bounce for ${toList.length} address(es) — not suppressed (${event.data?.bounce?.subType ?? "no subType"})`,
        );
      } else {
        for (const address of toList) {
          await ctx.runMutation(internal.emailSuppressions.recordSuppression, {
            email: address,
            reason,
            note:
              type === "email.bounced" && event.data?.bounce?.subType
                ? `Hard bounce: ${event.data.bounce.subType}`
                : undefined,
          });
        }
      }
    } else if (type.includes("receiv") || type === "inbound" || type.startsWith("inbound.")) {
      // Inbound reply — match the campaign via the `campaign+<id>@<domain>`
      // plus-address the send set as reply-to (whichever `to` entry carries
      // it; an inbound message may be addressed to more than one recipient).
      let campaignId: Id<"campaigns"> | null = null;
      for (const address of toList) {
        campaignId = await ctx.runQuery(internal.campaigns.findCampaignByPlusAddress, {
          address,
        });
        if (campaignId) break;
      }
      const from = parseFromHeader(event.data?.from ?? "");
      try {
        await ctx.runMutation(internal.campaigns.recordInboundReply, {
          campaignId: campaignId ?? undefined,
          fromEmail: from.email,
          fromName: from.name ?? undefined,
          subject: event.data?.subject,
          textBody: event.data?.text,
          htmlBody: event.data?.html,
        });
        if (campaignId) {
          // Best-effort forward to the campaign's per-campaign sender
          // (`fromEmail`), when it has one — SCHEDULED (not awaited inline)
          // so the webhook response stays fast; `forwardReplyToSender`
          // no-ops on its own when the campaign has no `fromEmail` and never
          // throws (catches + logs internally).
          await ctx.scheduler.runAfter(0, internal.campaigns.forwardReplyToSender, {
            campaignId,
            replyFromEmail: from.email,
            replyFromName: from.name ?? undefined,
            replyText: event.data?.text,
          });
        }
      } catch (err) {
        // A malformed/oversized payload should never turn into a Resend
        // retry storm (Resend retries non-2xx webhook responses) — log and
        // still 200, mirroring the other providers' swallow-and-log paths
        // (e.g. `increaseLedger.ingestIncreaseTransaction`).
        console.error("[resend] failed to record inbound reply", err);
      }
    }
    // Unknown event types (delivery, open/click tracking if ever enabled…)
    // are a silent no-op — this route only cares about deliverability
    // signals and inbound replies.
    return new Response("ok", { status: 200 });
  }),
});

export default http;
