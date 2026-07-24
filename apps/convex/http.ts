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
 * `/p/`, `/reimburse/`); the payment-provider webhook receivers
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
import {
  renderReimburseForm,
  renderReimburseStatus,
  renderReimburseNotFound,
} from "./lib/reimbursePage";
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

// JSON API for the public giving map's become-a-backer form (/api/give/*).
registerGiveApiRoutes(http);

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
// once the event is over. Read-only, no PII; a short cache keeps it fresh
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
    const [territories, interestStats] = await Promise.all([
      ctx.runQuery(api.territories.getPublicMapData, {}),
      ctx.runQuery(api.givingInterest.publicInterestStats, {}),
    ]);
    return html(
      renderGiveMapPage(territories, interestStats, thankYou, siteUrl()),
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

    const [data, interestStats, activity] = await Promise.all([
      ctx.runQuery(api.territories.getPublicTerritory, { slug }),
      ctx.runQuery(api.givingInterest.publicInterestStats, {}),
      ctx.runQuery(api.givingActivity.getTerritoryActivity, { slug }),
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
      ),
    );
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
          // invoice.paid / invoice.payment_failed:
          amount_paid?: number;
          // customer.subscription.updated / .deleted:
          status?: string;
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
      if (obj.metadata?.giveDonation === "1") {
        // A one-time "give" checkout — settle it via the single gifts write
        // path (`recordGiveDonationPaid`, idempotent on the session id). Amount
        // is read from the session's own `amount_total`, never a client value.
        // Handled BEFORE the pledge/order/donation fan-out: a give session
        // carries no pledgeId and is neither an order nor an event donation, so
        // without this branch it would fall through to the "unknown session"
        // error log.
        await ctx.runMutation(internal.givingDonations.recordGiveDonationPaid, {
          sessionId: obj.id,
          amountTotalCents: obj.amount_total ?? 0,
          donorId: obj.metadata.giveDonorId ?? "",
          scope: obj.metadata.giveScope ?? "",
        });
        // Flip the giver's optional activity-wall entry visible with the SETTLED
        // one-time amount (no-op if they didn't opt in). See givingActivity.ts.
        await ctx.runMutation(internal.givingActivity.markActivityVisible, {
          refKey: `give:${obj.id}`,
          amountCents: obj.amount_total ?? 0,
        });
      } else if (obj.metadata?.pledgeId) {
        const pledgeId = obj.metadata.pledgeId;
        // A BACKER (subscription) checkout — identified by our pledge id in the
        // session metadata (a ticket/donation session carries none). Activate
        // the pledge + link its Stripe customer/subscription. Idempotent, and a
        // no-op if the id doesn't resolve — so it can't touch other rows.
        await ctx.runMutation(
          internal.givingPledges.activatePledgeFromCheckout,
          {
            pledgeId,
            ...(obj.customer ? { stripeCustomerId: obj.customer } : {}),
            ...(obj.subscription
              ? { stripeSubscriptionId: obj.subscription }
              : {}),
          },
        );
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
        const wasOrder = await ctx.runMutation(
          internal.ticketing.markSessionPaid,
          { sessionId, paymentIntentId },
        );
        if (!wasOrder) {
          const wasDonation = await ctx.runMutation(
            internal.giving.markDonationPaid,
            { sessionId, paymentIntentId },
          );
          if (!wasDonation) {
            console.error(`[stripe] webhook for unknown session ${sessionId}`);
          }
        }
      }
    } else if (event.type === "checkout.session.expired") {
      // Same fan-out for the abandoned-checkout case — each no-ops if not theirs.
      await ctx.runMutation(internal.ticketing.cancelPendingOrder, { sessionId });
      await ctx.runMutation(internal.giving.cancelPendingDonation, { sessionId });
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
    // cc[], subject, ... } }. Attachments/body are fetched later via the
    // Resend API (the webhook carries metadata only).
    let event: {
      type?: string;
      data?: {
        email_id?: string;
        from?: string;
        to?: string[] | string;
        cc?: string[] | string;
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
    // Only mail addressed (To or Cc) to the RECEIPTS inbox is a receipt — the
    // inbound domain will carry other addresses for other purposes, so
    // everything else is ack'd WITHOUT recording (see `isReceiptInboxAddress`).
    const toList = Array.isArray(event.data.to)
      ? event.data.to
      : event.data.to
        ? [event.data.to]
        : [];
    const ccList = Array.isArray(event.data.cc)
      ? event.data.cc
      : event.data.cc
        ? [event.data.cc]
        : [];
    if (!isReceiptInboxAddress([...toList, ...ccList])) {
      return new Response("ok", { status: 200 });
    }
    const to = toList[0];

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

// ── Email campaigns: /unsubscribe/<token> ────────────────────────────────────
// Where a campaign email's unsubscribe link (and its `List-Unsubscribe`
// header) lands. GET is read-only (mail scanners prefetch links); the actual
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
  };
};

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
      for (const address of toList) {
        await ctx.runMutation(internal.emailSuppressions.recordSuppression, {
          email: address,
          reason,
        });
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
        // (e.g. `ingestIncreaseCardTransaction`).
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
