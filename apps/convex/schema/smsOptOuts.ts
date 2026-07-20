import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * SMS opt-outs (Attendance F) — a defense-in-depth MIRROR of Twilio's own
 * Advanced Opt-Out (STOP/START keyword handling configured on the Messaging
 * Service), so reachability is queryable IN-APP: the blast composer can show
 * "N opted out and will be skipped" and `blasts.ts` can filter a number out
 * without a round-trip to Twilio.
 *
 * Twilio's Advanced Opt-Out remains the actual compliance enforcement (it
 * blocks the carrier-level send even if this table is stale or the
 * `/twilio/webhook` route is unreachable). This table can lag or miss a STOP
 * — it degrades to "don't text this number again from inside the app", never
 * a substitute for the carrier-level guarantee. See docs/plans/sms-comms.md.
 *
 * Deployment-wide, NOT chapter-scoped: STOP is a per-PHONE-NUMBER opt-out
 * (the carrier's semantics), org-wide — not "opted out of this chapter's
 * texts". A number that opts out stays out for every chapter's blasts.
 */
export const smsOptOuts = defineTable({
  // Normalized E.164 (see `lib/twilio.ts#normalizePhone`) — the same shape
  // every blast recipient list is de-duped on.
  phone: v.string(),
  // "stop_webhook" — a real inbound STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT
  //   keyword handled by `/twilio/webhook` (http.ts).
  // "manual" — reserved for a future admin-entered suppression (not written
  //   by anything today, kept so the shape doesn't need a migration later).
  source: v.union(v.literal("stop_webhook"), v.literal("manual")),
  note: v.optional(v.string()),
  createdAt: v.number(),
  createdBy: v.optional(v.id("users")),
}).index("by_phone", ["phone"]);
