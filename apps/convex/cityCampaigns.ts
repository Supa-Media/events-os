/**
 * Giving Platform (F-6, Phase 3) — the City Launch map's backend
 * (docs/plans/giving-platform.md §5). A `cityCampaigns` row is a dot on the
 * public `/give` map: a prospect city raising backers toward a chapter
 * launch. This file has three parts:
 *
 *  - ADMIN (gated `giving.manage` at central — the map is a central surface,
 *    like the milestone ladder): CRUD + status transitions.
 *  - PUBLIC (no auth — aggregates only, mirrors `giving.ts`'s public donation
 *    reads): the map's dot list and one campaign's page data.
 *  - The derived `backerCount` recompute, called by `givingPledges.ts` on
 *    every pledge transition (mirrors `recomputeChapterBackerCount`).
 *
 * Money/PII discipline: public queries here NEVER return a donor name, email,
 * or any gift-level detail — only the same aggregates the map/campaign page
 * renders (name, region, lat/lng, slug, status, backerCount, targetBackers,
 * story, the milestone ladder). See `docs/plans/giving-platform.md` §5, B7.
 */
import {
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { AFFORDABILITY_TIERS, BACKER_UNIT_CENTS } from "@events-os/shared";
import { requireGivingManage } from "./lib/givingAccess";
import { requireUserId } from "./lib/context";
import { CITY_CAMPAIGN_STATUSES } from "./schema/cityCampaigns";
import { MAX_MILESTONES } from "./backerMilestones";

const campaignStatusValidator = v.union(
  ...CITY_CAMPAIGN_STATUSES.map((s) => v.literal(s)),
);
type CampaignStatus = (typeof CITY_CAMPAIGN_STATUSES)[number];

/** A generous bound on the admin campaign list — the map is a handful of
 *  cities at a time, nowhere near this. */
const CAMPAIGN_LIST_LIMIT = 500;

/** Bounded read for the derived backer-count recompute — mirrors
 *  `givingPledges.ts`'s `BACKER_RECOUNT_LIMIT`. A campaign's active-pledge set
 *  is far smaller than this in practice. */
const CAMPAIGN_RECOUNT_LIMIT = 10000;

/** `<slug>` — lowercase letters/digits, dash-separated, no leading/trailing/
 *  double dashes. The `/give/<slug>` URL segment. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ── Validation guards ────────────────────────────────────────────────────────

function assertValidSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new ConvexError({
      code: "INVALID_SLUG",
      message:
        "Slug must be lowercase letters, numbers, and single dashes (e.g. \"columbus-oh\").",
    });
  }
}

function assertValidLatLng(lat: number, lng: number): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new ConvexError({
      code: "INVALID_LAT",
      message: "Latitude must be between -90 and 90.",
    });
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new ConvexError({
      code: "INVALID_LNG",
      message: "Longitude must be between -180 and 180.",
    });
  }
}

function assertPositiveTarget(targetBackers: number): void {
  if (!Number.isInteger(targetBackers) || targetBackers <= 0) {
    throw new ConvexError({
      code: "INVALID_TARGET",
      message: "Target backers must be a positive whole number.",
    });
  }
}

/** The ladder's lowest `minBackers` rung — the default `targetBackers` for a
 *  freshly created campaign (falls back to `AFFORDABILITY_TIERS` when the
 *  configurable ladder, `backerMilestones`, is empty — same fallback rule
 *  `chapterAffordability` uses). */
async function defaultTargetBackers(ctx: MutationCtx): Promise<number> {
  const rows = await ctx.db
    .query("backerMilestones")
    .withIndex("by_minBackers")
    .order("asc")
    .take(1);
  if (rows.length > 0) return rows[0].minBackers;
  const lowest = [...AFFORDABILITY_TIERS].sort(
    (a, b) => a.minBackers - b.minBackers,
  )[0];
  return lowest?.minBackers ?? 20;
}

// ── Derived backer count (mirrors givingPledges.ts#recomputeChapterBackerCount) ─

/**
 * Recompute + persist a campaign's derived `backerCount`: the count of
 * `active` pledges whose `cityCampaignId` points at it, at/above
 * `BACKER_UNIT_CENTS`. Called by `givingPledges.ts` on every pledge
 * status/amount transition where `cityCampaignId` is set — the same "recount
 * on every transition" rule `recomputeChapterBackerCount` follows for
 * chapters. Meaningless once the campaign is `launched` (the public reads
 * defer to the chapter's own `backerCount` instead — see `getPublicMapData`),
 * but kept truthful anyway so a re-opened/edited campaign is never stale.
 */
export async function recomputeCityCampaignBackerCount(
  ctx: MutationCtx,
  cityCampaignId: Id<"cityCampaigns">,
): Promise<void> {
  const rows = await ctx.db
    .query("pledges")
    .withIndex("by_cityCampaign", (q) => q.eq("cityCampaignId", cityCampaignId))
    .take(CAMPAIGN_RECOUNT_LIMIT);
  const count = rows.filter(
    (p) => p.status === "active" && p.amountCents >= BACKER_UNIT_CENTS,
  ).length;
  await ctx.db.patch(cityCampaignId, {
    backerCount: Math.max(0, count),
    updatedAt: Date.now(),
  });
}

// ── Checkout routing (internal — used by the public /api/give/pledge route) ──

/**
 * Resolve a campaign slug to what `givingPledges.startPledgeCheckout` should
 * back: a live chapter (once `launched`) or the campaign itself
 * (`prospect`/`raising`). Returns `null` for an unknown, hidden, or
 * not-yet-launched-but-missing-chapter row — the HTTP route surfaces that as
 * a friendly "not available" error, never a 500.
 */
export const resolveCampaignForCheckout = internalQuery({
  args: { slug: v.string() },
  returns: v.union(
    v.object({ kind: v.literal("chapter"), chapterId: v.id("chapters") }),
    v.object({
      kind: v.literal("campaign"),
      cityCampaignId: v.id("cityCampaigns"),
    }),
    v.null(),
  ),
  handler: async (ctx, { slug }) => {
    const campaign = await ctx.db
      .query("cityCampaigns")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!campaign || !campaign.publiclyVisible) return null;
    if (campaign.status === "launched") {
      return campaign.chapterId
        ? { kind: "chapter" as const, chapterId: campaign.chapterId }
        : null; // launched with no chapter linked — a data bug, not backable
    }
    return { kind: "campaign" as const, cityCampaignId: campaign._id };
  },
});

// ── Admin (gated: giving.manage at central) ──────────────────────────────────

const campaignAdminValidator = v.object({
  _id: v.id("cityCampaigns"),
  name: v.string(),
  region: v.string(),
  lat: v.number(),
  lng: v.number(),
  slug: v.string(),
  status: campaignStatusValidator,
  chapterId: v.union(v.id("chapters"), v.null()),
  targetBackers: v.number(),
  story: v.union(v.string(), v.null()),
  publiclyVisible: v.boolean(),
  backerCount: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

function toAdminRow(row: Doc<"cityCampaigns">) {
  return {
    _id: row._id,
    name: row.name,
    region: row.region,
    lat: row.lat,
    lng: row.lng,
    slug: row.slug,
    status: row.status,
    chapterId: row.chapterId ?? null,
    targetBackers: row.targetBackers,
    story: row.story ?? null,
    publiclyVisible: row.publiclyVisible,
    backerCount: row.backerCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Every campaign, newest first — the Cities desk list. Central `giving.manage`
 *  only (mirrors the milestone ladder's central-only write gate; the map is a
 *  central surface, not a per-chapter one). */
export const listCampaignsAdmin = query({
  args: {},
  returns: v.array(campaignAdminValidator),
  handler: async (ctx) => {
    await requireGivingManage(ctx, "central");
    const rows = await ctx.db.query("cityCampaigns").order("desc").take(
      CAMPAIGN_LIST_LIMIT,
    );
    return rows.map(toAdminRow);
  },
});

/**
 * Create or update a campaign. With `campaignId`, patches that row
 * (name/region/lat/lng/slug/targetBackers/story/publiclyVisible only —
 * `status`/`chapterId` change through `setCampaignStatus`); otherwise inserts
 * a fresh `prospect` campaign. Validates the slug format + uniqueness
 * (excluding self on update), lat/lng ranges, and a positive `targetBackers`.
 */
export const saveCampaign = mutation({
  args: {
    campaignId: v.optional(v.id("cityCampaigns")),
    name: v.string(),
    region: v.string(),
    lat: v.number(),
    lng: v.number(),
    slug: v.string(),
    targetBackers: v.optional(v.number()),
    story: v.optional(v.string()),
    publiclyVisible: v.boolean(),
  },
  returns: v.id("cityCampaigns"),
  handler: async (ctx, args) => {
    await requireGivingManage(ctx, "central");

    const name = args.name.trim();
    const region = args.region.trim();
    if (!name) {
      throw new ConvexError({
        code: "INVALID_NAME",
        message: "A city name is required.",
      });
    }
    if (!region) {
      throw new ConvexError({
        code: "INVALID_REGION",
        message: "A region (state/province) is required.",
      });
    }
    const slug = args.slug.trim().toLowerCase();
    assertValidSlug(slug);
    assertValidLatLng(args.lat, args.lng);

    const existingBySlug = await ctx.db
      .query("cityCampaigns")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (existingBySlug && existingBySlug._id !== args.campaignId) {
      throw new ConvexError({
        code: "SLUG_TAKEN",
        message: `The slug "${slug}" is already in use by another city.`,
      });
    }

    const story = args.story?.trim() || undefined;
    const now = Date.now();

    if (args.campaignId) {
      const existing = await ctx.db.get(args.campaignId);
      if (!existing) {
        throw new ConvexError({ code: "NOT_FOUND", message: "City not found." });
      }
      const targetBackers = args.targetBackers ?? existing.targetBackers;
      assertPositiveTarget(targetBackers);
      await ctx.db.patch(args.campaignId, {
        name,
        region,
        lat: args.lat,
        lng: args.lng,
        slug,
        targetBackers,
        story,
        publiclyVisible: args.publiclyVisible,
        updatedAt: now,
      });
      return args.campaignId;
    }

    const targetBackers =
      args.targetBackers ?? (await defaultTargetBackers(ctx));
    assertPositiveTarget(targetBackers);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    return await ctx.db.insert("cityCampaigns", {
      name,
      region,
      lat: args.lat,
      lng: args.lng,
      slug,
      status: "prospect",
      targetBackers,
      story,
      publiclyVisible: args.publiclyVisible,
      backerCount: 0,
      createdAt: now,
      createdBy: userId,
      updatedAt: now,
    });
  },
});

/**
 * Transition a campaign's status. `launched` REQUIRES a `chapterId` — the dot
 * "becomes" that chapter. Re-scoping the campaign's existing pledges (and
 * central-held money) onto the newly launched chapter is an explicit,
 * documented TODO — NOT built in this PR (see the PRD's open question,
 * Appendix C#3, on where prospect-city money is held). Until that lands, a
 * launched campaign's pledges keep pointing at `cityCampaignId` with
 * `scope: "central"`; only the PUBLIC READ (`getPublicMapData`) switches to
 * the chapter's own `backerCount` at launch.
 */
export const setCampaignStatus = mutation({
  args: {
    campaignId: v.id("cityCampaigns"),
    status: campaignStatusValidator,
    chapterId: v.optional(v.id("chapters")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireGivingManage(ctx, "central");
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) {
      throw new ConvexError({ code: "NOT_FOUND", message: "City not found." });
    }

    const status: CampaignStatus = args.status;
    if (status === "launched") {
      const chapterId = args.chapterId ?? campaign.chapterId;
      if (!chapterId) {
        throw new ConvexError({
          code: "CHAPTER_REQUIRED",
          message: "Launching a city requires picking the chapter it became.",
        });
      }
      const chapter = await ctx.db.get(chapterId);
      if (!chapter) {
        throw new ConvexError({ code: "NOT_FOUND", message: "Chapter not found." });
      }
      await ctx.db.patch(args.campaignId, {
        status,
        chapterId,
        updatedAt: Date.now(),
      });
      return null;
    }

    await ctx.db.patch(args.campaignId, { status, updatedAt: Date.now() });
    return null;
  },
});

// ── Public (no auth — aggregates only, never donor PII) ──────────────────────

const publicMapRowValidator = v.object({
  name: v.string(),
  region: v.string(),
  lat: v.number(),
  lng: v.number(),
  slug: v.string(),
  status: campaignStatusValidator,
  backerCount: v.number(),
  targetBackers: v.number(),
});

/**
 * Every `publiclyVisible` campaign's map dot: name/region/lat/lng/slug/
 * status/backerCount/targetBackers — nothing else. A `launched` campaign's
 * `backerCount` is read from its linked chapter (the live, ongoing number),
 * not the frozen campaign-scoped counter. No auth: this is the `/give` map's
 * data source. The table is small by nature (a handful of cities), so a
 * bounded default-index scan + in-memory filter is simpler than a second
 * index on `publiclyVisible` for a set this size.
 */
export const getPublicMapData = query({
  args: {},
  returns: v.array(publicMapRowValidator),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("cityCampaigns")
      .take(CAMPAIGN_LIST_LIMIT);
    const visible = rows.filter((r) => r.publiclyVisible);
    const out: Array<{
      name: string;
      region: string;
      lat: number;
      lng: number;
      slug: string;
      status: CampaignStatus;
      backerCount: number;
      targetBackers: number;
    }> = [];
    for (const row of visible) {
      let backerCount = row.backerCount;
      if (row.status === "launched" && row.chapterId) {
        const chapter = await ctx.db.get(row.chapterId);
        backerCount = chapter?.backerCount ?? row.backerCount;
      }
      out.push({
        name: row.name,
        region: row.region,
        lat: row.lat,
        lng: row.lng,
        slug: row.slug,
        status: row.status,
        backerCount,
        targetBackers: row.targetBackers,
      });
    }
    return out;
  },
});

const milestoneRungValidator = v.object({
  minBackers: v.number(),
  label: v.string(),
  commitment: v.string(),
  description: v.optional(v.string()),
});

const publicCampaignValidator = v.union(
  v.object({
    name: v.string(),
    region: v.string(),
    slug: v.string(),
    status: campaignStatusValidator,
    backerCount: v.number(),
    targetBackers: v.number(),
    story: v.union(v.string(), v.null()),
    milestones: v.array(milestoneRungValidator),
    nextMilestone: v.union(milestoneRungValidator, v.null()),
  }),
  v.null(),
);

/**
 * One campaign's public page data (by slug): the map-row aggregates + its
 * story + the milestone ladder (configured `backerMilestones`, falling back
 * to `AFFORDABILITY_TIERS` exactly like `chapterAffordability` does) with the
 * next-unlock rung computed against the live `backerCount`. Returns `null`
 * for an unknown or hidden slug — the HTTP route renders a 404 either way, so
 * a hidden campaign is indistinguishable from a nonexistent one.
 */
export const getPublicCampaign = query({
  args: { slug: v.string() },
  returns: publicCampaignValidator,
  handler: async (ctx, { slug }) => {
    const campaign = await ctx.db
      .query("cityCampaigns")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!campaign || !campaign.publiclyVisible) return null;

    let backerCount = campaign.backerCount;
    if (campaign.status === "launched" && campaign.chapterId) {
      const chapter = await ctx.db.get(campaign.chapterId);
      backerCount = chapter?.backerCount ?? campaign.backerCount;
    }

    const milestoneRows = await ctx.db
      .query("backerMilestones")
      .withIndex("by_minBackers")
      .order("asc")
      .take(MAX_MILESTONES + 1);
    const milestones =
      milestoneRows.length > 0
        ? milestoneRows.map((m) => ({
            minBackers: m.minBackers,
            label: m.label,
            commitment: m.commitment,
            description: m.description,
          }))
        : [...AFFORDABILITY_TIERS]
            .sort((a, b) => a.minBackers - b.minBackers)
            .map((t) => ({
              minBackers: t.minBackers,
              label: t.label,
              commitment: t.label,
              description: undefined,
            }));

    const nextMilestone =
      milestones.find((m) => m.minBackers > backerCount) ?? null;

    return {
      name: campaign.name,
      region: campaign.region,
      slug: campaign.slug,
      status: campaign.status,
      backerCount,
      targetBackers: campaign.targetBackers,
      story: campaign.story ?? null,
      milestones,
      nextMilestone,
    };
  },
});
