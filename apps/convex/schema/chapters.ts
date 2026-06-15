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
  isActive: v.optional(v.boolean()),
  createdAt: v.optional(v.number()),
})
  .index("by_slug", ["slug"])
  .index("by_name", ["name"]);

/**
 * App-layer user profile — name + phone the user supplies during onboarding.
 * The framework `users` table owns auth + email; this holds the editable
 * profile fields Events OS needs. One row per user.
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
