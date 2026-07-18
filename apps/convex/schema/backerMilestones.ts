import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Backer milestone ladder (`docs/plans/giving-platform.md` §3) — the
 * dev-director-editable "at N backers, the chapter commits to X" promise.
 * Seeded from (and, when empty, falls back to) the `AFFORDABILITY_TIERS`
 * constant in `@events-os/shared` — see `backerMilestones.ts#seedMilestonesIfEmpty`
 * and `finances.ts#chapterAffordability`'s read-with-fallback.
 *
 * GLOBAL ONLY in this PR — one ladder for the whole org, no `scope` field.
 * The PRD (Appendix C #5) leaves per-chapter overrides as a later option
 * ("schema supports both; UI can start global-only") — when that lands, add
 * a `scope: v.union(v.literal("global"), v.id("chapters"))` column + an index
 * keyed on it, rather than inferring "global" from an absent field. Not built
 * speculatively now.
 *
 * `minBackers` must be a positive integer; `saveMilestones` additionally
 * enforces uniqueness + strictly-increasing order across the whole ladder
 * (validated at the mutation, not the schema, since Convex validators can't
 * express cross-row constraints).
 */
export const backerMilestones = defineTable({
  /** The backer headcount that unlocks this rung (positive integer). */
  minBackers: v.number(),
  /** Short tier label shown in the affordability header (e.g. "WWS"). */
  label: v.string(),
  /** What the chapter commits to at this rung (e.g. "Worship With
   *  Strangers, monthly"). */
  commitment: v.string(),
  /** Optional public-facing blurb for the `/give/<slug>` ladder (§5) — not
   *  used by the finance-side header, which reads `label` only. */
  description: v.optional(v.string()),
  /** Display order, ascending — mirrors `minBackers` ascending 1:1 today
   *  (both are stamped from the same save-time array index), kept as its
   *  own field so the UI can order without re-deriving from `minBackers`. */
  sortOrder: v.number(),
  updatedAt: v.number(),
  // Optional, mirroring `financeSettings.updatedBy`: the seed mutation
  // (`seedMilestonesIfEmpty`) writes rows with no real human actor behind
  // them, same reasoning as the finance-settings singleton's system rows.
  updatedBy: v.optional(v.id("users")),
}).index("by_minBackers", ["minBackers"]);
