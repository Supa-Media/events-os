import { defineTable } from "convex/server";
import { v } from "convex/values";
import { DONOR_STATUSES } from "./givingPlatform";
import { RSVP_STATUSES } from "./ticketing";

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
 *
 * ── Two-party approval (founder requirement, 2026-07-24) ─────────────────────
 * Every MASS send (never a test-send, never transactional mail, and event
 * blasts are explicitly OUT of scope — see `schema/ticketing.ts#blasts`) now
 * needs sign-off from a DIFFERENT person holding campaign-approval power
 * before it can go out — even the Executive Director needs another
 * approval-power holder (e.g. the Marketing Director) to approve their send.
 * `draft → pending_approval → approved → sending` is the happy path;
 * `changes_requested` and `denied` are the reviewer's two "no" outcomes (see
 * `campaigns.ts`'s state-machine doc for the full mutation-by-mutation
 * walkthrough). The reviewer is CHOSEN at submit time (`reviewerPersonId`) —
 * not a broadcast to every approver — and only that person may decide.
 * `approvedSnapshotHash` binds a decision to the EXACT content/audience-
 * definition that was reviewed (recomputed and compared at approve time and
 * again at send time — a content or audience-definition edit after approval
 * invalidates it, forcing re-submission rather than silently shipping
 * something the reviewer never actually saw). `campaignApprovalLog` (below)
 * is the permanent, append-only decision history — mirrors
 * `schema/finances.ts#budgetApprovalLog`.
 */

const campaignsScope = v.union(v.id("chapters"), v.literal("central"));

/**
 * `"person_filters"` is the Phase 3 (specs/person-centric-audiences.md)
 * founder-facing source — "the source is always the people table" — that
 * REPLACES the source dropdown in the UI for every NEWLY created audience.
 * `"guests"`/`"donors"`/`"people"` are the legacy sources, kept only for
 * pre-existing rows (`source` is immutable after creation — see
 * `audiences.ts#updateAudience` — so an existing row never silently
 * reinterprets itself): `lib/audienceResolve.ts` keeps their resolvers alive
 * until the migration (`migrations/0040_migrate_legacy_audiences.ts`) has
 * moved every row it safely can, and the LAST legacy resolver is only deleted
 * once zero legacy-sourced rows remain across every deployment (see that
 * migration's doc for why "guests" rows are deliberately left unmigrated).
 */
export const AUDIENCE_SOURCES = ["guests", "donors", "people", "person_filters"] as const;

/** Backer status per Phase 3's filter set — a `pledges` row's DERIVED
 *  standing, not one of `PLEDGE_STATUSES` verbatim (that union has no
 *  `"lapsed"` literal). `"active"` = the person's linked donor has a pledge
 *  currently `status: "active"`. `"lapsed"` = the person's linked donor has
 *  AT LEAST ONE pledge on file (any status) but NONE currently active — i.e.
 *  backing that used to exist and doesn't right now (covers `past_due`,
 *  `canceled`, `paused`, and `incomplete` alike; this app has no separate
 *  "lapsed" billing state to distinguish among those, so they're grouped).
 */
export const AUDIENCE_BACKER_STATUSES = ["active", "lapsed"] as const;

/**
 * Per-source optional filters, all in one object (a single audience only ever
 * uses the fields relevant to its own `source`; the rest sit unused rather
 * than needing a discriminated-union schema migration every time a new filter
 * is added).
 *
 * Legacy fields (`guests`/`donors`/`people` sources only):
 *  - `eventId` — guests only: restrict to one event's RSVPs (else every
 *    active chapter's events).
 *  - `chapterId` — every source: restrict resolution to one chapter even when
 *    the audience's own `scope` is `"central"` (the fan-out scope).
 *  - `donorStatus` — donors AND person_filters.
 *  - `gaveWithinDays` — donors AND person_filters: "has given in the last N
 *    days" as of resolution time (a rolling window, not a frozen timestamp —
 *    a saved "gave this month" audience stays "this month" every time it's
 *    used).
 *
 * Phase 3 fields (`person_filters` only — specs/person-centric-audiences.md
 * §"Phase 3", AND-combined; see `lib/audienceResolve.ts#resolvePersonFilters`
 * for exactly how each is evaluated):
 *  - `givingLifetimeMinCents`/`givingLifetimeMaxCents` — the linked donor
 *    row's (chapter-scoped) `lifetimeCents`, the AUTHORITATIVE denormalized
 *    rollup (never re-summed from `gifts` at read time — see
 *    `schema/givingPlatform.ts#donors`'s doc on why that field is trustworthy).
 *  - `giftCountMin` — the linked donor row's `giftCount`, same rollup.
 *  - `backerStatus` — see `AUDIENCE_BACKER_STATUSES` above.
 *  - `attendedEventId` — a specific event's RSVPs (via `rsvps.by_person`, the
 *    Phase 1 person link — NOT `by_event`, since person_filters resolves
 *    person-first).
 *  - `attendedWithinDays` — "attended (RSVP'd to) anything in the last N
 *    days," a rolling window read off `rsvps.createdAt` (when the guest
 *    RSVP'd/was recorded — not the event's own date, mirroring
 *    `gaveWithinDays`'s resolution-time-window shape).
 *  - `rsvpStatus` — an optional modifier on `attendedEventId`/
 *    `attendedWithinDays` (or, alone, "has ANY rsvp ever with this status").
 *  - `seatId` — holds ANY `seatAssignments` row for this `seatDefId`,
 *    REGARDLESS of assignment scope: the org chart's seat SHAPE is
 *    chapter-agnostic (the same `seatDefId` is stamped onto every chapter's
 *    chart — see `schema/seats.ts`'s doc), so "Worship Leader" should catch
 *    every chapter's worship leader, not just one scope's holder.
 *  - `teamOnly` — only roster rows (`isContactOnly !== true`).
 *  - `contactsOnly` — only contact rows (`isContactOnly === true`). Mutually
 *    exclusive with `teamOnly` in the UI; both unset = roster AND contacts.
 *  - `verifiedEmailOnly` — the address `resolveSendAddress` would ACTUALLY
 *    send to has its own `personEmails` row with `verified: true` (data-trust
 *    fix: previously this checked "the person has ANY verified address on
 *    file," which could pass someone whose resolved send address was itself
 *    unverified — see `lib/audienceResolve.ts#resolvedAddressIsVerified`'s
 *    doc). A hand-pick bypasses this as a FILTER criterion (see
 *    `resolvePersonFilters`'s doc) but is counted via the preview's
 *    `handPickedUnverified` when it would have failed.
 */
export const audienceFiltersValidator = v.object({
  eventId: v.optional(v.id("events")),
  chapterId: v.optional(v.id("chapters")),
  donorStatus: v.optional(v.union(...DONOR_STATUSES.map((s) => v.literal(s)))),
  gaveWithinDays: v.optional(v.number()),

  // ── Phase 3 — person_filters criteria (specs/person-centric-audiences.md) ──
  givingLifetimeMinCents: v.optional(v.number()),
  givingLifetimeMaxCents: v.optional(v.number()),
  giftCountMin: v.optional(v.number()),
  backerStatus: v.optional(v.union(...AUDIENCE_BACKER_STATUSES.map((s) => v.literal(s)))),
  attendedEventId: v.optional(v.id("events")),
  attendedWithinDays: v.optional(v.number()),
  rsvpStatus: v.optional(v.union(...RSVP_STATUSES.map((s) => v.literal(s)))),
  seatId: v.optional(v.id("seatDefs")),
  teamOnly: v.optional(v.boolean()),
  contactsOnly: v.optional(v.boolean()),
  verifiedEmailOnly: v.optional(v.boolean()),
});

/** A saved, reusable recipient definition a campaign targets. `includePersonIds`/
 *  `excludePersonIds` (Phase 3, `person_filters` only — always empty/unset for
 *  legacy sources) are the "hand-picked" half of the picker: a person in
 *  `includePersonIds` is a member REGARDLESS of `filters` (union, not another
 *  AND-criterion); a person in `excludePersonIds` is removed regardless of
 *  matching `filters` OR being in `includePersonIds` — see
 *  `lib/audienceResolve.ts#resolvePersonFilters`'s doc for the full
 *  precedence (suppression + `marketingOptOut` still beat BOTH lists — a
 *  hand-pick is never consent). */
export const audiences = defineTable({
  scope: campaignsScope,
  name: v.string(),
  source: v.union(...AUDIENCE_SOURCES.map((s) => v.literal(s))),
  filters: audienceFiltersValidator,
  includePersonIds: v.optional(v.array(v.id("people"))),
  excludePersonIds: v.optional(v.array(v.id("people"))),
  createdBy: v.id("users"),
  createdAt: v.number(),
  updatedAt: v.number(),
  archived: v.optional(v.boolean()),
}).index("by_scope", ["scope"]);

export const CAMPAIGN_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "sending",
  "sent",
  "failed",
  "changes_requested",
  "denied",
] as const;

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

  // ── Two-party approval (all optional — back-compat with existing rows,
  // which simply never populate them; see the module doc above) ────────────
  /** Why this send is going out — required by `submitForApproval`, shown to
   *  the reviewer alongside the audience + recipient count. */
  purpose: v.optional(v.string()),
  submittedByPersonId: v.optional(v.id("people")),
  submittedAt: v.optional(v.number()),
  /** The reviewer CHOSEN at submit time (a dropdown of `campaigns.approve`
   *  holders, not a broadcast) — only this person may approve/deny/request
   *  changes on this pending request. Cleared on cancel/revert-to-draft. */
  reviewerPersonId: v.optional(v.id("people")),
  /** The decider on the LAST decision (approved / changes_requested /
   *  denied) — doubles across all three, same "last reviewer" convention
   *  `budgets.approvedByPersonId` uses. */
  approvedByPersonId: v.optional(v.id("people")),
  approvedAt: v.optional(v.number()),
  /** The reviewer's note — required for changes_requested/denied, optional
   *  on an approval. */
  reviewNote: v.optional(v.string()),
  /** Deterministic hash over the content + audience DEFINITION a reviewer
   *  signed off on (`campaigns.ts#computeCampaignSnapshotHash`) — stored at
   *  submit time, checked again at approve time and at send time. A mismatch
   *  means the campaign (or its audience's targeting) changed since the
   *  hash was recorded. */
  approvedSnapshotHash: v.optional(v.string()),
  /** The live resolved recipient count at APPROVAL time — a durable record
   *  of what the reviewer actually saw (the live composer/review count can
   *  drift after the fact as the underlying data changes). */
  approvedRecipientCount: v.optional(v.number()),
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

export const CAMPAIGN_APPROVAL_ACTIONS = [
  "submitted",
  "approved",
  "changes_requested",
  "denied",
] as const;

/** APPEND-ONLY durable history of every campaign approval decision — mirrors
 *  `schema/finances.ts#budgetApprovalLog` exactly (same rationale: the
 *  campaign row's own approval fields are LAST-DECISION-ONLY, overwritten by
 *  the next submit/decide, so this table is the only permanent record).
 *  Written by `campaigns.ts`'s `submitForApproval` ("submitted"),
 *  `approveCampaign` ("approved"), `requestCampaignChanges`
 *  ("changes_requested"), and `denyCampaign` ("denied") — never by anything
 *  else, never updated or deleted afterward. A self-service
 *  `cancelApprovalRequest` (pending_approval → draft) deliberately does NOT
 *  log a row — it's a withdrawal, not a decision, so it stays out of this
 *  enum to keep it a record of actual reviewer/submitter DECISIONS only. */
export const campaignApprovalLog = defineTable({
  campaignId: v.id("campaigns"),
  action: v.union(...CAMPAIGN_APPROVAL_ACTIONS.map((a) => v.literal(a))),
  personId: v.id("people"),
  note: v.optional(v.string()),
  purpose: v.optional(v.string()),
  recipientCount: v.optional(v.number()),
  at: v.number(),
}).index("by_campaign", ["campaignId"]);

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
