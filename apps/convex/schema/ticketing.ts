import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Ticketing — the public, attendee-facing layer of an event (Posh/Partiful
 * style). One `eventPages` row per event turns on a shareable landing page
 * (served by an httpAction at /event/<slug>, with the legacy /e/<slug> prefix
 * kept as an alias) with RSVPs, ticket sales via Stripe, comments + reactions,
 * and email blasts.
 *
 * Public attendees have NO account: an RSVP row doubles as a lightweight guest
 * identity. Its secret `token` (random, returned once to the browser and kept
 * in localStorage) lets the guest edit their RSVP, comment, and react. All
 * other admin surfaces stay behind the usual `requireAccess` gate.
 */

/** RSVP statuses shown on the landing page (Partiful's three orbs). */
export const RSVP_STATUSES = ["going", "maybe", "not_going"] as const;

/** Per-event public landing page config + denormalized rollup counters. */
export const eventPages = defineTable({
  eventId: v.id("events"),
  chapterId: v.id("chapters"),
  // URL slug for the public page (/event/<slug>). Unique across the deployment.
  slug: v.string(),
  // Nothing is publicly readable until the page is explicitly published.
  published: v.boolean(),
  // Cover/flyer image — the hero of the landing page AND the OG/iMessage
  // preview image (served publicly via /event/<slug>/cover).
  coverImage: v.optional(v.id("_storage")),
  // Short line under the title (e.g. "A night of worship on the rooftop").
  tagline: v.optional(v.string()),
  // Longer "About this event" body (plain text, newlines preserved).
  description: v.optional(v.string()),
  // Host label shown on the page; defaults to the chapter/brand name.
  hostName: v.optional(v.string()),
  // Optional end time (start time lives on events.eventDate).
  endDate: v.optional(v.number()),
  // Public location display. `location` on the event stays internal; the page
  // can show a venue name to everyone and hold the address until RSVP
  // (Partiful's "RSVP for full location").
  venueName: v.optional(v.string()),
  address: v.optional(v.string()),
  addressVisibility: v.optional(
    v.union(v.literal("public"), v.literal("after_rsvp")),
  ),
  // Feature toggles.
  rsvpEnabled: v.optional(v.boolean()), // default true
  ticketsEnabled: v.optional(v.boolean()), // default false until types exist
  // Giving (donations) — the "support this event" surface on the page.
  givingEnabled: v.optional(v.boolean()), // default false
  givingPrompt: v.optional(v.string()), // custom "support this event" copy
  suggestedAmountsCents: v.optional(v.array(v.number())), // preset buttons (ints)
  showGuestList: v.optional(v.boolean()), // default true
  // Partiful-style gate: activity feed visible only after you RSVP.
  activityRestricted: v.optional(v.boolean()), // default true
  capacity: v.optional(v.number()),
  // Denormalized counters (never .collect().length at read time).
  goingCount: v.number(),
  maybeCount: v.number(),
  notGoingCount: v.number(),
  ticketsSoldCount: v.number(),
  revenueCents: v.number(),
  // Giving rollup (siblings of revenueCents; default 0 when unset).
  donationsCents: v.optional(v.number()),
  donationsCount: v.optional(v.number()),
  // Givebutter live ticket sync (poll-only, PR B). When a campaign id is set,
  // the manual "Sync now" button + the 15-min cron pull that campaign's tickets
  // into native mirror orders/tickets/RSVPs (display attribution only — never
  // the money ledger). Last-sync bookkeeping powers the sync card's status line.
  givebutterCampaignId: v.optional(v.string()),
  givebutterLastSyncedAt: v.optional(v.number()),
  givebutterLastSyncError: v.optional(v.string()),
  createdBy: v.id("users"),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_event", ["eventId"])
  .index("by_slug", ["slug"])
  .index("by_chapter", ["chapterId"])
  // Public marketing feed (GET /api/events/upcoming): read only published
  // pages, newest-created first, without scanning drafts.
  .index("by_published", ["published"]);

/** A purchasable (or free/claimable) ticket tier for an event. */
export const ticketTypes = defineTable({
  eventId: v.id("events"),
  chapterId: v.id("chapters"),
  name: v.string(),
  description: v.optional(v.string()),
  // 0 = free (claim without Stripe). Amounts always in cents.
  priceCents: v.number(),
  currency: v.string(), // "usd"
  // Max sellable (undefined = unlimited).
  capacity: v.optional(v.number()),
  // Denormalized count of ISSUED tickets (availability = capacity - sold).
  soldCount: v.number(),
  maxPerOrder: v.optional(v.number()),
  salesStart: v.optional(v.number()),
  salesEnd: v.optional(v.number()),
  sortOrder: v.number(),
  // Hidden from the public page when false (soft delete keeps sold history).
  isActive: v.boolean(),
  // Set on MIRROR ticket types synthesized from an external provider's ticket
  // sales (Givebutter, PR B). A mirror type is NEVER natively sellable
  // (`isActive: false`) — it exists only so a synced ticket has a real
  // `ticketTypeId` and the door scanner + rollups work for external buyers.
  externalProvider: v.optional(v.literal("givebutter")),
  createdAt: v.number(),
  updatedAt: v.number(),
}).index("by_event", ["eventId"]);

/**
 * A public attendee's RSVP — also their guest identity. `token` is the secret
 * the browser holds to edit this RSVP / comment / react as this person.
 */
export const rsvps = defineTable({
  eventId: v.id("events"),
  chapterId: v.id("chapters"),
  name: v.string(),
  // Optional: import-created rows (Partiful/spreadsheet exports) are legal
  // name-only guests with NO email and NO phone. Every PUBLIC flow
  // (submitRsvp, prepareOrder, prepareDonation, email verification) still
  // requires a real email — only the attendance importer inserts email-less
  // rows, and those are unreachable by email blast until SMS targeting lands.
  email: v.optional(v.string()), // normalized lowercase
  phone: v.optional(v.string()), // SMS-ready (blasts v2)
  status: v.union(...RSVP_STATUSES.map((s) => v.literal(s))),
  // Secret guest token (random). NEVER returned by public list queries.
  token: v.string(),
  // How they arrived: a bare RSVP or a ticket purchase.
  source: v.optional(v.union(v.literal("rsvp"), v.literal("ticket"))),
  // false = a code is pending, true = confirmed, undefined = legacy (verified).
  emailVerified: v.optional(v.boolean()),
  // Phone verification (Attendance F), tri-state exactly like `emailVerified`:
  // false = an SMS code is pending, true = confirmed, undefined = never
  // started (imported/synced phone guests are undefined = not-yet-verified,
  // but an SMS blast still reaches them — the gate is `!== false`).
  phoneVerified: v.optional(v.boolean()),
  // Free-text note attached by the attendance importer (payment platform +
  // handle, "Panelist", "+1 of X", ticket type/price, etc.). Never shown on
  // the public page; admin-only context on the guest list.
  note: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_event", ["eventId"])
  .index("by_event_email", ["eventId", "email"])
  .index("by_event_status", ["eventId", "status"])
  .index("by_token", ["token"]);

/**
 * Pending email-verification code for an RSVP (at most one per RSVP). Only a
 * hash of the 6-digit code is stored; the plaintext goes out by email only.
 */
export const rsvpEmailCodes = defineTable({
  rsvpId: v.id("rsvps"),
  codeHash: v.string(),
  expiresAt: v.number(),
  attempts: v.number(),
  lastSentAt: v.number(),
  createdAt: v.number(),
}).index("by_rsvp", ["rsvpId"]);

/**
 * Pending phone-verification code for an RSVP (at most one per RSVP) — the SMS
 * analog of `rsvpEmailCodes`, same shape and semantics (hashed 6-digit code,
 * 15-min expiry, 5 attempts, one send/minute). Only a hash is stored; the
 * plaintext goes out by SMS only.
 */
export const rsvpPhoneCodes = defineTable({
  rsvpId: v.id("rsvps"),
  codeHash: v.string(),
  expiresAt: v.number(),
  attempts: v.number(),
  lastSentAt: v.number(),
  createdAt: v.number(),
}).index("by_rsvp", ["rsvpId"]);

/** A checkout order (one Stripe Checkout Session; free claims are $0 orders). */
export const ticketOrders = defineTable({
  eventId: v.id("events"),
  chapterId: v.id("chapters"),
  rsvpId: v.optional(v.id("rsvps")),
  name: v.string(),
  email: v.string(),
  // Line items (snapshot; bounded by the handful of ticket types).
  items: v.array(
    v.object({
      ticketTypeId: v.id("ticketTypes"),
      name: v.string(),
      quantity: v.number(),
      unitPriceCents: v.number(),
    }),
  ),
  totalCents: v.number(),
  currency: v.string(),
  status: v.union(
    v.literal("pending"),
    v.literal("paid"),
    v.literal("canceled"),
    v.literal("refunded"),
    v.literal("expired"),
  ),
  stripeCheckoutSessionId: v.optional(v.string()),
  stripePaymentIntentId: v.optional(v.string()),
  // External provider attribution (Givebutter, PR B). A synced order carries NO
  // Stripe fields; instead `externalProvider` + `externalRef` mark where it came
  // from and dedup re-syncs. `externalRef` is "gb:ticket:<id>" for a Givebutter
  // ticket — the idempotency key the sync applies on (`by_external_ref`).
  externalProvider: v.optional(v.literal("givebutter")),
  externalRef: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_event", ["eventId"])
  .index("by_stripe_session", ["stripeCheckoutSessionId"])
  .index("by_external_ref", ["externalRef"]);

/**
 * A donation to an event — the money flow the schema couldn't record before
 * (a donations QR + a cash merch table). Shaped like `ticketOrders` minus
 * line-items. Card donations arrive `pending` via Stripe and settle on the
 * webhook (mirrors orders); manual cash/other entries are inserted `paid`.
 */
export const donations = defineTable({
  chapterId: v.id("chapters"),
  eventId: v.id("events"),
  name: v.string(),
  email: v.optional(v.string()), // normalized lowercase
  amountCents: v.number(), // int > 0
  currency: v.string(), // "usd"
  method: v.union(v.literal("card"), v.literal("cash"), v.literal("other")),
  status: v.union(
    v.literal("pending"),
    v.literal("paid"),
    v.literal("refunded"),
    v.literal("canceled"),
    v.literal("expired"),
  ),
  note: v.optional(v.string()),
  rsvpId: v.optional(v.id("rsvps")),
  stripeCheckoutSessionId: v.optional(v.string()),
  stripePaymentIntentId: v.optional(v.string()),
  // Set for manual entries (the admin who recorded it).
  recordedBy: v.optional(v.id("users")),
  createdAt: v.number(),
})
  .index("by_event", ["eventId"])
  .index("by_stripe_session", ["stripeCheckoutSessionId"]);

/** An issued ticket (one row per admission; `code` backs the QR). */
export const tickets = defineTable({
  eventId: v.id("events"),
  chapterId: v.id("chapters"),
  orderId: v.id("ticketOrders"),
  ticketTypeId: v.id("ticketTypes"),
  ticketTypeName: v.string(), // snapshot
  attendeeName: v.string(),
  attendeeEmail: v.string(),
  // Human-safe code (e.g. "PW-8FK2-QW9T"): printed under the QR, scanned at
  // the door, and the key of the public /t/<code> ticket page.
  code: v.string(),
  status: v.union(
    v.literal("valid"),
    v.literal("checked_in"),
    v.literal("void"),
  ),
  checkedInAt: v.optional(v.number()),
  checkedInBy: v.optional(v.id("users")),
  createdAt: v.number(),
})
  .index("by_event", ["eventId"])
  .index("by_order", ["orderId"])
  .index("by_code", ["code"]);

/**
 * Comments on the public page: top-level posts, one-level replies to another
 * comment (`parentId`), or replies hanging off an RSVP activity entry
 * (`replyToRsvpId`) — Partiful's "Reply" under "X rsvped Going".
 */
export const eventComments = defineTable({
  eventId: v.id("events"),
  chapterId: v.id("chapters"),
  parentId: v.optional(v.id("eventComments")),
  replyToRsvpId: v.optional(v.id("rsvps")),
  // Author: a guest (rsvpId) or a signed-in member (userId); name snapshot
  // either way so the feed renders without joins.
  rsvpId: v.optional(v.id("rsvps")),
  userId: v.optional(v.id("users")),
  authorName: v.string(),
  body: v.string(),
  createdAt: v.number(),
})
  .index("by_event", ["eventId"])
  .index("by_parent", ["parentId"])
  .index("by_reply_to_rsvp", ["replyToRsvpId"]);

/** Emoji reactions on activity items (an RSVP entry or a comment). */
export const pageReactions = defineTable({
  eventId: v.id("events"),
  chapterId: v.id("chapters"),
  targetType: v.union(v.literal("rsvp"), v.literal("comment")),
  targetId: v.string(), // rsvps._id or eventComments._id as a string
  emoji: v.string(),
  // Dedup key: the reacting rsvpId/userId as a string (one emoji per actor
  // per target toggles on/off).
  actorKey: v.string(),
  createdAt: v.number(),
})
  .index("by_event", ["eventId"])
  .index("by_target", ["targetType", "targetId"])
  .index("by_target_actor", ["targetType", "targetId", "actorKey"]);

/** Text & email blasts to attendees (email live now; sms is schema-ready). */
export const blasts = defineTable({
  eventId: v.id("events"),
  chapterId: v.id("chapters"),
  channel: v.union(v.literal("email"), v.literal("sms")),
  subject: v.optional(v.string()), // email only
  body: v.string(),
  audience: v.union(
    v.literal("everyone"),
    v.literal("going"),
    v.literal("maybe"),
    v.literal("ticket_holders"),
  ),
  status: v.union(
    v.literal("draft"),
    v.literal("sending"),
    v.literal("sent"),
    v.literal("failed"),
  ),
  recipientCount: v.optional(v.number()),
  sentCount: v.optional(v.number()),
  error: v.optional(v.string()),
  createdBy: v.id("users"),
  createdAt: v.number(),
  sentAt: v.optional(v.number()),
}).index("by_event", ["eventId"]);
