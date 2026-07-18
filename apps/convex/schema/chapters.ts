import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Chapter (tenant) — a city. Owns its events, team, templates, and roster.
 * Multi-city is V3; the column is here now so the migration is painless.
 */
export const chapters = defineTable({
  name: v.string(),
  slug: v.optional(v.string()),
  image: v.optional(v.string()),
  // Absent/`true` = active (house convention: `isActive !== false`, NOT
  // `=== true` — don't flip this or every pre-existing chapter that predates
  // the column silently vanishes). `false` = a "shadow" chapter: prospect
  // territories pre-create these rows before a city actually launches, and
  // they must never appear on a fleet surface. Every enumerator that lists
  // "all chapters" (finance roll-ups, org charts, dashboards, cron fanouts,
  // ops seeding, …) MUST go through `lib/chapters.ts#listActiveChapters`
  // rather than querying this table directly — that's the one place the
  // `isActive` gate is applied.
  isActive: v.optional(v.boolean()),
  createdAt: v.optional(v.number()),
  // WP-4.3 affordability header: the chapter's backer headcount. Originally
  // MANUAL entry (`finances.setBackerCount`); F-6 P2 makes it DERIVED —
  // `givingPledges.recomputeChapterBackerCount` rewrites it from the count of
  // active pledges (≥ `BACKER_UNIT_CENTS`) on every pledge transition. The
  // manual setter stays as a cutover override and retires once Givebutter
  // migration completes (see `finances.setBackerCount`). Absent/0 = not yet
  // set — the affordability header shows a gentle prompt instead of a broken row.
  backerCount: v.optional(v.number()),
  backerCountUpdatedAt: v.optional(v.number()),
  backerCountUpdatedBy: v.optional(v.id("users")),
})
  .index("by_slug", ["slug"])
  .index("by_name", ["name"]);

/**
 * App-layer user profile — name + phone the user supplies during onboarding.
 * The framework `users` table owns auth + email; this holds the editable
 * profile fields Chapter OS needs. One row per user.
 */
export const userProfiles = defineTable({
  userId: v.id("users"),
  name: v.string(),
  phone: v.string(),
  createdAt: v.number(),
  updatedAt: v.optional(v.number()),
}).index("by_userId", ["userId"]);

/** Junction: which chapter a user belongs to, and their role within it. */
export const userChapters = defineTable({
  userId: v.id("users"),
  chapterId: v.id("chapters"),
  role: v.optional(v.string()),
  isActive: v.optional(v.boolean()),
  joinedAt: v.optional(v.number()),
})
  .index("by_userId", ["userId"])
  .index("by_chapterId", ["chapterId"])
  .index("by_userId_chapterId", ["userId", "chapterId"]);
