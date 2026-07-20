import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * SMS usage/cost ledger (Attendance F) — the Twilio analog of `aiUsageEvents`
 * (`schema/aiUsage.ts`): one row per SMS SEND ATTEMPT, success or failure, so
 * spend is queryable/reviewable instead of only living in Twilio's own
 * console. See docs/plans/sms-comms.md for the pricing constant, the segment
 * estimator (`@events-os/shared`'s `estimateSegments`), and the finance
 * recipe (a recurring monthly "SMS / Texting" budget, no per-text
 * transactions).
 *
 * Written by `blasts.ts#deliverSmsBlast` (purpose "blast", per phone in the
 * audience) and `ticketingSms.ts#sendVerificationSms` (purpose
 * "verification", one row per code text). NEVER stores the full phone number
 * — `phoneLast4` only, mirroring how card numbers/bank accounts are handled
 * elsewhere in this codebase (last-4 for display, never the raw value).
 */
export const smsUsageEvents = defineTable({
  // The scope this send was for: a real chapter, or the `"central"` string
  // sentinel (same convention as `aiUsageEvents.chapterId` — this repo never
  // uses null sentinels for scope). A blast always carries a real chapter
  // (`blasts.chapterId`); a verification text derives its chapter from the
  // RSVP's event when available, else falls back to "central".
  chapterId: v.union(v.id("chapters"), v.literal("central")),
  purpose: v.union(v.literal("blast"), v.literal("verification")),
  blastId: v.optional(v.id("blasts")),
  eventId: v.optional(v.id("events")),
  // Last 4 digits of the E.164 number — enough to spot-check without storing
  // a reachable phone number in a cost ledger.
  phoneLast4: v.string(),
  segments: v.number(),
  // USD cost in MICRO-dollars (1e-6 USD), same convention as
  // `aiUsageEvents.costUsdMicros` — sum and divide by 1_000_000 for display.
  // 0 for a "failed" or "opted_out" row (no real spend was incurred).
  costUsdMicros: v.number(),
  outcome: v.union(
    v.literal("sent"),
    v.literal("failed"),
    v.literal("opted_out"),
  ),
  createdAt: v.number(),
})
  .index("by_time", ["createdAt"])
  .index("by_chapter_and_time", ["chapterId", "createdAt"])
  .index("by_blast", ["blastId"]);
