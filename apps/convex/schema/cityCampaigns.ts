import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The City Launch map (F-6, Phase 3) — the public `/give` acquisition surface
 * (docs/plans/giving-platform.md §5). A `cityCampaigns` row is a dot on the
 * map: a PROSPECT city raising backers toward a chapter launch. It is NOT a
 * `chapters` row — `chapters` keeps meaning "operating chapter" (PRD B6). At
 * launch the campaign's `status` flips to `launched` and `chapterId` is set;
 * the dot then reads its live backer count from the linked chapter instead of
 * its own denormalized counter (see `cityCampaigns.ts#getPublicMapData`).
 */

/**
 * A campaign's lifecycle:
 *  - `prospect` — just added by central/dev-director, not yet actively
 *                 promoted (still shows on the map if `publiclyVisible`).
 *  - `raising`  — actively being promoted, collecting backers.
 *  - `launched` — became a real chapter; `chapterId` is set and the public
 *                 page's backer count/story defers to the chapter.
 */
export const CITY_CAMPAIGN_STATUSES = ["prospect", "raising", "launched"] as const;
export type CityCampaignStatus = (typeof CITY_CAMPAIGN_STATUSES)[number];

export const cityCampaigns = defineTable({
  name: v.string(), // "Columbus"
  region: v.string(), // "OH"
  lat: v.number(), // -90..90
  lng: v.number(), // -180..180
  // Unique by convention (enforced at the write path, `cityCampaigns.saveCampaign`
  // — Convex has no unique-index constraint), lowercase/dash-separated, the
  // `/give/<slug>` URL segment.
  slug: v.string(),
  status: v.union(...CITY_CAMPAIGN_STATUSES.map((s) => v.literal(s))),
  // Set at launch (`setCampaignStatus`) — the chapter this campaign became.
  chapterId: v.optional(v.id("chapters")),
  // The public progress bar's goal. Defaults to the ladder's LOWEST rung
  // (seeded from `AFFORDABILITY_TIERS`/`backerMilestones` at create time) but
  // is editable — a dev director may set a different first goal.
  targetBackers: v.number(), // positive integer
  story: v.optional(v.string()),
  // Only `publiclyVisible` campaigns appear on `/give` or resolve at
  // `/give/<slug>` — lets central stage a campaign before announcing it.
  publiclyVisible: v.boolean(),
  // Denormalized: count of `active` pledges at/above `BACKER_UNIT_CENTS` whose
  // `cityCampaignId` points at this row (mirrors `chapters.backerCount`; see
  // `givingPledges.ts#recomputePledgeCounters` /
  // `cityCampaigns.ts#recomputeCityCampaignBackerCount`). Meaningless once
  // `status === "launched"` — the public reads defer to the chapter's own
  // `backerCount` at that point instead (see `getPublicMapData`).
  backerCount: v.number(),
  createdAt: v.number(),
  createdBy: v.id("users"),
  updatedAt: v.number(),
})
  .index("by_slug", ["slug"])
  .index("by_status", ["status"]);
