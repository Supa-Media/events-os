/**
 * CHASE FOLLOW-UPS — the charges a manager has chased, still being followed up.
 *
 * Founder, 2026-11-05: "when a person still doesn't code a charge after we
 * chase them, can we automatically remind them everyday until they code the
 * charge". One row per chased transaction, written by `cards.sendCodingChase`
 * for every charge it mailed someone about. The daily sweep
 * (`chaseFollowUps.sendDaily`) re-reminds the cardholder about every row whose
 * charge still owes something, and deletes the row once it doesn't. Coding is
 * what ends it; nothing else does.
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";

export const codingChaseFollowUps = defineTable({
  transactionId: v.id("transactions"),
  /** The cardholder the chase went to, resolved from the row at chase time. */
  personId: v.id("people"),
  /** Most recent chase of this charge. Re-chasing refreshes it. */
  chasedAt: v.number(),
  /** Last automatic follow-up sent, if any. */
  lastRemindedAt: v.optional(v.number()),
  /** Follow-ups sent since the last chase. A new chase resets it. */
  reminderCount: v.optional(v.number()),
  /** Who chased: told by email once the charge has had
   *  `ESCALATE_AFTER_REMINDERS` follow-ups and is still open. */
  chasedByUserId: v.optional(v.id("users")),
  /** When the chaser was told, so they are told once per chase. */
  escalatedAt: v.optional(v.number()),
  /** What the manager said when chasing, repeated in each follow-up. */
  reasons: v.optional(v.array(v.string())),
  note: v.optional(v.string()),
})
  .index("by_transaction", ["transactionId"])
  .index("by_chasedAt", ["chasedAt"])
  // The Book's per-person "last reminded" line (`cards.getManualNudgeStatus`).
  .index("by_person", ["personId"]);
