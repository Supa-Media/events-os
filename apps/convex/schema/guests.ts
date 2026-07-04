import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Guest allowlist — individual email addresses granted access despite NOT being
 * on the `publicworship.life` domain. This is the ONLY way a non-member email
 * can get past `requireAccess`, and rows are seeded from Convex (the dashboard
 * function runner / seed scripts), never self-service — see `guests.ts`.
 *
 * `email` is stored normalized (trimmed + lowercased). `isActive === false`
 * revokes access without deleting the row (keeps the note/audit trail).
 */
export const guestAllowlist = defineTable({
  email: v.string(),
  note: v.optional(v.string()),
  isActive: v.optional(v.boolean()),
  createdAt: v.optional(v.number()),
}).index("by_email", ["email"]);
