import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Ticketing — the public, attendee-facing layer of an event (Posh/Partiful
 * style). One `eventPages` row per event turns on a shareable RSVP page
 * (served by an httpAction at /rsvp/<slug>, with the older /event/<slug> and
 * legacy /e/<slug> prefixes kept as aliases) with RSVPs, ticket sales via
 * Stripe, comments + reactions, and email blasts.
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
  // URL slug for the public page (/rsvp/<slug>). Unique across the deployment.
  slug: v.string(),
  // Nothing is publicly readable until the page is explicitly published.
  published: v.boolean(),
  // Cover/flyer image — the hero of the landing page AND the OG/iMessage
  // preview image (served publicly via /rsvp/<slug>/cover).
  coverImage: v.optional(v.id("_storage")),
  // Focal point (0–100, percent) for cropping `coverImage` — maps to the CSS
  // `object-position` of the hero crop so the admin controls what stays in
  // frame on the landing page instead of a hardcoded center crop. Unset (the
  // legacy default) = centered (50/50).
  coverFocalX: v.optional(v.number()),
  coverFocalY: v.optional(v.number()),
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
  // Fundraising goal (integer cents). When set, the page shows a progress bar
  // and "$X of $Y raised" — where "raised" combines ticket revenue AND giving
  // (see the `*Cents` rollups below). Unset = no goal shown.
  goalCents: v.optional(v.number()),
  showGuestList: v.optional(v.boolean()), // default true
  // Guest teams — split arriving guests into N even teams at check-in (see
  // `guestTeams` below). Off by default; turning it on seeds the default team
  // set. Kept as its OWN flag rather than inferred from "are there any teams"
  // so an event can switch assignment off for a night without losing the team
  // names it already customized.
  teamsEnabled: v.optional(v.boolean()), // default false
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
  // `donationsCents` = money given THROUGH this event page (the on-page "Give"
  // flow: Stripe card donations + manually-recorded cash/other, each also
  // dual-written into the donor-CRM `gifts` ledger).
  donationsCents: v.optional(v.number()),
  donationsCount: v.optional(v.number()),
  // `externalGiftsCents` = donor-CRM `gifts` MANUALLY attached to this event
  // (Givebutter-imported or offline gifts given "toward the fundraiser"). Kept
  // separate from `donationsCents` so the two never double-count: an on-page
  // donation is already a `gifts` row (via `donationId`) and is EXCLUDED here —
  // only `donationId`-less gifts land in this rollup (see giving attach flow).
  // The event's total "given" = donationsCents + externalGiftsCents, and both
  // count toward `goalCents` alongside ticket `revenueCents`.
  externalGiftsCents: v.optional(v.number()),
  externalGiftsCount: v.optional(v.number()),
  // Givebutter live ticket sync (poll-only, PR B). When a campaign id is set,
  // the manual "Sync now" button + the 15-min cron pull that campaign's tickets
  // into native mirror orders/tickets/RSVPs (display attribution only — never
  // the money ledger). Last-sync bookkeeping powers the sync card's status line.
  givebutterCampaignId: v.optional(v.string()),
  givebutterLastSyncedAt: v.optional(v.number()),
  givebutterLastSyncError: v.optional(v.string()),
  // Secret token for the admin "Open preview" link: appends `?preview=<token>`
  // to the public URL so the page renders even while `published` is false
  // (and before go-live). Lazily minted by `ensurePreviewToken`; never returned
  // by any public/list query.
  previewToken: v.optional(v.string()),
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
  // Set when a free-RSVP row is archived because its event switched to ticketed
  // mode (events are single-mode: RSVP or ticketed, never both). Archived rows
  // are kept (recoverable) but excluded from every count, guest list, and feed.
  // Ticket-buyer rows (source === "ticket") are never archived.
  archivedAt: v.optional(v.number()),
  // Person-centric audiences Phase 1 (specs/person-centric-audiences.md item
  // 2) — this guest's linked `people` row, stamped best-effort by
  // `lib/rsvpPeople.ts#linkRsvpToPerson` right after every insert site (see
  // that file's doc comment for the six call sites + match order). Optional:
  // a row with no email AND no phone can never be linked (nothing to match
  // or safely create a contact from), and a divergent-name match found by the
  // backfill migration is deliberately left unlinked rather than guessed at.
  personId: v.optional(v.id("people")),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_event", ["eventId"])
  .index("by_event_email", ["eventId", "email"])
  // Guest sign-in by phone (E.164) — the SMS counterpart of by_event_email.
  .index("by_event_phone", ["eventId", "phone"])
  .index("by_event_status", ["eventId", "status"])
  .index("by_token", ["token"])
  // Person-centric audiences Phase 3 (specs/person-centric-audiences.md) —
  // "attended event" / "attended anything within N days" filters need a
  // person → their rsvps lookup (`lib/audienceResolve.ts#resolvePersonFilters`).
  // Absent before this: the only existing rsvp indexes are event-keyed. Bounded
  // per-candidate reads (`.take()`), never a full-table scan.
  .index("by_person", ["personId"])
  // Person-centric audiences / full persona ladder (people.ts#resolvePersonaForRoster)
  // — a non-archived RSVP/ticket is the "guest" participation signal, resolved
  // for a WHOLE chapter roster in one bounded scan rather than a per-person query.
  .index("by_chapter", ["chapterId"]);

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
      // Per-admission assigned attendee names for this line, index-aligned to
      // the `quantity` tickets fulfill() issues. Entry i blank/absent = the
      // ticket is "for the purchaser" and inherits order.name. Length <= quantity.
      attendeeNames: v.optional(v.array(v.string())),
    }),
  ),
  totalCents: v.number(),
  // Optional add-on gift bundled into the SAME checkout as the tickets (the
  // "would you also like to donate?" upsell). Carried on the pending order so
  // the webhook can split the one Stripe charge: tickets → revenue, this →
  // a `donations` row (giving). Absent/0 = tickets only. Not included in
  // `totalCents` (which is the ticket line-item subtotal) — it's added to the
  // Stripe session as its own line so the money stays cleanly attributed.
  donationCents: v.optional(v.number()),
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
  .index("by_external_ref", ["externalRef"])
  // A guest's own orders — powers the signed-in "your tickets" list.
  .index("by_rsvp", ["rsvpId"])
  // The accounts page's book-value revenue sum: a chapter's ticket sales in
  // one bounded read (`reconciliation.ts#accountBalances`).
  .index("by_chapter", ["chapterId"]);

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

/**
 * A guest team for an event — the thing a guest is put on when they're
 * admitted (`eventPages.teamsEnabled`). Attendee-facing and door-assigned;
 * NOT the crew teams on the `volunteer_expectations` module's `team` column,
 * which are staff and assigned in advance. See
 * `@events-os/shared#pickTeamIndex` for the balancing rule.
 *
 * `color` is a key into that module's `TEAM_COLORS` palette, assigned by
 * position when the team set is sized and never changed afterward — the name
 * is what's editable, so an event can call the blue team "Dolphins" without
 * the wristbands changing color underneath them.
 *
 * `assignedCount` is denormalized (the same never-`.collect().length`-at-read
 * -time rule the `eventPages` rollups follow) because every check-in needs the
 * current standings to pick the least-loaded team; counting tickets per scan
 * would read the whole ticket table at the door.
 *
 * Shrinking the team set soft-deactivates (`isActive: false`) instead of
 * deleting, so already-admitted guests keep a resolvable team and a re-grown
 * set gets its custom names back. Absent = active, mirroring `doorGrants`.
 */
export const guestTeams = defineTable({
  eventId: v.id("events"),
  chapterId: v.id("chapters"),
  name: v.string(),
  color: v.string(), // key into TEAM_COLORS
  sortOrder: v.number(),
  isActive: v.optional(v.boolean()),
  assignedCount: v.number(),
  createdAt: v.number(),
}).index("by_event", ["eventId"]);

/** An issued ticket (one row per admission; `code` backs the QR). */
export const tickets = defineTable({
  eventId: v.id("events"),
  chapterId: v.id("chapters"),
  orderId: v.id("ticketOrders"),
  ticketTypeId: v.id("ticketTypes"),
  ticketTypeName: v.string(), // snapshot
  attendeeName: v.string(),
  attendeeEmail: v.string(),
  // The guest team this admission was assigned at check-in, when the event has
  // teams on. Set once and never reassigned — the guest is already wearing the
  // wristband — except by an explicit `guestTeams.setTicketTeam` override.
  // Lives on the TICKET, not the order or the person: a two-ticket order is
  // two humans who each need their own team (and the balancing rule splits
  // them by construction).
  guestTeamId: v.optional(v.id("guestTeams")),
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
 * Per-event door access for OUTSIDE volunteers — the third grant path of
 * `lib/ticketingAccess.ts#requireCheckInAccess`, granted by email from the
 * event page (`doorAccess.ts`). Deliberately email-keyed, not person-keyed:
 * the grantee usually has no `people` row and NO chapter membership — being
 * chapterless is exactly what keeps them out of every member surface
 * (`requireChapterId`), so this table must not require one. `email` is stored
 * pre-normalized (`lib/access.ts#normalizeEmail`). `isActive` absent = active
 * (soft revoke keeps history), mirroring `accessAllowlist`. Off-domain grants
 * also upsert an `accessAllowlist` row stamped `grantedVia: "door"` so the
 * volunteer can sign in as a guest — and so `profiles.completeOnboarding` can
 * refuse to escalate them into a full member.
 */
export const doorGrants = defineTable({
  eventId: v.id("events"),
  chapterId: v.id("chapters"),
  email: v.string(),
  note: v.optional(v.string()),
  isActive: v.optional(v.boolean()),
  createdAt: v.number(),
})
  .index("by_event", ["eventId"])
  .index("by_email", ["email"])
  .index("by_event_email", ["eventId", "email"]);

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

export const BLAST_RECIPIENT_STATUSES = ["queued", "sent", "failed"] as const;

/**
 * One materialized recipient row per EMAIL blast address — the blast-side twin
 * of `schema/campaigns.ts#campaignRecipients`, and the reason an event
 * announcement can carry a real unsubscribe link.
 *
 * ── Why a table rather than a derived token ────────────────────────────────
 * An event blast is bulk mail (organiser-composed promotional copy to a whole
 * audience), so CAN-SPAM/RFC 8058 require a working per-recipient unsubscribe.
 * The two candidate designs were:
 *
 *  1. Derive the token from something already stable — e.g. the guest's
 *     `rsvps.token`. Rejected: that token is the guest's SECRET RSVP-edit
 *     credential. Putting it in an emailed href hands it to every link
 *     scanner/proxy that prefetches the message, and an address can span
 *     several `rsvps` rows (an RSVP + a ticket purchase de-dupe to ONE email),
 *     so there is no 1:1 "stable id" for the thing being unsubscribed anyway.
 *     A signed/HMAC token avoids the leak but can't be reversed to an address,
 *     so `/unsubscribe/<token>` would need a whole second resolution path.
 *  2. Materialize a row per (blast, address) with its own random token — this.
 *     It reuses `campaignRecipients`' exact shape and `newGuestToken()`, so the
 *     existing `/unsubscribe/<token>` route resolves it with no new code path
 *     (`campaigns.ts#getRecipientByToken`/`unsubscribeByToken` fall back to
 *     this table), one recipient's token can only ever name THEIR OWN address,
 *     and a blast finally gets the per-address delivery record it never had.
 *
 * `unsubscribedAt` (rather than a "suppressed" status) records the opt-out
 * without overwriting what actually happened to the send. `eventId` is
 * denormalized off the parent `blasts` row (which carries both `eventId` and
 * `chapterId` for the same reason) so a row read by token — the
 * `/unsubscribe/` path, which has no blast in hand — can say what it was for
 * without a second lookup.
 */
export const blastRecipients = defineTable({
  blastId: v.id("blasts"),
  eventId: v.id("events"),
  email: v.string(), // normalized lowercase
  status: v.union(...BLAST_RECIPIENT_STATUSES.map((s) => v.literal(s))),
  error: v.optional(v.string()),
  unsubscribeToken: v.string(),
  sentAt: v.optional(v.number()),
  unsubscribedAt: v.optional(v.number()),
})
  .index("by_blast", ["blastId"])
  .index("by_blast_and_email", ["blastId", "email"])
  .index("by_token", ["unsubscribeToken"]);

/**
 * IN-PERSON AND ONLINE SALES — merch, snacks, drinks. The third revenue stream
 * alongside gifts and ticket orders (founder model, 2026-08-07: "revenue = gift rows,
 * tickets, and sales").
 *
 * SEPARATE FROM `ticketOrders` on purpose. A sale is structurally similar — a paid
 * Stripe charge tied to an event — but folding merch into ticket orders would inflate
 * attendance and ticket reporting: 178 popcorn purchases would read as 178 more people
 * at Field Day. Ticket counts stay ticket counts.
 *
 * ONE ROW PER PAYMENT, with its decomposed items inline. A single tap often
 * covered several products (someone bought popcorn and a water and the operator typed
 * $6), so `items` is a list — but the payment is the atom, because the payment is what
 * the money and the fee actually attach to. Most payments are Stripe charges
 * (`stripeChargeId`); the ones that came through another rail carry `externalRef`.
 */
export const sales = defineTable({
  chapterId: v.id("chapters"),
  /** The event this sale happened at. Absent if it couldn't be attributed by date. */
  eventId: v.optional(v.id("events")),
  /** Stripe charge id — the idempotency key for a sale Stripe processed. One
   *  sale row per charge, forever. ABSENT on a sale that never touched Stripe;
   *  such a row carries `externalRef` instead. Exactly one of the two is always
   *  set, and each has its own index, so "have I already imported this payment?"
   *  is a single lookup on whichever rail carried it.
   *
   *  Optional since the 2026-08-09 Cash App backfill. A year of in-person money
   *  came through Cash App, which issues no charge id and has no API here, and
   *  the alternatives were both worse: putting a made-up `ch_…` string in a field
   *  named after Stripe would make the ledger lie about its own provenance, and
   *  leaving merch money out of `sales` would push it into `ticketOrders` (which
   *  would inflate attendance — see this table's header) or into `transactions`
   *  as plain income (which contradicts the revenue model: revenue is gifts,
   *  tickets and sales, and the ledger is spend). `ticketOrders` already solves
   *  exactly this with an optional `stripeCheckoutSessionId` beside an optional
   *  `externalRef`; this mirrors it. */
  stripeChargeId: v.optional(v.string()),
  /** The payment's own id on a NON-Stripe rail — the idempotency key for a sale
   *  that arrived some other way. Namespaced by rail
   *  (`cashapp:sale:<day>:<payer>`), because the string has to stay unique
   *  across every rail that ever lands here. */
  externalRef: v.optional(v.string()),
  /** When the card was tapped, not when we imported it. */
  soldAt: v.number(),
  /** Gross, before Stripe's cut — the customer paid this. */
  grossCents: v.number(),
  /** Stripe's fee on this charge, read from its balance transaction. Never derived. */
  feeCents: v.number(),
  /** What was sold. Reconstructed from the amount when the payment app sent no line
   *  items — see `lib/salesCatalog.ts` for why that's sound and where it stops. */
  items: v.array(
    v.object({
      /** Product name, or a price-point label ("$2 item") when the price is shared. */
      label: v.string(),
      quantity: v.number(),
      unitPriceCents: v.number(),
      /** Every product this line could be. Length > 1 means the item is genuinely
       *  uncertain and must never be reported as a single product. */
      candidates: v.array(v.string()),
    }),
  ),
  /** How the item breakdown was arrived at — a trust label, not a provenance note. The
   *  five values are RANKED (see `lib/salesItems.ts`), because a reader deciding whether
   *  "PW Tee ×2" is fact or inference needs to know which, and because a re-sync is
   *  allowed to move a row UP this ladder and never down:
   *   - `manual` — a HUMAN who was there settled it, choosing from the baskets the amount
   *     actually makes (`sales.setSaleItems`). It tops the ladder deliberately: every rung
   *     below is the sync's own reading of a payload, and a person deliberately correcting
   *     one afterwards is a stronger statement than any field the processor happened to
   *     send. Being the top rung is also what PROTECTS the correction — `outranks` already
   *     stops a re-sync moving a row down, so a hand-set breakdown survives every future
   *     enrichment run without the sync needing to know this rung exists.
   *   - `stripe_line_items` — Stripe told us, exactly. The charge's
   *     `metadata.line_items` named real Stripe Price objects, and Σ(unit_amount × qty)
   *     was verified equal to the charge to the cent. Neither SKU nor price is inferred.
   *   - `charge_description` — the point of sale wrote down what it rang up
   *     ("1x PW Tee"). A statement by the seller rather than a deduction, so it holds on
   *     days no catalogue covers; the unit price is derived by division, which is why it
   *     ranks below the above.
   *   - `amount_decomposition` — INFERRED from the amount against the hand-kept
   *     per-event price list, and only when exactly one basket makes the total.
   *   - `unresolved` — nothing above could speak; `items` is empty and a human must
   *     look. The revenue still counts in full; only the breakdown is missing. */
  itemSource: v.union(
    v.literal("manual"),
    v.literal("stripe_line_items"),
    v.literal("charge_description"),
    v.literal("amount_decomposition"),
    v.literal("unresolved"),
  ),
  /** Card-present vs online checkout — the two ways a sale reaches us. */
  channel: v.union(v.literal("in_person"), v.literal("online")),
  createdAt: v.number(),
})
  .index("by_charge", ["stripeChargeId"])
  .index("by_external_ref", ["externalRef"])
  .index("by_chapter_and_soldAt", ["chapterId", "soldAt"])
  .index("by_event", ["eventId"]);
