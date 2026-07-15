import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { auth } from "./auth";
import {
  renderIcs,
  renderLandingPage,
  renderNotFound,
  renderTicketPage,
} from "./lib/landingPage";
import { registerTicketApiRoutes } from "./lib/ticketApiRoutes";
import { registerReimburseApiRoutes } from "./lib/reimburseApiRoutes";
import {
  renderReimburseForm,
  renderReimburseStatus,
  renderReimburseNotFound,
} from "./lib/reimbursePage";
import {
  renderProjectActionGone,
  renderProjectActionPage,
  renderProjectActionResult,
} from "./lib/projectActionPage";
import { EMAIL_ACTION_STATUSES, type EmailActionStatus } from "./projectActions";
import { appUrl, siteUrl } from "./lib/siteUrl";
import { verifyStripeSignature } from "./stripe";
import { verifyIncreaseSignature } from "./increase";

const http = httpRouter();

// Auth routes (handles OTP verification callbacks)
auth.addHttpRoutes(http);

// JSON API for the landing page's client script (/api/tickets/*).
registerTicketApiRoutes(http);

// JSON API for the public reimbursement page's client script (/api/reimburse/*).
registerReimburseApiRoutes(http);

// ── Helpers ──────────────────────────────────────────────────────────────────

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ── Public event pages: /e/<slug>[/cover|/calendar.ics] ─────────────────────

http.route({
  pathPrefix: "/e/",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean); // ["e", slug, ...]
    const slug = decodeURIComponent(segments[1] ?? "");
    const sub = segments[2] ?? null;
    if (!slug) return html(renderNotFound(), 404);

    // Cover image — public so OG scrapers (iMessage) can fetch it.
    if (sub === "cover") {
      const storageId = await ctx.runQuery(
        internal.ticketing.getCoverStorageId,
        { slug },
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

    const page = await ctx.runQuery(api.ticketing.getPublicPage, { slug });
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
  }),
});

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
      data: { object: { id: string; payment_intent?: string | null } };
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
      const paymentIntentId = event.data.object.payment_intent ?? undefined;
      // One shared session id is either a ticket order OR a donation. Try the
      // order first; only if it wasn't an order do we try the donation. Each
      // path is idempotent (safe on webhook redelivery) and no-ops when the
      // session isn't theirs, so neither can touch the other's rows.
      const wasOrder = await ctx.runMutation(internal.ticketing.markSessionPaid, {
        sessionId,
        paymentIntentId,
      });
      if (!wasOrder) {
        const wasDonation = await ctx.runMutation(
          internal.giving.markDonationPaid,
          { sessionId, paymentIntentId },
        );
        if (!wasDonation) {
          console.error(`[stripe] webhook for unknown session ${sessionId}`);
        }
      }
    } else if (event.type === "checkout.session.expired") {
      // Same fan-out for the abandoned-checkout case — each no-ops if not theirs.
      await ctx.runMutation(internal.ticketing.cancelPendingOrder, { sessionId });
      await ctx.runMutation(internal.giving.cancelPendingDonation, { sessionId });
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

export default http;
