import { defineTable } from "convex/server";
import { v } from "convex/values";
import { SPONSOR_PAYMENT_RAILS } from "@events-os/shared";

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
  /** The agreement's terms, verbatim — what the partner signs. Rendered
   *  READ-ONLY on the portal and frozen to them exactly as a contractor
   *  payment's terms are; editing it bumps `termsVersion` (below). */
  terms: v.optional(v.string()),
  nextTouchpointAt: v.optional(v.number()),

  // ── The agreement's OWN proposal (partner portal, 2026-08-20) ─────────────
  // Every field here is OPTIONAL and falls back to the package tier, which is
  // the whole design: a tier is a price list, an agreement is a negotiation.
  // Absent means "the tier's copy is still true for this partner"; present
  // means somebody deliberately wrote this partner's version. Nothing is
  // copied down at create time, so a tier edit still reaches every agreement
  // that never diverged — and cannot silently rewrite one that did.
  //
  // See `@events-os/shared#sponsorPortal` for the caps and the prose grammar.

  /** This deal's own name ("Production Partner — Love Thy Neighbor"). Falls
   *  back to the package name. */
  title: v.optional(v.string()),
  /**
   * WHAT THE PARTNER ACTUALLY AGREED TO CARRY, when it differs from the tier's
   * list price — a negotiated figure, a multi-spot bundle, a partial year.
   * Falls back to `sponsorPackages.pricing.amountCents`.
   *
   * THE PORTAL'S BALANCE IS COMPUTED FROM THIS, never from a client value, so
   * it is the one number a manager must get right. Bounded by
   * `SPONSOR_AMOUNT_MAX_CENTS`; integer cents like every other money field.
   */
  amountCents: v.optional(v.number()),
  /**
   * The free-form body of the proposal — the founder's "put the details in,
   * like, a summarize form, maybe like a free form type of thing".
   *
   * Plain text with the smallest possible grammar (`## heading`, `- bullet`,
   * blank-line paragraphs — see `parseSponsorProse`). NOT HTML and NOT
   * markdown: every renderer escapes it, so the worst a pasted `<script>` can
   * do is appear as characters on the page.
   */
  summary: v.optional(v.string()),
  /** This partner's benefit lines, overriding the tier's `benefits`. */
  benefits: v.optional(v.array(v.string())), // bounded, MAX_PACKAGE_LIST_ITEMS
  /** What WE commit to deliver to this partner, overriding the tier's. */
  commitments: v.optional(v.array(v.string())), // same bound

  /** Who at the partner org holds this — the human the portal link goes to and
   *  the name the signature panel greets. Never published anywhere. */
  contactName: v.optional(v.string()),
  contactTitle: v.optional(v.string()),
  contactEmail: v.optional(v.string()),

  /**
   * Reviewed non-cash value counting against `amountCents` — a production
   * proposal valued at our own budget lines, donated equipment, comped venue.
   * Each line carries its own label because the proposal promises the partner
   * that "every line of the review is shown to you".
   *
   * REDUCES WHAT IS OWED; IS NOT MONEY THAT ARRIVED. Nothing here writes a
   * `gifts` row — booking donated work as revenue is a separate, deliberate
   * act (`recordSponsorshipGift` with `method: "in_kind"`), and doing both
   * would count the same donation twice. Bounded by `MAX_IN_KIND_CREDITS`.
   */
  inKindCredits: v.optional(
    v.array(
      v.object({
        label: v.string(),
        amountCents: v.number(), // int >= 0
        note: v.optional(v.string()),
      }),
    ),
  ),

  /**
   * Which payment rails this agreement's portal offers. Absent means
   * `DEFAULT_SPONSOR_RAILS` — bank transfer ALONE.
   *
   * Founder, 2026-08-20: "we should only allow bank ACH as a method of payment
   * because it's just like a big payment, and we don't want more than a five
   * dollar charge on it." Stripe's ACH fee is 0.8% capped at $5; a card takes
   * ~$101.80 of a $3,500 spot. Stored per agreement and enforced server-side
   * in `sponsorPortal.startPayment` — a portal that merely *defaulted* to bank
   * while leaving a card button on the page would lose that money to the first
   * partner who found the button convenient.
   */
  paymentRails: v.optional(
    v.array(v.union(...SPONSOR_PAYMENT_RAILS.map((r) => v.literal(r)))),
  ),

  /**
   * Bumped every time a term the partner signs against is edited (terms,
   * amount, benefits, commitments, summary, title). Bumping CLEARS the
   * signature — see `sponsorPortal.ts#bumpTermsVersion`.
   *
   * Absent on rows written before the portal existed; readers treat that as 1.
   * Without this pair we would be holding a signature against terms nobody
   * agreed to, which is exactly the trap `contractorPayments.updateTerms`
   * documents.
   */
  termsVersion: v.optional(v.number()),

  // ── The portal link ──────────────────────────────────────────────────────
  /**
   * The secret in the URL — the ONLY authority the partner has, and it
   * authorizes exactly two things: reading THIS agreement and paying it. It
   * cannot list packages, cannot read the donor CRM, cannot see other
   * agreements, and cannot change a single term. Minted idempotently (a
   * manager pressing "Copy link" twice must not invalidate the link they
   * emailed five minutes ago) and killed by `portalRevokedAt`.
   */
  portalToken: v.optional(v.string()),
  portalIssuedAt: v.optional(v.number()),
  portalRevokedAt: v.optional(v.number()),
  /** Read receipts for the desk — "have they even opened it?" is the first
   *  question asked about every proposal ever sent. */
  portalFirstViewedAt: v.optional(v.number()),
  portalLastViewedAt: v.optional(v.number()),

  // ── The signature ────────────────────────────────────────────────────────
  // The typed name, WHO typed it, and the version of the terms on the page at
  // the time — the three facts that make an acceptance evidence rather than a
  // boolean. Cleared together by a terms bump, which is the point of keeping
  // the version alongside.
  signedAt: v.optional(v.number()),
  signedName: v.optional(v.string()),
  signedTitle: v.optional(v.string()),
  signedEmail: v.optional(v.string()),
  signedIp: v.optional(v.string()),
  signedTermsVersion: v.optional(v.number()),

  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_status", ["status"])
  .index("by_donor", ["donorId"])
  .index("by_package", ["packageId"])
  // The portal's ONLY lookup: a token in a URL → the agreement it opens.
  .index("by_portalToken", ["portalToken"]);
