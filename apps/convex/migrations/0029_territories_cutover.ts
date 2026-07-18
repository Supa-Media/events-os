import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import type { Doc, Id } from "../_generated/dataModel";
import { AFFORDABILITY_TIERS, launchTemplateTotalCents } from "@events-os/shared";
import { applyScopeDelta } from "../lib/givingDonors";
import { recomputeChapterBackerCount } from "../givingPledges";
import { territoryForChapter } from "../territories";

/**
 * Territories cutover (docs/plans/giving-territories.md). Turns the retired
 * `cityCampaigns` model into `territories` (1:1 with chapters), and re-scopes
 * the campaign-linked pledge/donor/gift data DIRECTLY onto chapters (the old
 * "central + cityCampaignId" convention dies):
 *
 *  a. Seed the New York territory (launched, linked to the live "new-york"
 *     chapter) so the flagship shows on `/give` immediately.
 *  b. For every `cityCampaigns` row: a `launched` campaign → a launched
 *     territory on its existing chapter; a `prospect`/`raising` campaign →
 *     a NEW shadow chapter (`isActive: false`, backerCount copied) + a
 *     territory copying its fields.
 *  c. Re-scope each campaign's pledges onto the target chapter
 *     (`scope := chapterId`, `cityCampaignId := undefined`). For a `map`-source
 *     donor ALL of whose pledges were campaign-linked (and pointed at ONE
 *     chapter), move the donor + all their gifts onto that chapter too, with
 *     paired `applyScopeDelta`s so the central/chapter rollups net to zero.
 *     Donors that don't qualify stay central (reported in the result log).
 *  d. Recompute `chapters.backerCount` for every touched chapter.
 *
 * Idempotent: the prospect branch stamps `cityCampaigns.chapterId` as its
 * migration marker (so a re-run reuses the shadow chapter instead of making a
 * second one), and re-scoped pledges no longer surface via `by_cityCampaign`,
 * so nothing is processed twice. Prod data is near-empty; this runs in one
 * bounded pass.
 */

/** Bounded reads — the campaign/pledge/donor/gift sets are all tiny here. */
const SCAN_LIMIT = 5000;

const NEW_YORK_CHAPTER_SLUG = "new-york";

/** The ladder's lowest `minBackers` rung (backerMilestones, else the shared
 *  `AFFORDABILITY_TIERS` fallback) — a fresh territory's default target. */
async function lowestMilestone(ctx: MutationCtx): Promise<number> {
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

/** A slug free across BOTH `territories` and `chapters` (a shadow chapter may
 *  keep its own slug — pass `exceptChapterId`). Appends `-2`, `-3`, … on
 *  collision. */
async function freeSlug(
  ctx: MutationCtx,
  base: string,
  exceptChapterId?: Id<"chapters">,
): Promise<string> {
  for (let i = 1; i <= 50; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    const terr = await ctx.db
      .query("territories")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (terr) continue;
    const chapter = await ctx.db
      .query("chapters")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (chapter && chapter._id !== exceptChapterId) continue;
    return slug;
  }
  // Extremely unlikely with near-empty data; keep the base rather than throw.
  return base;
}

export async function runTerritoriesCutover(ctx: MutationCtx) {
  const now = Date.now();
  const firstUser = await ctx.db.query("users").first();
  const result = {
    nySeeded: false,
    territoriesCreated: 0,
    shadowChaptersCreated: 0,
    pledgesRescoped: 0,
    donorsMoved: 0,
    donorsKeptCentral: [] as Id<"donors">[],
    chaptersRecomputed: 0,
  };

  // ── (a) Seed the New York territory ────────────────────────────────────────
  const nyChapter = await ctx.db
    .query("chapters")
    .withIndex("by_slug", (q) => q.eq("slug", NEW_YORK_CHAPTER_SLUG))
    .first();
  if (nyChapter && firstUser) {
    const existing = await territoryForChapter(ctx, nyChapter._id);
    if (!existing) {
      const slug = await freeSlug(ctx, NEW_YORK_CHAPTER_SLUG, nyChapter._id);
      await ctx.db.insert("territories", {
        chapterId: nyChapter._id,
        name: "New York",
        region: "NY",
        lat: 40.7128,
        lng: -74.006,
        slug,
        stage: "launched",
        targetBackers: await lowestMilestone(ctx),
        publiclyVisible: true,
        launchFundCents: 0,
        launchFundTargetCents: launchTemplateTotalCents(),
        launchedAt: now,
        createdAt: now,
        createdBy: firstUser._id,
        updatedAt: now,
      });
      result.nySeeded = true;
      result.territoriesCreated++;
    }
  }

  // ── (b) One territory per legacy campaign (+ shadow chapter if prospect) ────
  const campaigns = await ctx.db.query("cityCampaigns").take(SCAN_LIMIT);
  // campaignId → the chapter its pledges/donors re-scope onto.
  const campaignTargetChapter = new Map<string, Id<"chapters">>();

  for (const campaign of campaigns) {
    const createdBy = (firstUser?._id ?? campaign.createdBy) as Id<"users">;

    if (campaign.status === "launched" && campaign.chapterId) {
      const targetChapterId = campaign.chapterId;
      campaignTargetChapter.set(campaign._id, targetChapterId);
      const existing = await territoryForChapter(ctx, targetChapterId);
      if (!existing) {
        const slug = await freeSlug(ctx, campaign.slug, targetChapterId);
        await ctx.db.insert("territories", {
          chapterId: targetChapterId,
          name: campaign.name,
          region: campaign.region,
          lat: campaign.lat,
          lng: campaign.lng,
          slug,
          stage: "launched",
          targetBackers: campaign.targetBackers,
          story: campaign.story,
          publiclyVisible: campaign.publiclyVisible,
          launchFundCents: 0,
          launchFundTargetCents: launchTemplateTotalCents(),
          launchedAt: now,
          createdAt: now,
          createdBy,
          updatedAt: now,
        });
        result.territoriesCreated++;
      }
      continue;
    }

    // prospect / raising → shadow chapter + territory (idempotent via the
    // `chapterId` marker stamped on the campaign on first migration).
    if (campaign.chapterId) {
      const existing = await territoryForChapter(ctx, campaign.chapterId);
      if (existing) {
        campaignTargetChapter.set(campaign._id, campaign.chapterId);
        continue; // already migrated
      }
    }
    const slug = await freeSlug(ctx, campaign.slug);
    const shadowChapterId = (await ctx.db.insert("chapters", {
      name: campaign.name,
      slug,
      isActive: false,
      backerCount: campaign.backerCount,
      createdAt: now,
    })) as Id<"chapters">;
    result.shadowChaptersCreated++;
    await ctx.db.insert("territories", {
      chapterId: shadowChapterId,
      name: campaign.name,
      region: campaign.region,
      lat: campaign.lat,
      lng: campaign.lng,
      slug,
      stage: campaign.status, // "prospect" | "raising"
      targetBackers: campaign.targetBackers,
      story: campaign.story,
      publiclyVisible: campaign.publiclyVisible,
      launchFundCents: 0,
      launchFundTargetCents: launchTemplateTotalCents(),
      createdAt: now,
      createdBy,
      updatedAt: now,
    });
    result.territoriesCreated++;
    // Stamp the marker so a re-run reuses this shadow chapter.
    await ctx.db.patch(campaign._id, { chapterId: shadowChapterId });
    campaignTargetChapter.set(campaign._id, shadowChapterId);
  }

  // ── (c) Re-scope campaign-linked pledges + qualifying donors/gifts ─────────
  const touchedChapters = new Set<string>();
  // Collect every campaign-linked pledge (pre-migration state) grouped by donor.
  const donorTargets = new Map<string, Set<string>>(); // donorId → chapterIds
  const campaignPledges: Array<{ pledge: Doc<"pledges">; target: Id<"chapters"> }> =
    [];

  for (const campaign of campaigns) {
    const target = campaignTargetChapter.get(campaign._id);
    if (!target) continue;
    const pledges = await ctx.db
      .query("pledges")
      .withIndex("by_cityCampaign", (q) => q.eq("cityCampaignId", campaign._id))
      .take(SCAN_LIMIT);
    for (const pledge of pledges) {
      campaignPledges.push({ pledge, target });
      const key = pledge.donorId as string;
      if (!donorTargets.has(key)) donorTargets.set(key, new Set());
      donorTargets.get(key)!.add(target as string);
    }
  }

  // Decide donor moves from the ORIGINAL pledge state (before clearing links).
  const donorMoveTo = new Map<string, Id<"chapters">>();
  for (const [donorKey, targets] of donorTargets) {
    const donorId = donorKey as Id<"donors">;
    const donor = await ctx.db.get(donorId);
    if (!donor) continue;
    const donorPledges = await ctx.db
      .query("pledges")
      .withIndex("by_donor", (q) => q.eq("donorId", donorId))
      .take(SCAN_LIMIT);
    const allCampaignLinked =
      donorPledges.length > 0 &&
      donorPledges.every((p) => p.cityCampaignId != null);
    if (
      donor.source === "map" &&
      donor.scope === "central" &&
      allCampaignLinked &&
      targets.size === 1
    ) {
      donorMoveTo.set(donorKey, [...targets][0] as Id<"chapters">);
    } else if (donor.scope === "central") {
      result.donorsKeptCentral.push(donorId);
    }
  }

  // Re-scope the pledges (clears the campaign link).
  for (const { pledge, target } of campaignPledges) {
    await ctx.db.patch(pledge._id, {
      scope: target,
      cityCampaignId: undefined,
    });
    result.pledgesRescoped++;
    touchedChapters.add(target as string);
  }

  // Move qualifying donors + their gifts, with paired rollup deltas.
  for (const [donorKey, chapterId] of donorMoveTo) {
    const donorId = donorKey as Id<"donors">;
    const donor = await ctx.db.get(donorId);
    if (!donor || donor.scope !== "central") continue; // idempotent guard
    const gifts = await ctx.db
      .query("gifts")
      .withIndex("by_donor", (q) => q.eq("donorId", donorId))
      .take(SCAN_LIMIT);
    for (const gift of gifts) {
      await ctx.db.patch(gift._id, { scope: chapterId });
    }
    // Central loses the donor's rollups; the chapter gains them — net zero.
    await applyScopeDelta(ctx, "central", {
      lifetimeDelta: -donor.lifetimeCents,
      giftDelta: -donor.giftCount,
      donorDelta: -1,
      statusFrom: donor.status,
    });
    await applyScopeDelta(ctx, chapterId, {
      lifetimeDelta: donor.lifetimeCents,
      giftDelta: donor.giftCount,
      donorDelta: 1,
      statusTo: donor.status,
    });
    await ctx.db.patch(donorId, { scope: chapterId });
    result.donorsMoved++;
    touchedChapters.add(chapterId as string);
  }

  // ── (d) Recompute the derived backer count per touched chapter ─────────────
  for (const chapterKey of touchedChapters) {
    await recomputeChapterBackerCount(ctx, chapterKey as Id<"chapters">);
    result.chaptersRecomputed++;
  }

  return result;
}

export const territoriesCutover: Migration = {
  name: "0029_territories_cutover",
  run: runTerritoriesCutover,
};
