import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Territories (giving-territories addendum — supersedes `cityCampaigns`, PRD
 * B6). A territory is a place Public Worship is raising toward or already
 * running: "Queens", "Columbus, OH". Unlike the retired `cityCampaigns` model,
 * a territory maps **1:1 with a real `chapters` row** — creating a prospect
 * territory CREATES a "shadow chapter" (`isActive: false`) in the same
 * mutation (see `territories.saveTerritory`). Prospect pledges/donors/gifts
 * therefore scope DIRECTLY to that shadow chapter; the old "central +
 * cityCampaignId" convention is gone, and launch is a flag-flip
 * (`chapters.isActive: true`) rather than a re-scope. See
 * `docs/plans/giving-territories.md`.
 *
 * There is NO `backerCount` here — a territory's backer count is ALWAYS read
 * from its linked chapter's own `chapters.backerCount` (derived by
 * `givingPledges.recomputeChapterBackerCount`), so there is only ever one
 * counter per place and it can never drift.
 */

/**
 * A territory's lifecycle:
 *  - `prospect` — just added by central/dev-director; its shadow chapter is
 *                 inactive. Shows on the map if `publiclyVisible`.
 *  - `raising`  — actively promoted, collecting backers (chapter still
 *                 inactive).
 *  - `launched` — the chapter went live (`isActive: true`); banking is
 *                 provisioned. TERMINAL in v1 — reverse transitions are
 *                 rejected.
 */
export const TERRITORY_STAGES = ["prospect", "raising", "launched"] as const;
export type TerritoryStage = (typeof TERRITORY_STAGES)[number];

export const territories = defineTable({
  // The chapter this territory IS (1:1, unique by convention — enforced at the
  // write path, `territories.saveTerritory`). A prospect territory's chapter is
  // a shadow chapter (`isActive: false`); launch flips it active.
  chapterId: v.id("chapters"),
  name: v.string(), // "Queens" — a territory, not necessarily a whole city
  region: v.string(), // "NY"
  lat: v.number(), // -90..90
  lng: v.number(), // -180..180
  // Lowercase/dash-separated `/give/<slug>` URL segment. Unique by convention
  // against BOTH `territories.by_slug` AND `chapters.by_slug` (a shadow chapter
  // carries the same slug), enforced at the write path.
  slug: v.string(),
  stage: v.union(...TERRITORY_STAGES.map((s) => v.literal(s))),
  // The public progress bar's goal. Defaults to the ladder's LOWEST rung
  // (seeded from `backerMilestones`/`AFFORDABILITY_TIERS` at create) but is
  // editable — a dev director may set a different first goal.
  targetBackers: v.number(), // positive integer
  story: v.optional(v.string()),
  // Only `publiclyVisible` territories appear on `/give` or resolve at
  // `/give/<slug>` — lets central stage a territory before announcing it.
  publiclyVisible: v.boolean(),
  // The launch pot: backer money accrued toward this territory's launch grant.
  // Init 0. The accrual/freeze WIRING lands in the NEXT PR (pot rules: 100%
  // accrual, freeze at launch — see docs/plans/giving-territories.md); the
  // field is here now so that PR needs no second schema migration.
  launchFundCents: v.number(),
  // The pot's goal — defaults to `launchTemplateTotalCents()` (the shared
  // finance launch-budget total) at create; editable per territory.
  launchFundTargetCents: v.number(),
  // Stamped when `stage` first reaches `launched`.
  launchedAt: v.optional(v.number()),
  createdAt: v.number(),
  createdBy: v.id("users"),
  updatedAt: v.number(),
})
  // 1:1 lookup from a chapter → its territory (`territoryForChapter`).
  .index("by_chapter", ["chapterId"])
  // Slug resolution for `/give/<slug>` + uniqueness checks.
  .index("by_slug", ["slug"])
  // The admin desk's stage filters + fleet grouping.
  .index("by_stage", ["stage"]);
