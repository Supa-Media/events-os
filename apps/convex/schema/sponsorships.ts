import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Sponsorships & partnerships (F-6, Phase 4) — the development team's
 * institutional-giving desk: dev-director-authored sponsor package tiers, and
 * the agreement pipeline that tracks an org (church/business/foundation) from
 * prospect through an active, gift-generating partnership.
 * (docs/plans/giving-platform.md §4.)
 *
 * CENTRAL LENS ONLY in this PR — neither table carries a chapter/central
 * `scope` field (unlike `donors`/`gifts` in `schema/givingPlatform.ts`).
 * Packages are dev-director-authored config and the agreement pipeline is
 * explicitly the central lens's OKR surface ("two packages sent this month",
 * PRD §4) — so every read/write in `sponsorships.ts` gates with
 * `requireGivingView(ctx, "central")` / `requireGivingManage(ctx, "central")`,
 * mirroring `backerMilestones`'s "GLOBAL ONLY in this PR" precedent. A
 * sponsorship's ORG is still a normal chapter-or-central-scoped `donors` row
 * (the CRM doesn't change) — only the sponsorship/package records themselves
 * are central-only. If chapter-level sponsorship ownership is ever needed, add
 * a `scope` column + index then, rather than inferring it now.
 *
 * Money is always integer cents; a sponsorship's actual payments arrive as
 * ordinary `gifts` rows with `sponsorshipId` set (see `schema/givingPlatform.ts`)
 * — `sponsorPackages`/`sponsorships` themselves hold no money ledger, only the
 * tier price and the agreement metadata (PRD §7, B1: `gifts` is the only
 * giving-history source record).
 */

/** Who a package tier targets. */
export const SPONSOR_AUDIENCES = ["church", "business", "any"] as const;

/** A package's billing cadence. */
export const SPONSOR_PRICING_KINDS = ["one_time", "monthly", "annual"] as const;

/** What a package attaches to — a single event, a season's worth of events,
 *  or a full-year commitment. */
export const SPONSOR_PACKAGE_SCOPE_KINDS = ["event", "season", "annual"] as const;

/**
 * An agreement's pipeline stage (PRD §4). `lapsed`/`declined` are terminal;
 * `active` is set either directly by `setSponsorshipStatus` or automatically
 * by `recordSponsorshipGift` the moment a `committed` agreement's first
 * payment lands (see that mutation's doc comment).
 */
export const SPONSORSHIP_STATUSES = [
  "prospect",
  "pitched",
  "committed",
  "active",
  "lapsed",
  "declined",
] as const;

const pricingValidator = v.object({
  kind: v.union(...SPONSOR_PRICING_KINDS.map((k) => v.literal(k))),
  amountCents: v.number(), // int > 0, validated at the mutation
});

/** Discriminated union per Convex guidelines — what a package attaches to. */
const packageScopeValidator = v.union(
  v.object({ kind: v.literal("event"), eventId: v.id("events") }),
  v.object({ kind: v.literal("season") }),
  v.object({ kind: v.literal("annual") }),
);

/**
 * A sponsor package tier ("LTN Gold") — dev-director-authored, editable like
 * `templateRoles`/`seatDefs` (PRD §4: "packages are editable rows, not
 * constants"). `tierRank` orders tiers within a scope kind for display
 * (lower = higher precedence, e.g. 1 = "Gold"); `benefits` is what the
 * sponsor gets, `commitments` is what WE commit to deliver at this tier.
 * Deactivated (not deleted) via `deactivatePackage` so existing `sponsorships`
 * keep a valid `packageId` reference.
 */
export const sponsorPackages = defineTable({
  name: v.string(),
  tierRank: v.number(), // positive int
  audience: v.union(...SPONSOR_AUDIENCES.map((a) => v.literal(a))),
  pricing: pricingValidator,
  scope: packageScopeValidator,
  benefits: v.array(v.string()), // bounded, MAX_PACKAGE_LIST_ITEMS in sponsorships.ts
  commitments: v.array(v.string()), // bounded, same cap
  active: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
  updatedBy: v.id("users"),
})
  .index("by_active", ["active"])
  // The packages screen's "ordered by tierRank" listing (PRD §4 deliverable).
  .index("by_tierRank", ["tierRank"]);

/**
 * One agreement — one org (`donors` row, kind church/business/foundation) ×
 * one `sponsorPackages` tier. `eventIds` attaches the agreement to specific
 * future events (bounded — see `MAX_SPONSORSHIP_EVENTS`); money arrives as
 * ordinary `gifts` rows with `sponsorshipId` set to this row's id, never
 * stored here.
 */
export const sponsorships = defineTable({
  donorId: v.id("donors"),
  packageId: v.id("sponsorPackages"),
  status: v.union(...SPONSORSHIP_STATUSES.map((s) => v.literal(s))),
  eventIds: v.optional(v.array(v.id("events"))), // bounded, see MAX_SPONSORSHIP_EVENTS
  ownerPersonId: v.optional(v.id("people")),
  dueDiligenceNotes: v.optional(v.string()),
  terms: v.optional(v.string()),
  nextTouchpointAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_status", ["status"])
  .index("by_donor", ["donorId"])
  .index("by_package", ["packageId"]);
