import { defineTable } from "convex/server";
import { v } from "convex/values";
import { DONOR_STATUSES } from "./givingPlatform";

/**
 * Email campaigns — the in-app newsletter/announcement composer, distinct
 * from `schema/ticketing.ts`'s per-EVENT `blasts` (which only reach an
 * event's own RSVP list). A campaign targets a saved, reusable `audiences`
 * row (guests across every event, the donor CRM, or the roster) instead of
 * one event's attendee list, and is authored as a block document
 * (`EmailDocument`, `@events-os/shared`'s `emailBlocks.ts`/`emailRender.ts`)
 * rather than a single body string.
 *
 * This whole surface is CENTRAL-only (see `lib/campaignsAccess.ts`) — a
 * chapter admin doesn't get a campaigns tab; `scope` records WHOSE audience
 * this is (a real chapter, or the `"central"` org-wide sentinel — same
 * `givingScope` union `schema/givingPlatform.ts` uses), not a chapter-admin
 * access boundary.
 *
 * Lifecycle (`campaigns.ts`): draft → `send` validates + flips `status` to
 * "sending" → `materializeRecipients` (internalAction) resolves the audience
 * into `campaignRecipients` rows (one per email, each carrying its own
 * `unsubscribeToken`, the rsvps.token precedent) → `deliverCampaignBatch`
 * (internalAction, self-rescheduling) sends up to 100 at a time via Resend's
 * batch endpoint (one HTTP request per action invocation) and updates each
 * row, paced ~600ms between batches to stay under Resend's rate limit → the
 * campaign is finalized with rollup counts. Delivery never throws on a
 * per-recipient failure — mirrors `blasts.ts#finishBlast`'s
 * recorded-failure-not-throw philosophy.
 *
 * `emailSuppressions` is the deployment-wide unsubscribe/bounce/complaint
 * ledger (`emailSuppressions.ts`) — checked at materialize time AND rechecked
 * right before each send (the `smsOptOuts` precedent), and also consulted by
 * `blasts.ts`'s email audience so a event blast never re-lands in an inbox
 * that unsubscribed from a campaign. `emailReplies` mirrors inbound mail
 * (Resend inbound webhook, matched to a campaign via the `campaign+<id>@...`
 * plus-address reply-to) so a reply is visible in-app without a separate
 * mailbox.
 */

const campaignsScope = v.union(v.id("chapters"), v.literal("central"));

export const AUDIENCE_SOURCES = ["guests", "donors", "people"] as const;

/**
 * Per-source optional filters, all in one object (a single audience only ever
 * uses the fields relevant to its own `source`; the rest sit unused rather
 * than needing a discriminated-union schema migration every time a new filter
 * is added):
 *  - `eventId` — guests only: restrict to one event's RSVPs (else every
 *    active chapter's events).
 *  - `chapterId` — guests/donors/people: restrict resolution to one chapter
 *    even when the audience's own `scope` is `"central"` (the fan-out scope).
 *  - `donorStatus` — donors only.
 *  - `gaveWithinDays` — donors only: "has given in the last N days" as of
 *    resolution time (a rolling window, not a frozen timestamp — a saved
 *    "gave this month" audience stays "this month" every time it's used).
 */
export const audienceFiltersValidator = v.object({
  eventId: v.optional(v.id("events")),
  chapterId: v.optional(v.id("chapters")),
  donorStatus: v.optional(v.union(...DONOR_STATUSES.map((s) => v.literal(s)))),
  gaveWithinDays: v.optional(v.number()),
});

/** A saved, reusable recipient definition a campaign targets. */
export const audiences = defineTable({
  scope: campaignsScope,
  name: v.string(),
  source: v.union(...AUDIENCE_SOURCES.map((s) => v.literal(s))),
  filters: audienceFiltersValidator,
  createdBy: v.id("users"),
  createdAt: v.number(),
  updatedAt: v.number(),
  archived: v.optional(v.boolean()),
}).index("by_scope", ["scope"]);

export const CAMPAIGN_STATUSES = ["draft", "sending", "sent", "failed"] as const;

/** A composed email + its send lifecycle. `doc` is an `EmailDocument`
 *  (`@events-os/shared`'s block model) — validated with `validateEmailDocument`
 *  at every write, so a malformed document never lands in the table. Stored
 *  as `v.any()` because Convex validators can't express a discriminated block
 *  union whose shape lives in a package this schema doesn't otherwise depend
 *  on; the app-level write path is the enforcement point. */
export const campaigns = defineTable({
  scope: campaignsScope,
  name: v.string(),
  subject: v.string(),
  previewText: v.optional(v.string()),
  audienceId: v.id("audiences"),
  doc: v.any(),
  status: v.union(...CAMPAIGN_STATUSES.map((s) => v.literal(s))),
  // Per-campaign sender ("from a person") — both optional; when `fromEmail`
  // is unset, sends fall back to the org's configured Resend from address.
  // `fromEmail`, when set, is validated at write time (`campaigns.ts`) to be
  // a bare address whose domain matches the org's Resend from-address
  // domain exactly — see `validateSenderFields`.
  fromName: v.optional(v.string()),
  fromEmail: v.optional(v.string()),
  recipientCount: v.optional(v.number()),
  sentCount: v.optional(v.number()),
  failedCount: v.optional(v.number()),
  suppressedCount: v.optional(v.number()),
  error: v.optional(v.string()),
  replyCount: v.optional(v.number()),
  // Set at materialize time (`campaigns.ts#materializeRecipients`) — true
  // when the resolved audience had more matches than
  // `lib/audienceResolve.ts#AUDIENCE_RESOLVE_LIMIT` and was truncated to the
  // cap. A durable record of what was true when this campaign was actually
  // sent (the live composer preview can drift after the fact as the
  // underlying data changes).
  audienceTruncated: v.optional(v.boolean()),
  createdBy: v.id("users"),
  createdAt: v.number(),
  updatedAt: v.number(),
  sentAt: v.optional(v.number()),
})
  .index("by_scope", ["scope"])
  .index("by_status", ["status"]);

export const CAMPAIGN_RECIPIENT_STATUSES = [
  "queued",
  "sent",
  "failed",
  "suppressed",
] as const;

/** One materialized recipient row per campaign send — the durable per-address
 *  delivery record `deliverCampaignBatch` walks and updates. `unsubscribeToken`
 *  is random (the `rsvps.token` precedent) and backs the public
 *  `/unsubscribe/<token>` link every send carries. */
export const campaignRecipients = defineTable({
  campaignId: v.id("campaigns"),
  email: v.string(), // normalized lowercase
  name: v.optional(v.string()),
  status: v.union(...CAMPAIGN_RECIPIENT_STATUSES.map((s) => v.literal(s))),
  error: v.optional(v.string()),
  unsubscribeToken: v.string(),
  sentAt: v.optional(v.number()),
})
  .index("by_campaign", ["campaignId"])
  .index("by_campaign_and_status", ["campaignId", "status"])
  .index("by_token", ["unsubscribeToken"])
  .index("by_email", ["email"]);

export const EMAIL_SUPPRESSION_REASONS = [
  "unsubscribe",
  "bounce",
  "complaint",
  "manual",
] as const;

/** Deployment-wide (NOT chapter-scoped — an address that unsubscribes or
 *  bounces stays suppressed for every chapter's/campaign's mail, the
 *  `smsOptOuts` precedent) do-not-email ledger. Consulted by campaign
 *  materialization/delivery AND `blasts.ts`'s email audience. */
export const emailSuppressions = defineTable({
  email: v.string(), // normalized lowercase
  reason: v.union(...EMAIL_SUPPRESSION_REASONS.map((r) => v.literal(r))),
  campaignId: v.optional(v.id("campaigns")),
  note: v.optional(v.string()),
  createdAt: v.number(),
}).index("by_email", ["email"]);

/** An inbound reply to a campaign send, captured via the Resend inbound
 *  webhook (matched to a campaign by the `campaign+<id>@<inboundDomain>`
 *  reply-to plus-address). `campaignId` is optional — an inbound message that
 *  doesn't match any campaign (a stray reply, a bounce notice Resend also
 *  routes through inbound) still gets a row so nothing silently vanishes. */
export const emailReplies = defineTable({
  campaignId: v.optional(v.id("campaigns")),
  fromEmail: v.string(),
  fromName: v.optional(v.string()),
  subject: v.optional(v.string()),
  textBody: v.optional(v.string()),
  htmlBody: v.optional(v.string()),
  receivedAt: v.number(),
  read: v.optional(v.boolean()),
})
  .index("by_campaign", ["campaignId"])
  .index("by_time", ["receivedAt"]);
