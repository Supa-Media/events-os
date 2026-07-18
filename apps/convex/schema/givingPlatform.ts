import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Giving Platform (F-6, Phase 1) — the development team's donor CRM.
 *
 * The event `donations` table (schema/ticketing.ts) is per-EVENT giving, shipped
 * with M5.1. This domain is the standing, chapter-and-central-aware DONOR
 * database the giving PRD (docs/plans/giving-platform.md §1) replaces Givebutter
 * + Monday.com with: a `donors` record per person/org that has ever given, and a
 * `gifts` history row per dollar-amount received from any source.
 *
 * Design invariants (mirroring the finance layer + `giving.ts`'s house pattern):
 *  - Money is ALWAYS integer cents (`amountCents`, `lifetimeCents`); never a
 *    float dollar value.
 *  - Counters are DENORMALIZED and bumped on write, clamped ≥ 0 (see
 *    `bumpGivingRollup` in `giving.ts` for the same pattern) — rows are NEVER
 *    counted at read time (Convex has no count operator).
 *  - `scope` is a real chapter id, or the `"central"` sentinel this repo always
 *    uses instead of null (same union as `FinanceScope` / `seatAssignments.scope`).
 *  - `gifts` is the giving HISTORY (a source record, like a reimbursement
 *    request); `transactions` stays the ONLY actuals ledger (PRD §7, B1). Event
 *    `donations` dual-write a linked `gifts` row on settle (`donationId` set) —
 *    the event flow + its rollups are untouched, the CRM just gains the history.
 */

/** How a donor relationship is classified (individual vs institutional). */
export const DONOR_KINDS = [
  "individual",
  "church",
  "business",
  "foundation",
] as const;

/**
 * A donor's lifecycle status, DERIVED from `lastGiftAt` on every gift write
 * (the 90-day lapse rule from the AJ donor system, PRD §1):
 *  - `prospect` — no gifts yet (`giftCount === 0`);
 *  - `active`   — a gift within the last 90 days;
 *  - `lapsed`   — has given, but not in the last 90 days (the reactivation queue).
 * A time-based cron that lapses `active` donors as the window passes is a
 * fast-follow (see the TODO in `givingPlatform.ts`), not part of P1.
 */
export const DONOR_STATUSES = ["prospect", "active", "lapsed"] as const;

/** Where a donor record originated (provenance, for the CRM audit trail). */
export const DONOR_SOURCES = [
  "givebutter-import",
  "event-donation",
  "manual",
  "map",
] as const;

/** How a single gift's money arrived. Broader than the event `donations`
 *  method set (card/cash/other) because backfilled history spans every channel
 *  the development team has ever taken money through. */
export const GIFT_METHODS = [
  "stripe",
  "cash",
  "check",
  "wire",
  "in_kind",
  "imported",
] as const;

/** A donor's `scope`: the chapter that stewards the relationship, or central. */
const givingScope = v.union(v.id("chapters"), v.literal("central"));

/**
 * A recurring pledge's lifecycle, tracking the Stripe subscription behind it
 * (PRD §2):
 *  - `incomplete` — created, awaiting the donor's first successful checkout;
 *  - `active`     — the subscription is live and paying (counts toward backers
 *                   at/above `BACKER_UNIT_CENTS`);
 *  - `past_due`   — a cycle's payment failed; Stripe Smart Retries is dunning;
 *  - `canceled`   — the subscription ended (donor canceled, or Stripe gave up).
 */
export const PLEDGE_STATUSES = [
  "incomplete",
  "active",
  "past_due",
  "canceled",
] as const;

/**
 * Where a pledge came from:
 *  - `stripe`   — a real recurring subscription on OUR rails (Stripe Billing);
 *  - `imported` — a Givebutter recurrence that CANNOT be ported (its card lives
 *                 in Givebutter's Stripe, PRD §2). Tracked as a pledge-shaped
 *                 row awaiting the donor's personal re-signup on our rails.
 */
export const PLEDGE_ORIGINS = ["stripe", "imported"] as const;

/**
 * A donor — any person or org that has ever given, stewarded by one scope.
 * Denormalized rollups (`lifetimeCents` / `giftCount` / `firstGiftAt` /
 * `lastGiftAt`) are maintained on every gift write and clamped ≥ 0; `status` is
 * recomputed from them. `userId` links the donor to a member account when they
 * are also on the roster.
 */
export const donors = defineTable({
  scope: givingScope,
  kind: v.union(...DONOR_KINDS.map((k) => v.literal(k))),
  name: v.string(),
  email: v.optional(v.string()), // normalized lowercase (the dedup key)
  phone: v.optional(v.string()),
  status: v.union(...DONOR_STATUSES.map((s) => v.literal(s))),
  // Relationship owner (AJ's "owners") — a roster person, not an auth user.
  ownerPersonId: v.optional(v.id("people")),
  notes: v.optional(v.string()),
  source: v.optional(v.union(...DONOR_SOURCES.map((s) => v.literal(s)))),
  // Linked member account, when the donor is also on the roster.
  userId: v.optional(v.id("users")),
  // Denormalized rollups (bumped on gift write, clamped ≥ 0).
  lifetimeCents: v.number(),
  giftCount: v.number(),
  lastGiftAt: v.optional(v.number()),
  firstGiftAt: v.optional(v.number()),
  createdAt: v.number(),
})
  .index("by_scope", ["scope"])
  .index("by_scope_and_status", ["scope", "status"])
  // The "top donors" ordering the relationship workflow needs on day one.
  .index("by_scope_and_lifetime", ["scope", "lifetimeCents"])
  // Scoped dedup on match-or-create (email is the primary key, name the fallback).
  .index("by_scope_and_email", ["scope", "email"])
  .index("by_scope_and_name", ["scope", "name"])
  // Cross-scope email lookup (member linking, future dedup surfaces).
  .index("by_email", ["email"]);

/**
 * One gift — a single dollar-amount received, ever, from any source. The unit
 * of giving history. `donationId` links back to the event `donations` row a
 * gift was dual-written from (the migration + settle-time write use it for
 * idempotency); `externalRef` is the Givebutter transaction id, the dedup key
 * that makes CSV import safely re-runnable; `sponsorshipId` (F-6 P4) links a
 * payment to its `sponsorships` agreement — see `sponsorships.ts#recordSponsorshipGift`.
 */
export const gifts = defineTable({
  donorId: v.id("donors"),
  scope: givingScope,
  amountCents: v.number(), // int > 0
  currency: v.string(), // "usd"
  receivedAt: v.number(),
  method: v.union(...GIFT_METHODS.map((m) => v.literal(m))),
  // Set when the gift came through an event page (dual-write from `donations`).
  eventId: v.optional(v.id("events")),
  donationId: v.optional(v.id("donations")), // link to the event donation row
  externalRef: v.optional(v.string()), // Givebutter txn id (import dedup key)
  // F-6 P4: set when this payment is against a sponsorship agreement.
  sponsorshipId: v.optional(v.id("sponsorships")),
  note: v.optional(v.string()),
  recordedBy: v.optional(v.id("users")), // manual/backfill entries
  // P2 recurring: set for a gift written from a Stripe subscription billing
  // cycle (`invoice.paid`). `stripeInvoiceId` is the cycle's idempotency key —
  // one gift per invoice, safe on webhook redelivery.
  pledgeId: v.optional(v.id("pledges")),
  stripeInvoiceId: v.optional(v.string()),
  // Territories launch pot (docs/plans/giving-territories.md §D3): `true` iff
  // this gift's amount is currently counted inside its territory's
  // `launchFundCents` pot — stamped by `recordGiftForDonor` when the gift lands
  // on a chapter whose territory is still `prospect`/`raising` (100% pre-launch
  // accrual). The flag makes reversal EXACT: `removeGiftRow` un-bumps the pot
  // only for a flagged gift, and only while the territory hasn't launched (the
  // freeze — a post-launch delete leaves the flag on the deleted row's history
  // but never un-bumps a frozen pot). Absent/`false` = never counted.
  countedInLaunchFund: v.optional(v.boolean()),
  createdAt: v.number(),
})
  .index("by_donor", ["donorId"])
  .index("by_scope", ["scope"])
  // The dashboard's last-30-days window (bounded range read, never a full scan).
  .index("by_scope_and_received", ["scope", "receivedAt"])
  .index("by_externalRef", ["externalRef"])
  .index("by_donation", ["donationId"])
  .index("by_pledge", ["pledgeId"])
  // One gift per billing cycle — the `invoice.paid` idempotency lookup.
  .index("by_stripeInvoice", ["stripeInvoiceId"])
  .index("by_sponsorship", ["sponsorshipId"]);

/**
 * Per-scope denormalized aggregates for the giving dashboard — one row per
 * scope, so the dashboard reads O(1) instead of scanning `donors`/`gifts`
 * (Convex has no count operator; the guidelines forbid counting at read time).
 * Every counter is bumped on the same writes that touch `donors`/`gifts` and
 * clamped ≥ 0. Per-status counts reflect status AT LAST WRITE — the time-based
 * lapse cron (a fast-follow) is what will keep `lapsedCount` truthful as the
 * 90-day window passes without a write.
 */
export const givingScopeRollups = defineTable({
  scope: givingScope,
  lifetimeCents: v.number(),
  giftCount: v.number(),
  donorCount: v.number(),
  activeCount: v.number(),
  lapsedCount: v.number(),
  prospectCount: v.number(),
  updatedAt: v.number(),
}).index("by_scope", ["scope"]);

/**
 * A recurring pledge (PRD §2) — a donor's standing monthly commitment to a
 * city, backed by a Stripe subscription (or an imported Givebutter recurrence
 * awaiting re-signup). A donor with an `active` pledge at/above
 * `BACKER_UNIT_CENTS` is a BACKER — what the affordability tiers count.
 *
 * `gifts` is still the giving HISTORY: each paid billing cycle (`invoice.paid`)
 * writes one `gifts` row with `pledgeId` set, so recurring giving shows up in
 * the CRM exactly like every other gift. This row is the SUBSCRIPTION state,
 * not the money history.
 *
 * Money is integer cents; `amountCents` is the monthly pledge (≥ 2000 = $20
 * floor, enforced at the write path). Stripe ids are optional because an
 * `incomplete` pledge has no subscription yet, and an `imported` pledge never
 * gets one until the donor re-signs up on our rails.
 */
export const pledges = defineTable({
  donorId: v.id("donors"),
  // The city this pledge backs: a live chapter, or `"central"`. P3 (public
  // map) adds PROSPECT-city scoping on top of this union via `cityCampaignId`
  // below, rather than widening the union itself (a `cityCampaigns` row is
  // never a real chapter — PRD B6).
  scope: givingScope,
  // DEPLOY-B(territories): LEGACY. Under Territories a pledge ALWAYS scopes to a
  // real chapter (a prospect territory's shadow chapter is a real inactive
  // `chapters` row) — the "central + cityCampaignId" convention is retired.
  // Migration 0029 re-scopes every campaign-linked pledge onto its chapter and
  // clears this field. It stays here (and `by_cityCampaign` below) ONLY so 0029
  // can read the legacy rows; a follow-up PR (Deploy B) drops both once 0029 has
  // run in prod. New pledges never set it.
  cityCampaignId: v.optional(v.id("cityCampaigns")),
  amountCents: v.number(), // int ≥ 2000 ($20 floor), enforced at the write path
  status: v.union(...PLEDGE_STATUSES.map((s) => v.literal(s))),
  origin: v.union(...PLEDGE_ORIGINS.map((o) => v.literal(o))),
  // Present once a Stripe subscription is created/linked (absent while
  // `incomplete`, and for `imported` rows that never got one).
  stripeCustomerId: v.optional(v.string()),
  stripeSubscriptionId: v.optional(v.string()),
  externalRef: v.optional(v.string()), // Givebutter recurrence id (import dedup)
  startedAt: v.optional(v.number()), // when the subscription first went active
  canceledAt: v.optional(v.number()),
  currentPeriodEnd: v.optional(v.number()), // synced from the subscription
  createdAt: v.number(),
})
  .index("by_donor", ["donorId"])
  // The admin list + the derived backer-count recompute (active pledges per
  // scope) both read this.
  .index("by_scope_and_status", ["scope", "status"])
  // Webhook resolution: an invoice/subscription event → its pledge.
  .index("by_stripe_subscription", ["stripeSubscriptionId"])
  // DEPLOY-B(territories): LEGACY — used by migration 0029 to find each
  // campaign's pledges for re-scoping. Dropped with `cityCampaignId` in Deploy B.
  .index("by_cityCampaign", ["cityCampaignId"]);
