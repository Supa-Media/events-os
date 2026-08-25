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
import { MAX_SPONSORSHIP_EVENTS } from "@events-os/shared";
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { requireUserId } from "./lib/context";
import { requireGivingView, requireGivingManage } from "./lib/givingAccess";
import { requirePartnershipCompose } from "./lib/sponsorAccess";
import {
  assertPositiveGiftCents,
  matchOrCreateOrgDonor,
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
          sponsorship.packageId ? ctx.db.get(sponsorship.packageId) : null,
        ]);
        // WHICH EVENTS EACH AGREEMENT COVERS, on the list row itself. A
        // partnership is routinely more than one date (the Ignite agreement
        // stands behind two), and "who is covering Love Thy Neighbor?" is a
        // question the desk asks of the WHOLE pipeline — answering it by
        // opening every agreement in turn is how a spreadsheet gets started
        // alongside the product. Name only; the detail screen has the rest.
        const events = (
          await Promise.all(
            (sponsorship.eventIds ?? []).map((id) => ctx.db.get(id)),
          )
        )
          .filter((e): e is Doc<"events"> => e !== null)
          .map((e) => ({ _id: e._id, name: e.name, eventDate: e.eventDate }));
        return { sponsorship, donor, package: pkg, events };
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
      sponsorship.packageId ? ctx.db.get(sponsorship.packageId) : null,
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
    // The org this agreement is WITH. Supply an EXISTING one by id, or NAME a
    // NEW one inline — the partnership team should never have to leave the
    // Sponsors tab and go pre-create a "donor" first. Exactly one is required
    // on create; on update, omit both to leave the org unchanged.
    donorId: v.optional(v.id("donors")),
    newOrg: v.optional(
      v.object({
        name: v.string(),
        kind: v.union(
          v.literal("church"),
          v.literal("business"),
          v.literal("foundation"),
        ),
      }),
    ),
    // A saved tier to start from, or nothing — the agreement's own proposal
    // fields carry a bespoke deal (see `schema/sponsorships.ts`). On update,
    // `null` DETACHES a tier that was set (a deal renegotiated bespoke);
    // omitting it leaves the tier as-is.
    packageId: v.optional(v.union(v.id("sponsorPackages"), v.null())),
    status: v.optional(sponsorshipStatusValidator),
    eventIds: v.optional(v.array(v.id("events"))),
    ownerPersonId: v.optional(v.id("people")),
    dueDiligenceNotes: v.optional(v.string()),
    terms: v.optional(v.string()),
    nextTouchpointAt: v.optional(v.number()),
  },
  returns: v.id("sponsorships"),
  handler: async (ctx, args) => {
    // Partnership-pipeline action (create/edit an agreement) — the partnership
    // team runs this from the Sponsors tab. `giving.partners.edit`, which a
    // central `giving.edit` holder also carries via the wildcard rule.
    await requirePartnershipCompose(ctx);

    // ── Resolve the org this agreement is with ────────────────────────────
    // Either an existing org donor, or a new one named inline. Creating the
    // org here is deliberately part of the compose power: naming who you are
    // partnering with is partnership work, not general donor-CRM editing (it
    // can only ever mint an ORGANISATION at central — never an individual, and
    // `matchOrCreateDonor` reuses a same-name org rather than duplicating it).
    if (args.donorId && args.newOrg) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message:
          "Choose an existing organization or name a new one — not both.",
      });
    }
    let donorId = args.donorId ?? null;
    if (args.newOrg) {
      if (!args.newOrg.name.trim()) {
        throw new ConvexError({
          code: "INVALID_INPUT",
          message: "Give the sponsoring organization a name.",
        });
      }
      // Keyed on (name, kind) — never reuses an individual, never drops the
      // requested kind. See `matchOrCreateOrgDonor`.
      donorId = await matchOrCreateOrgDonor(ctx, {
        name: args.newOrg.name,
        kind: args.newOrg.kind,
      });
    }

    // On CREATE the org is required; on UPDATE, an omitted org leaves it as-is.
    if (!donorId && !args.sponsorshipId) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Choose or name the sponsoring organization.",
      });
    }

    if (donorId) {
      const donor = await ctx.db.get(donorId);
      if (!donor) {
        throw new ConvexError({ code: "NOT_FOUND", message: "Organization not found." });
      }
      if (!SPONSORABLE_DONOR_KINDS.has(donor.kind)) {
        throw new ConvexError({
          code: "INVALID_DONOR_KIND",
          message:
            "A sponsor is an organization — a church, business, or foundation, not an individual.",
        });
      }
    }

    // The package is OPTIONAL — a bespoke agreement has none. A real id must
    // exist (a stale id is a bug); `null` means "detach" and `undefined` means
    // "leave as-is" (handled at the patch below).
    if (args.packageId) {
      const pkg = await ctx.db.get(args.packageId);
      if (!pkg) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "That package doesn't exist.",
        });
      }
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
      // Every field is patched ONLY when its arg was actually sent. A partial
      // save — the relationship form persisting just the owner, say — must
      // leave events, notes and terms exactly as they were, never blank them
      // because this particular call didn't carry them. `undefined` is the
      // sentinel for "not sent"; the empty string / empty array a caller sends
      // deliberately still comes through as a real clear.
      await ctx.db.patch(args.sponsorshipId, {
        ...(donorId ? { donorId } : {}),
        ...(args.packageId === undefined
          ? {}
          : { packageId: args.packageId ?? undefined }),
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.eventIds !== undefined ? { eventIds } : {}),
        ...(args.ownerPersonId !== undefined
          ? { ownerPersonId: args.ownerPersonId }
          : {}),
        ...(args.dueDiligenceNotes !== undefined ? { dueDiligenceNotes } : {}),
        ...(args.terms !== undefined ? { terms } : {}),
        ...(args.nextTouchpointAt !== undefined
          ? { nextTouchpointAt: args.nextTouchpointAt }
          : {}),
        updatedAt: now,
      });
      return args.sponsorshipId;
    }

    return await ctx.db.insert("sponsorships", {
      donorId: donorId!,
      ...(args.packageId ? { packageId: args.packageId } : {}),
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
    // Moving an agreement along the pipeline is partnership work, not
    // donor-CRM editing — the partnership team owns it.
    await requirePartnershipCompose(ctx);
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
