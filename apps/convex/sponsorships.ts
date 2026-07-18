/**
 * Sponsorships & partnerships (F-6, Phase 4) — the development team's
 * institutional-giving desk API.
 *
 * Package CRUD (gated `requireGivingView`/`requireGivingManage(ctx, "central")`
 * — see the "central lens only" note in `schema/sponsorships.ts`):
 *  - `listPackages` — every tier, ordered by `tierRank` (the packages screen).
 *  - `savePackage` — create/update a tier (the dev-director power).
 *  - `deactivatePackage` — soft-deactivate (agreements keep a valid `packageId`).
 *
 * Agreement pipeline (same central-only gate):
 *  - `listSponsorships` — the pipeline list, optionally filtered by status,
 *    enriched with the donor + package summary each row needs to render.
 *  - `getSponsorship` — one agreement's full detail (org, package, events,
 *    owner, due-diligence + terms, linked-gifts total).
 *  - `upsertSponsorship` — create/update an agreement; rejects individual donors.
 *  - `setSponsorshipStatus` — move an agreement along the pipeline.
 *  - `recordSponsorshipGift` — wraps `lib/givingDonors.ts#recordGiftForDonor`,
 *    tagging the gift with `sponsorshipId` and auto-advancing a `committed`
 *    agreement to `active` on its first payment.
 *
 * Money is always integer cents; a sponsorship never holds a money ledger of
 * its own — `gifts` stays the only giving-history source record (PRD §7, B1).
 */
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { requireUserId } from "./lib/context";
import { requireGivingView, requireGivingManage } from "./lib/givingAccess";
import {
  assertPositiveGiftCents,
  recordGiftForDonor,
} from "./lib/givingDonors";
import { GIFT_METHODS } from "./schema/givingPlatform";
import {
  SPONSOR_AUDIENCES,
  SPONSOR_PRICING_KINDS,
  SPONSORSHIP_STATUSES,
} from "./schema/sponsorships";

// ── Validators ────────────────────────────────────────────────────────────────

const audienceValidator = v.union(...SPONSOR_AUDIENCES.map((a) => v.literal(a)));
const pricingValidator = v.object({
  kind: v.union(...SPONSOR_PRICING_KINDS.map((k) => v.literal(k))),
  amountCents: v.number(),
});
const packageScopeValidator = v.union(
  v.object({ kind: v.literal("event"), eventId: v.id("events") }),
  v.object({ kind: v.literal("season") }),
  v.object({ kind: v.literal("annual") }),
);
const sponsorshipStatusValidator = v.union(
  ...SPONSORSHIP_STATUSES.map((s) => v.literal(s)),
);
const giftMethodValidator = v.union(...GIFT_METHODS.map((m) => v.literal(m)));

/** Donor kinds a sponsorship may be against — every kind except `individual`
 *  (PRD §4: "donor must be kind church/business/foundation — reject individuals"). */
const SPONSORABLE_DONOR_KINDS = new Set(["church", "business", "foundation"]);

/** A package's `benefits`/`commitments` lists are short, hand-authored bullet
 *  points — bounded well above any realistic tier's length. */
const MAX_PACKAGE_LIST_ITEMS = 30;
/** A sponsorship's event attachment list is bounded (a season's worth of
 *  events, not the whole calendar). */
const MAX_SPONSORSHIP_EVENTS = 20;
/** Generous bounds on list reads — this desk's row counts (tiers, agreements)
 *  are small by nature (dev-director-authored config, one org per agreement). */
const PACKAGE_LIST_LIMIT = 200;
const SPONSORSHIP_LIST_LIMIT_PER_STATUS = 500;
const SPONSORSHIP_GIFTS_LIMIT = 500;

// ── Packages ──────────────────────────────────────────────────────────────────

/** Every package tier, ordered by `tierRank` ascending (the packages screen:
 *  "list + create/edit form … ordered by tierRank"). Includes inactive tiers
 *  so a manager can see and reactivate them. */
export const listPackages = query({
  args: {},
  handler: async (ctx) => {
    await requireGivingView(ctx, "central");
    return await ctx.db
      .query("sponsorPackages")
      .withIndex("by_tierRank")
      .order("asc")
      .take(PACKAGE_LIST_LIMIT);
  },
});

/**
 * Create or update a sponsor package tier. With `packageId`, replaces that
 * tier's fields (scope-checked implicitly — packages are central-only);
 * otherwise inserts a new one. Validates: positive integer `tierRank`,
 * positive integer cents, nonempty name/benefits/commitments (each trimmed;
 * blank entries dropped), and — when `scope.kind === "event"` — that the
 * referenced event exists.
 */
export const savePackage = mutation({
  args: {
    packageId: v.optional(v.id("sponsorPackages")),
    name: v.string(),
    tierRank: v.number(),
    audience: audienceValidator,
    pricing: pricingValidator,
    scope: packageScopeValidator,
    benefits: v.array(v.string()),
    commitments: v.array(v.string()),
    active: v.optional(v.boolean()),
  },
  returns: v.id("sponsorPackages"),
  handler: async (ctx, args) => {
    await requireGivingManage(ctx, "central");
    const userId = (await requireUserId(ctx)) as Id<"users">;

    const name = args.name.trim();
    if (!name) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "A package name is required.",
      });
    }
    if (!Number.isInteger(args.tierRank) || args.tierRank <= 0) {
      throw new ConvexError({
        code: "INVALID_TIER_RANK",
        message: "Tier rank must be a positive whole number.",
      });
    }
    assertPositiveGiftCents(args.pricing.amountCents);

    const benefits = args.benefits.map((b) => b.trim()).filter(Boolean);
    if (benefits.length === 0) {
      throw new ConvexError({
        code: "EMPTY_BENEFITS",
        message: "A package needs at least one benefit.",
      });
    }
    if (benefits.length > MAX_PACKAGE_LIST_ITEMS) {
      throw new ConvexError({
        code: "TOO_MANY_BENEFITS",
        message: `A package may list at most ${MAX_PACKAGE_LIST_ITEMS} benefits.`,
      });
    }

    const commitments = args.commitments.map((c) => c.trim()).filter(Boolean);
    if (commitments.length === 0) {
      throw new ConvexError({
        code: "EMPTY_COMMITMENTS",
        message: "A package needs at least one commitment we deliver.",
      });
    }
    if (commitments.length > MAX_PACKAGE_LIST_ITEMS) {
      throw new ConvexError({
        code: "TOO_MANY_COMMITMENTS",
        message: `A package may list at most ${MAX_PACKAGE_LIST_ITEMS} commitments.`,
      });
    }

    if (args.scope.kind === "event") {
      const event = await ctx.db.get(args.scope.eventId);
      if (!event) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "That event doesn't exist.",
        });
      }
    }

    const now = Date.now();
    if (args.packageId) {
      const existing = await ctx.db.get(args.packageId);
      if (!existing) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "That package doesn't exist.",
        });
      }
      await ctx.db.patch(args.packageId, {
        name,
        tierRank: args.tierRank,
        audience: args.audience,
        pricing: args.pricing,
        scope: args.scope,
        benefits,
        commitments,
        active: args.active ?? existing.active,
        updatedAt: now,
        updatedBy: userId,
      });
      return args.packageId;
    }

    return await ctx.db.insert("sponsorPackages", {
      name,
      tierRank: args.tierRank,
      audience: args.audience,
      pricing: args.pricing,
      scope: args.scope,
      benefits,
      commitments,
      active: args.active ?? true,
      createdAt: now,
      updatedAt: now,
      updatedBy: userId,
    });
  },
});

/** Soft-deactivate a package (existing `sponsorships` keep a valid `packageId`
 *  reference — tiers are never hard-deleted). */
export const deactivatePackage = mutation({
  args: { packageId: v.id("sponsorPackages") },
  returns: v.null(),
  handler: async (ctx, { packageId }) => {
    await requireGivingManage(ctx, "central");
    const pkg = await ctx.db.get(packageId);
    if (!pkg) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That package doesn't exist.",
      });
    }
    await ctx.db.patch(packageId, { active: false, updatedAt: Date.now() });
    return null;
  },
});

// ── Agreement pipeline ───────────────────────────────────────────────────────

/**
 * The pipeline list, optionally filtered to one `status`. Enriched with each
 * agreement's donor + package summary — the pipeline screen groups by status
 * and needs the org name / package tier without a second round trip per row.
 * Central lens only.
 */
export const listSponsorships = query({
  args: { status: v.optional(sponsorshipStatusValidator) },
  handler: async (ctx, { status }) => {
    await requireGivingView(ctx, "central");
    const statuses = status ? [status] : SPONSORSHIP_STATUSES;

    const rows: Doc<"sponsorships">[] = [];
    for (const s of statuses) {
      const chunk = await ctx.db
        .query("sponsorships")
        .withIndex("by_status", (q) => q.eq("status", s))
        .take(SPONSORSHIP_LIST_LIMIT_PER_STATUS);
      rows.push(...chunk);
    }

    return await Promise.all(
      rows.map(async (sponsorship) => {
        const [donor, pkg] = await Promise.all([
          ctx.db.get(sponsorship.donorId),
          ctx.db.get(sponsorship.packageId),
        ]);
        return { sponsorship, donor, package: pkg };
      }),
    );
  },
});

/** One agreement's full detail: donor, package, attached events, and the
 *  linked-gifts total (summed from the bounded `by_sponsorship` gift set). */
export const getSponsorship = query({
  args: { sponsorshipId: v.id("sponsorships") },
  handler: async (ctx, { sponsorshipId }) => {
    await requireGivingView(ctx, "central");
    const sponsorship = await ctx.db.get(sponsorshipId);
    if (!sponsorship) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That sponsorship doesn't exist.",
      });
    }

    const [donor, pkg, gifts, ownerPerson] = await Promise.all([
      ctx.db.get(sponsorship.donorId),
      ctx.db.get(sponsorship.packageId),
      ctx.db
        .query("gifts")
        .withIndex("by_sponsorship", (q) => q.eq("sponsorshipId", sponsorshipId))
        .order("desc")
        .take(SPONSORSHIP_GIFTS_LIMIT),
      // Fetched server-side (not left to the client) so the owner's name
      // resolves regardless of which chapter the caller is currently viewing
      // — the person picked as owner may belong to a different chapter than
      // whatever the central caller's own roster context happens to be.
      sponsorship.ownerPersonId ? ctx.db.get(sponsorship.ownerPersonId) : null,
    ]);

    const events = await Promise.all(
      (sponsorship.eventIds ?? []).map((eventId) => ctx.db.get(eventId)),
    );
    const giftsTotalCents = gifts.reduce((sum, g) => sum + g.amountCents, 0);

    return {
      sponsorship,
      donor,
      package: pkg,
      events: events.filter((e): e is Doc<"events"> => e !== null),
      gifts,
      giftsTotalCents,
      ownerPerson,
    };
  },
});

/**
 * Create or update a sponsorship agreement. `donorId` must reference an
 * organizational donor (church/business/foundation) — an individual is
 * rejected with a clear error, since sponsorships are institutional
 * relationships (PRD §4). On create, `status` defaults to `prospect`; on
 * update, omitting `status` leaves it unchanged (use `setSponsorshipStatus`
 * for pipeline moves).
 */
export const upsertSponsorship = mutation({
  args: {
    sponsorshipId: v.optional(v.id("sponsorships")),
    donorId: v.id("donors"),
    packageId: v.id("sponsorPackages"),
    status: v.optional(sponsorshipStatusValidator),
    eventIds: v.optional(v.array(v.id("events"))),
    ownerPersonId: v.optional(v.id("people")),
    dueDiligenceNotes: v.optional(v.string()),
    terms: v.optional(v.string()),
    nextTouchpointAt: v.optional(v.number()),
  },
  returns: v.id("sponsorships"),
  handler: async (ctx, args) => {
    await requireGivingManage(ctx, "central");

    const donor = await ctx.db.get(args.donorId);
    if (!donor) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Donor not found." });
    }
    if (!SPONSORABLE_DONOR_KINDS.has(donor.kind)) {
      throw new ConvexError({
        code: "INVALID_DONOR_KIND",
        message:
          "Sponsorships are institutional agreements — the donor must be a church, business, or foundation, not an individual.",
      });
    }

    const pkg = await ctx.db.get(args.packageId);
    if (!pkg) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That package doesn't exist.",
      });
    }

    const eventIds = args.eventIds ?? [];
    if (eventIds.length > MAX_SPONSORSHIP_EVENTS) {
      throw new ConvexError({
        code: "TOO_MANY_EVENTS",
        message: `A sponsorship may attach at most ${MAX_SPONSORSHIP_EVENTS} events.`,
      });
    }
    for (const eventId of eventIds) {
      const event = await ctx.db.get(eventId);
      if (!event) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "One of the attached events doesn't exist.",
        });
      }
    }

    const dueDiligenceNotes = args.dueDiligenceNotes?.trim() || undefined;
    const terms = args.terms?.trim() || undefined;
    const now = Date.now();

    if (args.sponsorshipId) {
      const existing = await ctx.db.get(args.sponsorshipId);
      if (!existing) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "That sponsorship doesn't exist.",
        });
      }
      await ctx.db.patch(args.sponsorshipId, {
        donorId: args.donorId,
        packageId: args.packageId,
        ...(args.status !== undefined ? { status: args.status } : {}),
        eventIds,
        ...(args.ownerPersonId !== undefined
          ? { ownerPersonId: args.ownerPersonId }
          : {}),
        dueDiligenceNotes,
        terms,
        ...(args.nextTouchpointAt !== undefined
          ? { nextTouchpointAt: args.nextTouchpointAt }
          : {}),
        updatedAt: now,
      });
      return args.sponsorshipId;
    }

    return await ctx.db.insert("sponsorships", {
      donorId: args.donorId,
      packageId: args.packageId,
      status: args.status ?? "prospect",
      eventIds,
      ...(args.ownerPersonId ? { ownerPersonId: args.ownerPersonId } : {}),
      ...(dueDiligenceNotes ? { dueDiligenceNotes } : {}),
      ...(terms ? { terms } : {}),
      ...(args.nextTouchpointAt !== undefined
        ? { nextTouchpointAt: args.nextTouchpointAt }
        : {}),
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Move an agreement to a new pipeline stage. */
export const setSponsorshipStatus = mutation({
  args: {
    sponsorshipId: v.id("sponsorships"),
    status: sponsorshipStatusValidator,
  },
  returns: v.null(),
  handler: async (ctx, { sponsorshipId, status }) => {
    await requireGivingManage(ctx, "central");
    const sponsorship = await ctx.db.get(sponsorshipId);
    if (!sponsorship) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That sponsorship doesn't exist.",
      });
    }
    await ctx.db.patch(sponsorshipId, { status, updatedAt: Date.now() });
    return null;
  },
});

/**
 * Record a payment against a sponsorship agreement. Wraps
 * `lib/givingDonors.ts#recordGiftForDonor` (so the donor + scope rollups bump
 * identically to every other gift path), then tags the new row with
 * `sponsorshipId`.
 *
 * AUTO-ADVANCE RULE (PRD §4): when the sponsorship's FIRST gift lands while it
 * is still `committed`, we advance it to `active` — a committed agreement is a
 * verbal/written yes; the first dollar actually landing is the signal the
 * partnership has truly started, not merely been promised. Detected by
 * checking whether any `gifts` row already references this `sponsorshipId`
 * BEFORE inserting the new one. Any other status transition (e.g. `prospect`
 * or `pitched` receiving a gift) is left alone — use `setSponsorshipStatus`
 * for those, since skipping straight from `prospect` to `active` on a stray
 * payment would hide a pipeline stage the dev team actually worked through.
 */
export const recordSponsorshipGift = mutation({
  args: {
    sponsorshipId: v.id("sponsorships"),
    amountCents: v.number(),
    method: giftMethodValidator,
    receivedAt: v.optional(v.number()),
    note: v.optional(v.string()),
    eventId: v.optional(v.id("events")),
  },
  returns: v.id("gifts"),
  handler: async (ctx, args) => {
    await requireGivingManage(ctx, "central");

    const sponsorship = await ctx.db.get(args.sponsorshipId);
    if (!sponsorship) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "That sponsorship doesn't exist.",
      });
    }
    const donor = await ctx.db.get(sponsorship.donorId);
    if (!donor) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Donor not found." });
    }
    assertPositiveGiftCents(args.amountCents);
    const userId = (await requireUserId(ctx)) as Id<"users">;

    // Must check BEFORE inserting — this IS the "first gift" signal.
    const priorGift = await ctx.db
      .query("gifts")
      .withIndex("by_sponsorship", (q) =>
        q.eq("sponsorshipId", args.sponsorshipId),
      )
      .first();
    const isFirstGift = priorGift === null;

    const giftId = await recordGiftForDonor(ctx, {
      donorId: sponsorship.donorId,
      amountCents: args.amountCents,
      receivedAt: args.receivedAt ?? Date.now(),
      method: args.method,
      eventId: args.eventId,
      note: args.note?.trim() || undefined,
      recordedBy: userId,
    });
    await ctx.db.patch(giftId, { sponsorshipId: args.sponsorshipId });

    if (isFirstGift && sponsorship.status === "committed") {
      await ctx.db.patch(args.sponsorshipId, {
        status: "active",
        updatedAt: Date.now(),
      });
    }

    return giftId;
  },
});
