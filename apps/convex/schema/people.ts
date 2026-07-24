import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Where a `personEmails` row's address was learned from, in TRUST order
 * (highest first) — `lib/personEmails.ts#SOURCE_RANK` is the same order,
 * kept next to it so a future new source updates both together:
 *  - `manual`  — a human explicitly attached this address (future UI; not
 *                written by any Phase 2 path yet).
 *  - `pw`      — `people.pwEmail` (core-team Public Worship address).
 *  - `roster`  — `people.email` (the roster's own contact field).
 *  - `donor`   — the linked `donors` row's email (`lib/givingDonors.ts#linkDonorToPerson`).
 *  - `rsvp`    — a linked `rsvps` row's email (`lib/rsvpPeople.ts#linkRsvpToPerson`).
 */
export const PERSON_EMAIL_SOURCES = [
  "roster",
  "pw",
  "donor",
  "rsvp",
  "manual",
] as const;

/**
 * Person / Volunteer — chapter roster with skills, vetting, and (via
 * roleAssignments) full participation history.
 */
export const people = defineTable({
  chapterId: v.id("chapters"),
  name: v.string(),
  email: v.optional(v.string()),
  phone: v.optional(v.string()),
  userId: v.optional(v.id("users")),
  // Services this person can offer (worship, audio, videography…). The basis
  // for "who can deliver X?" discovery. Chapter-OS successor to the retired
  // `skills` field (dropped in Deploy C after `backfillPeopleServices` copied
  // `skills` → `services` and `clearLegacyFields` drained the legacy column).
  services: v.optional(v.array(v.string())),
  // Typical fee when engaged as a PAID vendor (prefills a paid engagement).
  usualRateUsd: v.optional(v.number()),
  // Free-form notes about this person (preferences, availability, context).
  notes: v.optional(v.string()),
  // On the core team (has / will get backend access). Only team members can be
  // event owners or hold lead roles. Distinct from being a volunteer/vendor.
  // Persona is not a single rigid kind: `isTeamMember` flags core team,
  // `usualRateUsd` being set marks vendor capability, and everyone else is a
  // volunteer — the same person can be a vendor on one event and volunteer on
  // another, so these signals coexist rather than partition the roster.
  isTeamMember: v.optional(v.boolean()),
  // Person-centric audiences Phase 1 (specs/person-centric-audiences.md item 1)
  // — the contact/roster discriminator. `true` marks a row that exists ONLY
  // for identity/contact purposes (auto-created from a donor gift, a CSV
  // import, or a public RSVP — see `lib/givingDonors.ts#linkDonorToPerson`
  // and `lib/rsvpPeople.ts#linkRsvpToPerson`), never a person who actually
  // showed up to volunteer/lead/manage. Contact rows are EXCLUDED from
  // roster-facing surfaces (the People tab's default listing, org-chart
  // pickers, manager derivation, reminder/digest scans) but REMAIN visible to
  // identity matching (`lib/org.ts#chapterRoster`'s callers that dedupe
  // donors/guests must still see them, so a repeat giver/guest links to the
  // SAME person instead of spawning a duplicate). Unset = a real roster row
  // (the pre-existing default; nothing before this field ever meant "contact
  // only", so `undefined`/`false` both read as "on the roster").
  isContactOnly: v.optional(v.boolean()),
  // Person-centric audiences Phase 2 (specs/person-centric-audiences.md Phase
  // 2 item 3) — a person-level marketing preference layered OVER the
  // address-level `emailSuppressions` ledger, which stays authoritative and
  // untouched (an unsubscribe/bounce/complaint still permanently suppresses
  // that ADDRESS everywhere). `true` excludes this PERSON entirely from the
  // "people" audience source's live resolution (`lib/audienceResolve.ts`),
  // regardless of which address would have been chosen. Never gates
  // transactional email (RSVP confirmations, receipts, etc. — those aren't
  // campaign sends). Unset/false = the pre-existing default (reachable).
  marketingOptOut: v.optional(v.boolean()),
  vettingStatus: v.optional(
    v.union(
      v.literal("unvetted"),
      v.literal("pending"),
      v.literal("vetted"),
    ),
  ),
  // Roster lifecycle state. Chapter-OS successor to the retired `isActive`
  // boolean (dropped in Deploy C after `backfillPersonStatus` derived `status`
  // from it and `clearLegacyFields` drained the legacy column).
  status: v.optional(
    v.union(
      v.literal("active"),
      v.literal("inactive"),
      v.literal("transitioning_in"),
      v.literal("transitioning_out"),
      v.literal("unavailable"),
    ),
  ),
  // Core-team job title (e.g. "Music Director") or a vendor's service line.
  role: v.optional(v.string()),
  // "na" is used for companies/vendor orgs that have no personal gender.
  gender: v.optional(
    v.union(v.literal("male"), v.literal("female"), v.literal("na")),
  ),
  // Point of contact — free-text name of the team member who owns this
  // relationship (not yet a hard FK; some POCs aren't on the roster).
  pocName: v.optional(v.string()),
  // Initiatives/events this person is associated with (e.g. "Eden", "Love Thy
  // Neighbor"). Stored as labels now; intended to map onto event modules later.
  projects: v.optional(v.array(v.string())),
  // Preferred contact channels in priority order (e.g. ["slack","call","text"]).
  commsPreferences: v.optional(v.array(v.string())),
  // Public Worship email (distinct from the personal `email`), for core team.
  pwEmail: v.optional(v.string()),
  // Vendor company / organization name (when this person represents a vendor).
  company: v.optional(v.string()),
  // Profile photo (Convex file storageId). Resolved to a URL by `people.list`.
  image: v.optional(v.id("_storage")),
  // A single social / web link for this person (Instagram, LinkedIn, site, …).
  socialLink: v.optional(v.string()),
  // True when this row was materialized from a template's placeholder crew at
  // event creation — a stand-in the team swaps for a real person later.
  isPlaceholder: v.optional(v.boolean()),
  // Academy sample person (Maya/Jordan — the training sandboxes' bench).
  // NOT a placeholder: they can hold roles and replace placeholder crew like
  // a real person, but every operational surface (People roster, Team views,
  // "who's trained", real events' pickers) excludes them. Only sandbox-scoped
  // pickers (people.list/teamMembers with a training eventId) offer them.
  isSamplePerson: v.optional(v.boolean()),
  // This person's manager (another roster person). Powers the Team org view:
  // reports roll up to their manager, transitively, so a director can see the
  // whole structure under them. Kept acyclic by `people.update`.
  managerId: v.optional(v.id("people")),
  createdAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  .index("by_user", ["userId"])
  .index("by_manager", ["managerId"])
  // Resolve an inbound email's sender address to a roster person (the receipt-
  // ingest pipeline's auth gate — see `receiptInbox.resolvePersonByEmail`).
  // Normalized (lowercased/trimmed) addresses are written by `people.update`.
  .index("by_email", ["email"]);

/**
 * Person field AUDIT (owner feedback #4) — a lightweight, additive breadcrumb
 * trail for the People tab: one immutable row per HUMAN change to a person's
 * contact identity (name / email / phone) via `people.update`. Deliberately
 * cheap: it does NOT audit every profile field, only the three that matter for
 * "who is this and how do we reach them" (the same fields the donor audit
 * tracks, so a merged donor↔person pair reads consistently). `changes` is a
 * compact display-ready diff; read bounded newest-first via `by_person` on the
 * person detail. Mirrors `giftAudit`/`donorAudit`'s narration-only shape.
 */
export const personAudit = defineTable({
  personId: v.id("people"),
  chapterId: v.id("chapters"),
  actorUserId: v.id("users"),
  at: v.number(),
  changes: v.array(
    v.object({
      field: v.string(),
      from: v.optional(v.string()),
      to: v.optional(v.string()),
    }),
  ),
  note: v.optional(v.string()),
}).index("by_person", ["personId"]);

/**
 * Person Emails (person-centric audiences Phase 2, specs/person-centric-
 * audiences.md Phase 2 item 1) — every email address KNOWN for a person, with
 * enough provenance to deterministically pick one "best" send address
 * (`lib/personEmails.ts#resolveSendAddress`) without ever collapsing a
 * person down to a single `people.email` field or overwriting a lower-trust
 * observation with a higher one's absence. A person accrues rows here from
 * FOUR places (write-through, never a background job):
 *  - `people.email`/`people.pwEmail` changing via `people.create`/`update`
 *    (source `"roster"`/`"pw"`),
 *  - `lib/givingDonors.ts#linkDonorToPerson` linking/creating a donor's
 *    person (source `"donor"`),
 *  - `lib/rsvpPeople.ts#linkRsvpToPerson` linking/creating a guest's person
 *    (source `"rsvp"`, `verified` mirroring `rsvps.emailVerified`),
 *  - `personEmails.ts#setPrimaryEmail`, which only ever flips `isPrimary` on
 *    an EXISTING row (never mints a `"manual"` row itself today — that source
 *    is reserved for a future manual-add UI).
 * All four are additive/upgrade-only (`lib/personEmails.ts#recordPersonEmail`)
 * — a later observation can raise `verified`/`source` but never silently
 * downgrades or deletes a row a human might be relying on.
 *
 * `isPrimary` is a soft "pick this one" override a human sets via
 * `setPrimaryEmail`; AT MOST ONE row per person may carry `true` (enforced by
 * that mutation, not the schema — Convex has no cross-row constraint).
 * `verified`: `true` for every write-through source except `"rsvp"`, which
 * mirrors `rsvps.emailVerified` (`false` = a pending unconfirmed code; the
 * OTHER three sources are staff/CRM-entered or import-matched, not an
 * anonymous public-form capture, so they're trusted at write time).
 */
export const personEmails = defineTable({
  personId: v.id("people"),
  email: v.string(), // normalized lowercase — the `by_email` dedup key
  source: v.union(...PERSON_EMAIL_SOURCES.map((s) => v.literal(s))),
  verified: v.boolean(),
  isPrimary: v.optional(v.boolean()),
  addedAt: v.number(),
})
  .index("by_person", ["personId"])
  .index("by_email", ["email"]);

/**
 * Template Crew (placeholder people) — stand-in crew authored on a TEMPLATE,
 * before any real person exists. They name the slots an event's Expectations
 * should be owned by (e.g. "Stage Manager", "Lead Usher"). When an event is
 * created each row is materialized into a real chapter `people` row flagged
 * `isPlaceholder`, and the event's Expectations items are pre-owned by them so
 * the team can later swap each placeholder for a real volunteer.
 */
export const templatePeople = defineTable({
  eventTypeId: v.id("eventTypes"),
  name: v.string(),
  // Team/area membership — a placeholder can stand in across several teams
  // (each matches an Expectations team column value). Chapter-OS successor to
  // the retired single-team `team` string (dropped in Deploy C after
  // `backfillTemplatePeopleTeams` copied `team` → `teams`).
  teams: v.optional(v.array(v.string())),
  // Free-form role/title for the placeholder (e.g. "Stage Manager").
  role: v.optional(v.string()),
  order: v.number(),
  createdAt: v.number(),
}).index("by_template", ["eventTypeId"]);

/**
 * Engagement — one PERSON's involvement in one EVENT, on specific terms.
 *
 * The key modeling insight: volunteer-vs-paid is NOT a property of a person,
 * it's a property of THIS engagement. The same person can volunteer at one
 * event and be a paid vendor at the next — just two engagements with different
 * `type`. Surfaced on the event as two lists (Volunteers / Vendors). Paid
 * engagements carry an amount + payment status and roll into the event budget.
 */
export const engagements = defineTable({
  chapterId: v.id("chapters"),
  eventId: v.id("events"),
  personId: v.id("people"),
  type: v.union(v.literal("volunteer"), v.literal("paid")),
  // Which teams/areas this volunteer is attached to (each matches a team value
  // from the event's Volunteer Expectations team list). Volunteers only; a
  // volunteer can serve on more than one team in the same event.
  teams: v.optional(v.array(v.string())),
  // What they're doing this event (e.g. "Videographer", "Welcome team").
  service: v.optional(v.string()),
  status: v.union(
    v.literal("invited"),
    v.literal("confirmed"),
    v.literal("declined"),
  ),
  callTime: v.optional(v.string()),
  responsibilities: v.optional(v.string()),
  // Paid engagements only:
  amountUsd: v.optional(v.number()),
  paymentStatus: v.optional(
    v.union(
      v.literal("unpaid"),
      v.literal("invoiced"),
      v.literal("paid"),
    ),
  ),
  notes: v.optional(v.string()),
  createdAt: v.number(),
  // Category override for the Money-page plan view (WP-money-unify PR1):
  // unset → the module default mapping (`MODULE_DEFAULT_CATEGORY_NAMES`)
  // applies at read time.
  budgetCategoryId: v.optional(v.id("budgetCategories")),
})
  .index("by_event", ["eventId"])
  .index("by_event_type", ["eventId", "type"])
  .index("by_person", ["personId"])
  .index("by_chapter", ["chapterId"]);
