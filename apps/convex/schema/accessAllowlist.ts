import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Access allowlist — the Chapter-OS successor to `guestAllowlist`. Individual
 * email addresses granted access despite NOT being on the `publicworship.life`
 * domain. Rows are seeded from Convex (dashboard function runner / seed scripts)
 * or the in-app super-admin screen, never self-service — see `accessAllowlist.ts`.
 *
 * Shape MIRRORS `guestAllowlist` exactly (`email` normalized to trimmed +
 * lowercase; `isActive === false` revokes without deleting so the note/audit
 * trail survives). This table SUPERSEDES `guestAllowlist`; the legacy table is
 * kept intact (and read as a fallback) through the additive Deploy A, then
 * copied over by the `copyGuestAllowlist` migration. Reads prefer this table
 * and fall back to `guestAllowlist` so login works before/after the copy.
 */
export const accessAllowlist = defineTable({
  email: v.string(),
  note: v.optional(v.string()),
  isActive: v.optional(v.boolean()),
  createdAt: v.optional(v.number()),
}).index("by_email", ["email"]);
