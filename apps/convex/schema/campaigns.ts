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

/**
 * ── Targeting v2 (specs/audience-targeting-v2.md) ───────────────────────────
 * A `Condition` is one testable statement about a person, with NEGATION AS AN
 * OPERATOR (`is_not`/`has_not`/`not_holds`/`not_within_days`) rather than a
 * separate block. Conditions AND-combine inside a `Group`; a person matches
 * the audience if they match ANY include group (OR comes from adding groups);
 * `excludeGroups` then removes anyone matching ANY of those. Evaluated by
 * `lib/audienceTargeting.ts` — see that module's doc for the exact semantics
 * of every field/op pair (∃-donor-row rules, central-fallback behavior,
 * unprovable-criterion rules).
 *
 * Shape notes (each is load-bearing, not style):
 *  - Discriminated union on `field` — a condition can only carry the value
 *    fields its own `field` defines, so a malformed condition (an eventId on
 *    a giving condition) is unrepresentable rather than ignored.
 *  - `attended_event`/`attended_any` carry their qualifiers (`rsvpStatus`/
 *    `withinDays`/`chapterId`) ON the condition: a single rsvp row must
 *    satisfy every qualifier together, preserving the legacy
 *    `personAttendsMatch` "one row satisfies all attendance criteria jointly"
 *    semantics losslessly under migration 0042's wrap (two separate
 *    conditions would let two different rows satisfy them independently — a
 *    different, wider audience).
 *  - `donor_status` accepts the extra `"any"` literal — "is a donor at all"
 *    (any donor row, any status) / "is not a donor" — the founder's own
 *    phrasing ("all donors who…"), unrepresentable in the legacy model.
 *  - `email_verified` is INCLUDE-side only (#424 finding C: negated/excluded
 *    it reads backwards — "remove anyone whose address IS verified");
 *    `lib/audienceTargeting.ts#validateTargeting` rejects it inside
 *    `excludeGroups` at write time and the evaluator treats it as
 *    never-matching there as a belt-and-suspenders.
 */
export const audienceConditionValidator = v.union(
  v.object({
    field: v.literal("donor_status"),
    op: v.union(v.literal("is"), v.literal("is_not")),
    status: v.union(v.literal("any"), ...DONOR_STATUSES.map((s) => v.literal(s))),
  }),
  v.object({
    field: v.literal("giving_lifetime"),
    op: v.union(v.literal("gte"), v.literal("lte")),
    cents: v.number(),
  }),
  v.object({
    field: v.literal("gift_count"),
    op: v.union(v.literal("gte"), v.literal("lte")),
    count: v.number(),
  }),
  v.object({
    field: v.literal("last_gift"),
    op: v.union(v.literal("within_days"), v.literal("not_within_days")),
    days: v.number(),
  }),
  v.object({
    field: v.literal("backer"),
    op: v.union(v.literal("is"), v.literal("is_not")),
    status: v.union(...AUDIENCE_BACKER_STATUSES.map((s) => v.literal(s))),
  }),
  v.object({
    field: v.literal("attended_event"),
    op: v.union(v.literal("has"), v.literal("has_not")),
    eventId: v.id("events"),
    rsvpStatus: v.optional(v.union(...RSVP_STATUSES.map((s) => v.literal(s)))),
    withinDays: v.optional(v.number()),
  }),
  v.object({
    field: v.literal("attended_any"),
    op: v.union(v.literal("has"), v.literal("has_not")),
    rsvpStatus: v.optional(v.union(...RSVP_STATUSES.map((s) => v.literal(s)))),
    withinDays: v.optional(v.number()),
    // Restrict to rsvps recorded under one chapter's events (`rsvps.chapterId`)
    // — exists so migration 0042 can wrap a legacy chapter-filtered "guests"
    // audience faithfully ("attended anything at THIS chapter, ever").
    chapterId: v.optional(v.id("chapters")),
  }),
  v.object({
    field: v.literal("chapter"),
    op: v.union(v.literal("is"), v.literal("is_not")),
    chapterId: v.id("chapters"),
  }),
  v.object({
    field: v.literal("seat"),
    op: v.union(v.literal("holds"), v.literal("not_holds")),
    seatId: v.id("seatDefs"),
  }),
  v.object({
    field: v.literal("kind"),
    op: v.literal("is"),
    kind: v.union(v.literal("team"), v.literal("contact")),
  }),
  v.object({
    field: v.literal("email_verified"),
    op: v.literal("is"),
  }),
  v.object({
    field: v.literal("has_service"),
    op: v.union(v.literal("has"), v.literal("has_not")),
    // Service Catalog id (`serviceOptions`), not free text — replaces the
    // pre-catalog `service: string` shape (migration 0046 converts saved
    // conditions by case-insensitive name match). Matches a person carrying
    // THIS id or any of its CHILDREN in `people.serviceIds` (picking a parent
    // like "Vocals" matches everyone tagged "Vocals:Tenor" too) — see
    // `lib/audienceTargeting.ts`'s doc for the exact subtree-match rule and
    // the central-donor-fallback/no-serviceIds-array behavior ("has" →
    // false, "has_not" → true, same as `attended_event`).
    serviceId: v.id("serviceOptions"),
  }),
);

/** One AND-group of conditions — the unit a human reads as one sentence
 *  ("people who are donors and have never attended an event"). An EMPTY
 *  `conditions` array is a deliberate "everyone in scope" group on the
 *  INCLUDE side (the vacuous-AND reading, mirroring the legacy empty-filters
 *  "match everyone" behavior) — and is REJECTED inside `excludeGroups` at
 *  write time (`lib/audienceTargeting.ts#validateTargeting`), where the same
 *  vacuous reading would mean "exclude everyone," never what a human meant
 *  (the `hasEffectiveExcludeCriteria` philosophy, group-shaped). */
export const audienceGroupValidator = v.object({
  conditions: v.array(audienceConditionValidator),
});

/** The v2 targeting model: match ANY include group, then drop anyone matching
 *  ANY exclude group. OPTIONAL on the audiences table — a row without it
 *  resolves through the legacy `source`/`filters` paths untouched (and hashes
 *  identically to before this field existed — see
 *  `campaigns.ts#computeCampaignSnapshotHash`'s key-omission rule); migration
 *  0042 wraps legacy rows in losslessly. When PRESENT, it fully defines
 *  property-based membership and `filters`/`excludeFilters` are ignored
 *  (`includePersonIds`/`excludePersonIds` hand-picks still apply, unchanged). */
export const audienceTargetingValidator = v.object({
  groups: v.array(audienceGroupValidator),
  excludeGroups: v.optional(v.array(audienceGroupValidator)),
});

/** A saved, reusable recipient definition a campaign targets. `includePersonIds`/
 *  `excludePersonIds` (Phase 3, `person_filters` only — always empty/unset for
 *  legacy sources) are the "hand-picked" half of the picker: a person in
 *  `includePersonIds` is a member REGARDLESS of `filters` (union, not another
 *  AND-criterion); a person in `excludePersonIds` is removed regardless of
 *  matching `filters` OR being in `includePersonIds` — see
 *  `lib/audienceResolve.ts#resolvePersonFilters`'s doc for the full
 *  precedence (suppression + `marketingOptOut` still beat BOTH lists — a
 *  hand-pick is never consent).
 *
 * `excludeFilters` (property-level exclusions, `person_filters` only) is the
 * PROPERTY-shaped counterpart of `excludePersonIds`: instead of naming
 * individuals, it names a Y such that "everyone matching X, EXCEPT anyone
 * matching Y" is expressible. Same shape as `filters` (reuses
 * `audienceFiltersValidator` — ADDITIVE, no migration needed: an existing
 * row simply has it `undefined`, which resolves as a no-op, the same "fields
 * the source ignores sit unused" pattern `filters` itself already relies on
 * for legacy sources). AND-combined internally exactly like `filters` (every
 * SET exclude criterion must match) via the SAME per-criterion matcher
 * `lib/audienceResolve.ts` uses for `filters`, so the two can never drift.
 * Evaluated ONLY against the `filters`/`includePersonIds` union (never a
 * fresh full-table scan) — an explicit property exclusion beats a hand-pick
 * include (curation is not exemption from an exclusion), but suppression/
 * `marketingOptOut` still beat everything, unchanged. */
export const audiences = defineTable({
  scope: campaignsScope,
  name: v.string(),
  source: v.union(...AUDIENCE_SOURCES.map((s) => v.literal(s))),
  filters: audienceFiltersValidator,
  excludeFilters: v.optional(audienceFiltersValidator),
  targeting: v.optional(audienceTargetingValidator),
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

export const EMAIL_SUPPRESSION_AUDIT_ACTIONS = ["suppressed", "unsuppressed"] as const;

/**
 * APPEND-ONLY trail of every HUMAN change to the suppression ledger — the
 * `giftAudit`/`donorAudit` narration pattern applied to do-not-email.
 *
 * Automated writes (an unsubscribe click, a bounce, a complaint) are NOT
 * logged here: the `emailSuppressions` row itself is that record, carrying its
 * own `reason` + `createdAt`. This table exists for the two ADMIN mutations
 * (`emailSuppressions.suppressEmail` / `unsuppressEmail`), where the row alone
 * can't answer "who did this?" — and, for an un-suppress, where the row is
 * DELETED and would otherwise leave no trace that a bounced/complained address
 * was deliberately put back into circulation.
 */
export const emailSuppressionAudit = defineTable({
  email: v.string(), // normalized lowercase
  action: v.union(...EMAIL_SUPPRESSION_AUDIT_ACTIONS.map((a) => v.literal(a))),
  /** The reason the row carried — the NEW reason on a suppress, the reason
   *  being cleared on an un-suppress (so "we un-suppressed a hard bounce" is
   *  distinguishable from "we un-suppressed a complaint"). */
  reason: v.optional(v.union(...EMAIL_SUPPRESSION_REASONS.map((r) => v.literal(r)))),
  actorUserId: v.id("users"),
  note: v.optional(v.string()), // the actor's optional "why"
  at: v.number(),
})
  .index("by_email", ["email"])
  .index("by_at", ["at"]);

// ── Theming, templates, the image library, and polls ─────────────────────────
// The composer used to paint every send with a palette hardcoded in
// `emailRender.ts` — a red/cream/Georgia look that was invented before anyone
// had Public Worship's actual newsletter to compare against. These four tables
// are what turn that into DATA the designer owns:
//
//  - `emailThemes`   — an org's saved, EDITABLE token sets. The built-in
//                      presets (`@events-os/shared`'s `EMAIL_THEME_PRESETS`)
//                      are NOT rows: they're code, always available, never
//                      editable; `duplicateTheme` is how a designer starts
//                      from "Summer" and makes it hers.
//  - `campaignTemplates` — saved starting points (a whole `EmailDocument`), so
//                      the monthly newsletter isn't rebuilt block-by-block
//                      every month.
//  - `emailImages`   — the reusable illustration library (a Convex-stored blob
//                      + its public URL + REQUIRED alt text), modelled on
//                      `schema/finances.ts#receipts`.
//  - `campaignPollVotes` — one row per (recipient, poll block); see its own
//                      doc for why re-voting UPDATES rather than inserts.

/** One theme's stored token set. Every colour is a `#rgb`/`#rrggbb` string
 *  validated at the WRITE gate by `@events-os/shared`'s `validateEmailTheme`
 *  (`emailThemes.ts` runs it on the full token set before every insert/patch)
 *  — Convex has no "hex colour" validator, so `v.string()` here is the shape
 *  and the shared validator is the meaning, exactly like `campaigns.doc`'s
 *  `v.any()` + `validateEmailDocument` split.
 *
 *  `dark` is a PARTIAL override, not a second theme: a missing key means
 *  "don't move this token under `prefers-color-scheme: dark`", which is why
 *  every field inside it is optional while the light side's are not. See
 *  `emailTheme.ts`'s module doc for why that asymmetry is load-bearing.
 *
 *  `isDefault` is at most one row per `scope` — `emailThemes.setDefaultTheme`
 *  clears it from every sibling in the same transaction, and `archiveTheme`
 *  refuses to archive the row holding it, so a scope can never end up with a
 *  default that's been soft-deleted.
 *
 *  ── Why the newer tokens are `v.optional` and the original ones are not ────
 *  `cream`/`contrast`/`contrastInk`/`hairline` and the two tracking values
 *  were added once the REAL newsletter was in hand, after rows already
 *  existed. Convex requires a field be optional or present on every row, and
 *  the honest reading is that these columns genuinely ARE absent on the older
 *  rows — so they're optional here and `normalizeEmailTheme` fills them from
 *  `DEFAULT_EMAIL_THEME` at the read edge (`emailThemes.ts#resolveScopeTheme`,
 *  `listThemes`, and `updateTheme`'s merge base all go through it). A
 *  backfill migration would make the column shape prettier while adding a
 *  second place the default lives; every write since this change stamps all
 *  of them, so the optionality is a statement about history, not the API. */
export const emailThemes = defineTable({
  scope: campaignsScope,
  name: v.string(),
  accent: v.string(),
  accentInk: v.string(),
  ink: v.string(),
  muted: v.string(),
  canvas: v.string(),
  surface: v.string(),
  /** The warm card fill (`#fff9ee`) — a THIRD surface, not a variant of
   *  `surface`; the design uses white, cream and near-black as distinct fills. */
  cream: v.optional(v.string()),
  /** Near-black, for filled buttons and the testimonial card (`#210706`). */
  contrast: v.optional(v.string()),
  /** Text drawn on `contrast`. */
  contrastInk: v.optional(v.string()),
  /** The thin rule between sections — lighter than `border`. */
  hairline: v.optional(v.string()),
  border: v.string(),
  link: v.string(),
  headingFont: v.string(),
  bodyFont: v.string(),
  radius: v.number(),
  /** Heading letter-spacing, e.g. `-0.04em` — validated by shape
   *  (`@events-os/shared`'s `safeTracking`), not by this `v.string()`. */
  headingTracking: v.optional(v.string()),
  /** Body letter-spacing, e.g. `-0.01em`. */
  bodyTracking: v.optional(v.string()),
  /** The small all-caps strip above the card. Empty string = no wordmark. */
  wordmark: v.string(),
  dark: v.optional(
    v.object({
      accent: v.optional(v.string()),
      accentInk: v.optional(v.string()),
      ink: v.optional(v.string()),
      muted: v.optional(v.string()),
      canvas: v.optional(v.string()),
      surface: v.optional(v.string()),
      cream: v.optional(v.string()),
      contrast: v.optional(v.string()),
      contrastInk: v.optional(v.string()),
      hairline: v.optional(v.string()),
      border: v.optional(v.string()),
      link: v.optional(v.string()),
      headingFont: v.optional(v.string()),
      bodyFont: v.optional(v.string()),
    }),
  ),
  isDefault: v.optional(v.boolean()),
  createdBy: v.id("users"),
  createdAt: v.number(),
  updatedAt: v.number(),
  archived: v.optional(v.boolean()),
}).index("by_scope", ["scope"]);

/** A saved starting point for a new campaign — a whole `EmailDocument` under
 *  `doc` (same `v.any()` + `validateEmailDocument` split `campaigns.doc` uses,
 *  for the same reason: Convex validators can't express the block union).
 *
 *  `isBuiltIn` marks a row seeded from code (`campaignTemplates.ts`'s
 *  `ensureBuiltInTemplates`, which idempotently upserts
 *  `PUBLIC_WORSHIP_NEWSLETTER_TEMPLATE` keyed by NAME per scope — the
 *  `lib/seed/templates.ts#ensureTrainingTemplate` precedent). A built-in row
 *  is still an ordinary editable row afterwards; the flag is provenance, not
 *  a lock. */
export const campaignTemplates = defineTable({
  scope: campaignsScope,
  name: v.string(),
  description: v.optional(v.string()),
  doc: v.any(),
  isBuiltIn: v.optional(v.boolean()),
  createdBy: v.id("users"),
  createdAt: v.number(),
  updatedAt: v.number(),
  archived: v.optional(v.boolean()),
}).index("by_scope", ["scope"]);

/** The reusable illustration library the composer's image picker reads.
 *  Modelled on `schema/finances.ts#receipts`: the blob lives in Convex file
 *  storage (`storageId`) and the row caches the resolved public `url` so a
 *  listing never has to `ctx.storage.getUrl` once per image.
 *
 *  `alt` is REQUIRED (empty string = "decorative") for the same reason
 *  `EmailCardContent` requires it: Gmail and Outlook block remote images by
 *  default, so alt text is what most recipients actually see first. `label` is
 *  the librarian's own name for it ("Sanctuary at dusk"), shown in the picker. */
export const emailImages = defineTable({
  scope: campaignsScope,
  storageId: v.id("_storage"),
  url: v.string(),
  alt: v.string(),
  label: v.optional(v.string()),
  /** Set ONLY on rows created by `migrations/0052_import_newsletter_images.ts`
   *  — the stable key from `@events-os/shared`'s `NEWSLETTER_ASSETS`. It is
   *  what makes that import idempotent (re-running skips a key already on
   *  file) and what lets the built-in template place a specific asset without
   *  hardcoding a URL. A hand-uploaded image has none. */
  sourceKey: v.optional(v.string()),
  createdBy: v.id("users"),
  createdAt: v.number(),
}).index("by_scope", ["scope"]);

/**
 * One vote: this recipient's answer to this poll block. ONE ROW PER
 * (recipient, block) — `by_recipient_and_block` is what makes that true, and
 * `campaignPolls.ts#recordPollVote` looks the row up on that index and PATCHES
 * it when it already exists rather than inserting a second. Changing your mind
 * must move your vote, never add one: a recipient who taps "Sunday" and then
 * "Wednesday" is one person with one opinion, and an insert-only table would
 * report them as two.
 *
 * `blockId`/`optionId` are the document's own stable block/option ids
 * (`newBlockId`, `EmailPollOption.id`) — NOT indexes into the options array
 * and NOT derived from the option's label, so renaming "Sunday" to "Sunday
 * evening" later never re-buckets the votes already cast (see
 * `emailBlocks.ts#EmailPollOption`).
 *
 * `by_campaign_and_block` backs the tally (`getPollResults`, and the "thanks,
 * here's where it stands" page a voter lands on). Both are bounded reads: a
 * campaign can't have more recipients than
 * `lib/audienceResolve.ts#AUDIENCE_RESOLVE_LIMIT`, so one block's votes are
 * hard-capped at that number — see `campaignPolls.ts#POLL_TALLY_CAP`.
 *
 * A vote is deliberately NOT anonymous at the row level (it carries
 * `recipientId`) — that's what enforces one-vote-per-person and lets a
 * re-vote find the earlier row. Nothing surfaces per-person answers today; the
 * results query returns counts only.
 */
export const campaignPollVotes = defineTable({
  campaignId: v.id("campaigns"),
  recipientId: v.id("campaignRecipients"),
  blockId: v.string(),
  optionId: v.string(),
  votedAt: v.number(),
})
  .index("by_campaign_and_block", ["campaignId", "blockId"])
  .index("by_recipient_and_block", ["recipientId", "blockId"]);

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
