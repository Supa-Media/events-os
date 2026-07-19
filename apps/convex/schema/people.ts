import { defineTable } from "convex/server";
import { v } from "convex/values";

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
  .index("by_manager", ["managerId"]);

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
