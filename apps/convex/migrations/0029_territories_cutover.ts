import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import type { Id } from "../_generated/dataModel";
import { AFFORDABILITY_TIERS, launchTemplateTotalCents } from "@events-os/shared";
import { territoryForChapter } from "../territories";

/**
 * Territories cutover (docs/plans/giving-territories.md). Turned the retired
 * `cityCampaigns` model into `territories` (1:1 with chapters), and re-scoped
 * the campaign-linked pledge/donor/gift data DIRECTLY onto chapters (the old
 * "central + cityCampaignId" convention died):
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
 * This migration is LEDGERED and has already run in prod (Territories P2
 * deploy) — it never re-runs there. Territories Deploy B then dropped
 * `cityCampaigns` (table + registration), `pledges.cityCampaignId`, and
 * `pledges.by_cityCampaign` from the schema entirely, since nothing reads them
 * anymore.
 *
 * Parts (b)-(d) above read `cityCampaigns` and `pledges.cityCampaignId` /
 * `by_cityCampaign` — all now-undeclared. Unlike a simple undeclared-table
 * drain (the `(ctx.db as any).query(...)` precedent in
 * `0017_purge_guest_allowlist.ts` / `0026_migrate_budget_v1_lines.ts`), this
 * migration's campaign re-scoping ALSO touches a since-removed field/index on
 * a table (`pledges`) that still very much exists, across several call sites
 * (query-by-index, read, write-undefined). There's no precedent for THAT
 * shape of reference in this registry, and — critically — `cityCampaigns` can
 * never hold a row again (its schema registration + every write path are
 * gone), so parts (b)-(d) are now PROVABLY unreachable dead code, not just
 * empty-by-happenstance. Rather than layer `any` casts across a real table's
 * removed field to keep dead code "compiling in spirit," parts (b)-(d) are
 * removed outright and this function no-ops for them — the ledger row (and
 * this file, per the deletion PR's own rule) stay so the migration history
 * remains legible. Part (a) (New York seeding) is untouched: it never
 * referenced `cityCampaigns` and is still meaningful on a fresh deploy.
 *
 * Idempotent: unchanged from before — the NY-seeding branch is a no-op once
 * the "new-york" chapter already has a territory.
 */

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
  // Shape kept stable for the historical audit trail even though, post
  // Territories Deploy B, only `nySeeded`/`territoriesCreated` can ever move
  // (see the module doc above) — every other field stays at its zero value.
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

  // ── (b)-(d) Legacy `cityCampaigns` re-scoping — retired, see module doc ────
  // `cityCampaigns` + `pledges.cityCampaignId` / `by_cityCampaign` no longer
  // exist in the schema (Territories Deploy B), so there is nothing left to
  // read here. This already ran to completion in prod before that deploy.

  return result;
}

export const territoriesCutover: Migration = {
  name: "0029_territories_cutover",
  run: runTerritoriesCutover,
};
