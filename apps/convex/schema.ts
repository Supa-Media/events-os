import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { supaAuthTables, supaNotificationTables } from "@supa-media/convex/schema";

/**
 * Database schema for Events OS.
 *
 * Framework base tables: auth (`users` + @convex-dev/auth), multi-tenant by
 * `chapter` (`chapters` + `userChapters`), and push notifications.
 *
 * App tables use a UNIFIED ITEMS model. Every planning surface — planning doc,
 * supplies, comms, run-of-show — is a "module": a list of items rendered through
 * a configurable column set.
 *
 *   Roles            → roles (editable per chapter)
 *   Event Type/Template → eventTypes (+ templateColumns, templateItems)
 *   Event            → events (+ eventColumns, eventItems, roleAssignments)
 *   Person/Volunteer → people
 *
 * Templates are extensible (authors add/hide/reorder columns + items). Events
 * clone the template's columns AND items at creation, so they're insulated from
 * later template edits and stay locked-but-editable. The fields the backend
 * computes on (title, offset, status, role, owner, due date) are promoted to
 * typed columns on each item; everything else lives in the `fields` bag.
 *
 * Chapter scoping is on every app table from day one (multi-city is V3).
 */

/** Reusable validator for a select/status option (mirrors shared SelectOption). */
const selectOption = v.object({
  value: v.string(),
  label: v.string(),
  color: v.optional(v.string()),
  isComplete: v.optional(v.boolean()),
});

/** Reusable validator for a column definition (template + event copies share it). */
const columnFields = {
  module: v.string(),
  key: v.string(),
  label: v.string(),
  kind: v.union(v.literal("system"), v.literal("custom")),
  type: v.string(),
  options: v.optional(v.array(selectOption)),
  config: v.optional(v.any()),
  isVisible: v.boolean(),
  order: v.number(),
  width: v.optional(v.number()),
};

/**
 * Reusable validator for an item's promoted fields + custom-field bag, WITHOUT
 * the role reference. `roleId` is scope-specific (template items reference
 * `templateRoles`, event items reference `eventRoles`), so each table adds its
 * own `roleId` field on top of this base.
 */
const itemFieldsBase = {
  module: v.string(),
  title: v.string(),
  order: v.number(),
  // Signed day offset (negative = before event), for planning_doc + comms.
  offsetDays: v.optional(v.number()),
  // Signed minute offset from event start, for run_of_show.
  offsetMinutes: v.optional(v.number()),
  // Status value (matches a value in the module's status column options).
  status: v.optional(v.string()),
  // Custom-column values, keyed by column key.
  fields: v.optional(v.record(v.string(), v.any())),
};

const schema = defineSchema({
  ...supaAuthTables,
  ...supaNotificationTables,

  /**
   * Chapter (tenant) — a city. Owns its events, team, templates, and roster.
   * Multi-city is V3; the column is here now so the migration is painless.
   */
  chapters: defineTable({
    name: v.string(),
    slug: v.optional(v.string()),
    image: v.optional(v.string()),
    isActive: v.optional(v.boolean()),
    createdAt: v.optional(v.number()),
  })
    .index("by_slug", ["slug"])
    .index("by_name", ["name"]),

  /**
   * App-layer user profile — name + phone the user supplies during onboarding.
   * The framework `users` table owns auth + email; this holds the editable
   * profile fields Events OS needs. One row per user.
   */
  userProfiles: defineTable({
    userId: v.id("users"),
    name: v.string(),
    phone: v.string(),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
  }).index("by_userId", ["userId"]),

  /** Junction: which chapter a user belongs to, and their role within it. */
  userChapters: defineTable({
    userId: v.id("users"),
    chapterId: v.id("chapters"),
    role: v.optional(v.string()),
    isActive: v.optional(v.boolean()),
    joinedAt: v.optional(v.number()),
  })
    .index("by_userId", ["userId"])
    .index("by_chapterId", ["chapterId"])
    .index("by_userId_chapterId", ["userId", "chapterId"]),

  /**
   * Template role — an editable role OWNED by a template (Event Lead, Comms
   * Lead, … seeded from DEFAULT_ROLES). Renamable/reorderable/deletable per
   * template; `key` stays stable across rename so item/owner references resolve.
   * Cloned onto each event as `eventRoles` at creation.
   */
  templateRoles: defineTable({
    eventTypeId: v.id("eventTypes"),
    key: v.string(),
    label: v.string(),
    description: v.optional(v.string()),
    order: v.number(),
    isArchived: v.optional(v.boolean()),
  })
    .index("by_template", ["eventTypeId"])
    .index("by_template_key", ["eventTypeId", "key"]),

  /**
   * Event role — a role owned by a live event, cloned from its template's
   * `templateRoles` at creation and independently editable thereafter (so an
   * event can add/remove roles its template didn't have). `roleAssignments` and
   * event items reference these.
   */
  eventRoles: defineTable({
    eventId: v.id("events"),
    key: v.string(),
    label: v.string(),
    description: v.optional(v.string()),
    order: v.number(),
  })
    .index("by_event", ["eventId"])
    .index("by_event_key", ["eventId", "key"]),

  /**
   * Event Type / Template — the canonical, reusable blueprint for a kind of
   * event. Its columns + base items live in `templateColumns` / `templateItems`.
   * `version` bumps on every structural edit; events clone the template at
   * creation so in-flight events are never disrupted by later edits.
   */
  eventTypes: defineTable({
    chapterId: v.id("chapters"),
    name: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
    // WwS is a ~10% scaled-down variant of Eden — a template can inherit from a
    // parent so variants stay structurally aligned.
    deriveFromEventTypeId: v.optional(v.id("eventTypes")),
    // This type's roles live in `templateRoles` (keyed by eventTypeId).
    // Active component keys (6 core always; 2 more for larger events).
    activeComponents: v.array(v.string()),
    version: v.number(),
    isArchived: v.optional(v.boolean()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_chapter", ["chapterId"])
    .index("by_chapter_slug", ["chapterId", "slug"]),

  /** Column definitions for a template's modules (configurable per template). */
  templateColumns: defineTable({
    eventTypeId: v.id("eventTypes"),
    ...columnFields,
  })
    .index("by_eventType", ["eventTypeId"])
    .index("by_eventType_module", ["eventTypeId", "module"]),

  /** Base items for a template's modules (the rows authors edit). */
  templateItems: defineTable({
    eventTypeId: v.id("eventTypes"),
    ...itemFieldsBase,
    // Role reference scoped to this template's roles.
    roleId: v.optional(v.id("templateRoles")),
  })
    .index("by_eventType", ["eventTypeId"])
    .index("by_eventType_module", ["eventTypeId", "module"]),

  /**
   * Event — a dated instance of an event type (the core object the app revolves
   * around). Created from a template; its columns + items are cloned snapshots,
   * so it's insulated from later template edits.
   */
  events: defineTable({
    chapterId: v.id("chapters"),
    eventTypeId: v.id("eventTypes"),
    // Template version this event was spun up from (for display / drift checks).
    templateVersion: v.number(),
    name: v.string(),
    // Event start (timestamp, includes time-of-day). Moving this re-derives
    // every item's due date.
    eventDate: v.number(),
    location: v.optional(v.string()),
    budget: v.optional(v.number()),
    // The single person accountable for the event: fills in other owners and
    // keeps every detail current. Distinct from role assignments.
    ownerPersonId: v.optional(v.id("people")),
    // Background image (Convex storageId or URL) for the venue site map.
    siteMapImage: v.optional(v.string()),
    status: v.union(
      v.literal("planning"),
      v.literal("ready"),
      v.literal("completed"),
      v.literal("cancelled"),
    ),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_chapter", ["chapterId"])
    .index("by_chapter_date", ["chapterId", "eventDate"])
    .index("by_eventType", ["eventTypeId"]),

  /** Column definitions cloned onto an event (snapshot of the template's). */
  eventColumns: defineTable({
    eventId: v.id("events"),
    ...columnFields,
  })
    .index("by_event", ["eventId"])
    .index("by_event_module", ["eventId", "module"]),

  /**
   * An item on a specific event. Day-offset modules auto-schedule off the single
   * event date (`dueDate = eventDate + offsetDays`). Rolls up into readiness.
   */
  eventItems: defineTable({
    eventId: v.id("events"),
    chapterId: v.id("chapters"),
    ...itemFieldsBase,
    // Role reference scoped to this event's roles.
    roleId: v.optional(v.id("eventRoles")),
    // Per-event owner (a person); template items have no owner.
    ownerPersonId: v.optional(v.id("people")),
    // Back-calculated from the event date for day-offset modules.
    dueDate: v.optional(v.number()),
  })
    .index("by_event", ["eventId"])
    .index("by_event_module", ["eventId", "module"])
    .index("by_chapter", ["chapterId"]),

  /**
   * Role assignment — who holds which role on an event. Rotatable; the history
   * across events surfaces burnout and rotation opportunities.
   */
  roleAssignments: defineTable({
    eventId: v.id("events"),
    chapterId: v.id("chapters"),
    roleId: v.id("eventRoles"),
    personId: v.id("people"),
    createdAt: v.number(),
  })
    .index("by_event", ["eventId"])
    .index("by_event_role", ["eventId", "roleId"])
    .index("by_person", ["personId"]),

  /**
   * Person / Volunteer — chapter roster with skills, vetting, and (via
   * roleAssignments) full participation history.
   */
  people: defineTable({
    chapterId: v.id("chapters"),
    name: v.string(),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    userId: v.optional(v.id("users")),
    // Services this person can offer (worship, audio, videography…). The basis
    // for "who can deliver X?" discovery. (Named `skills` for legacy reasons.)
    skills: v.optional(v.array(v.string())),
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
    isActive: v.optional(v.boolean()),
    // Roster lifecycle state (richer than isActive). isActive is kept in sync as
    // a convenience flag (false only when status === "inactive").
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
    createdAt: v.number(),
  })
    .index("by_chapter", ["chapterId"])
    .index("by_user", ["userId"]),

  /**
   * Site-map marker — a labelled pin placed on an event's venue map at a
   * normalized position (x,y in 0..1 of the image), categorized (team area,
   * station, equipment drop, stage…). The visual layout of where things go.
   */
  siteMarkers: defineTable({
    chapterId: v.id("chapters"),
    eventId: v.id("events"),
    x: v.number(),
    y: v.number(),
    label: v.string(),
    // Free color name (e.g. "red"); markers aren't a fixed category set.
    color: v.optional(v.string()),
    // Legacy category (older markers); no longer set by the UI.
    category: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_event", ["eventId"])
    .index("by_chapter", ["chapterId"]),

  /**
   * Site-map shape — a basic sketched element so you can rough out the venue
   * WITHOUT a background image. `rect`/`circle` use (x,y) top-left + (w,h);
   * `line` uses (x,y)→(x2,y2). All coords normalized 0..1.
   */
  siteShapes: defineTable({
    chapterId: v.id("chapters"),
    eventId: v.id("events"),
    type: v.union(v.literal("rect"), v.literal("circle"), v.literal("line")),
    x: v.number(),
    y: v.number(),
    w: v.optional(v.number()),
    h: v.optional(v.number()),
    x2: v.optional(v.number()),
    y2: v.optional(v.number()),
    color: v.optional(v.string()),
    label: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_event", ["eventId"])
    .index("by_chapter", ["chapterId"]),

  /**
   * Site-map placement — overlays an existing SUPPLY (eventItem, module
   * "supplies") or VOLUNTEER (engagement, type "volunteer") onto the venue map
   * as a positioned, draggable chip at a normalized position (x,y in 0..1).
   * `refId` is the source row's _id (kept as a string so one table can point at
   * either source); `kind` says which table it references.
   */
  siteMapPlacements: defineTable({
    chapterId: v.id("chapters"),
    eventId: v.id("events"),
    kind: v.union(v.literal("supply"), v.literal("volunteer")),
    refId: v.string(), // the eventItem _id (supply) or engagement _id (volunteer)
    x: v.number(), // normalized 0..1
    y: v.number(),
    createdAt: v.number(),
  })
    .index("by_event", ["eventId"])
    .index("by_event_kind", ["eventId", "kind"])
    .index("by_chapter", ["chapterId"]),

  /**
   * Engagement — one PERSON's involvement in one EVENT, on specific terms.
   *
   * The key modeling insight: volunteer-vs-paid is NOT a property of a person,
   * it's a property of THIS engagement. The same person can volunteer at one
   * event and be a paid vendor at the next — just two engagements with different
   * `type`. Surfaced on the event as two lists (Volunteers / Vendors). Paid
   * engagements carry an amount + payment status and roll into the event budget.
   */
  engagements: defineTable({
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
  })
    .index("by_event", ["eventId"])
    .index("by_event_type", ["eventId", "type"])
    .index("by_person", ["personId"])
    .index("by_chapter", ["chapterId"]),

  /**
   * AI agent run — one invocation of an agent feature (e.g. "fill supply
   * photos"). Carries status, how many items it touched, and total USD cost. A
   * run owns a set of `aiChanges`, which makes every run one-click revertible.
   */
  aiRuns: defineTable({
    chapterId: v.id("chapters"),
    userId: v.id("users"),
    feature: v.string(),
    eventId: v.optional(v.id("events")),
    model: v.string(),
    status: v.union(
      v.literal("running"),
      v.literal("done"),
      v.literal("error"),
      v.literal("reverted"),
    ),
    itemsTouched: v.number(),
    costUsd: v.number(),
    summary: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_chapter", ["chapterId"])
    .index("by_chapter_time", ["chapterId", "createdAt"]),

  /**
   * AI change — one revertible edit an agent run made to an item. The generic
   * key/before/after shape is intentional: any agent edit to any field reuses
   * this same log, and Undo restores `before`.
   *
   * `key` is interpreted by the revert logic:
   *   - "__created"      → the run CREATED this item; Undo deletes it.
   *   - "fields.<key>"   → a custom-column value in the item's `fields` bag.
   *   - any other string → a promoted top-level field (title, status, roleId…).
   */
  aiChanges: defineTable({
    runId: v.id("aiRuns"),
    chapterId: v.id("chapters"),
    eventId: v.optional(v.id("events")),
    itemId: v.id("eventItems"),
    key: v.string(),
    before: v.optional(v.any()),
    after: v.optional(v.any()),
    revertedAt: v.optional(v.number()),
  }).index("by_run", ["runId"]),

  /**
   * AI assistant thread — a Notion-AI-style conversation pinned to one event.
   * Messages stream into `aiMessages` as the agent works, so the panel renders
   * reasoning + tool calls reactively.
   */
  aiThreads: defineTable({
    chapterId: v.id("chapters"),
    eventId: v.id("events"),
    userId: v.id("users"),
    title: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_event", ["eventId"])
    .index("by_chapter", ["chapterId"]),

  /**
   * AI assistant message — one entry in a thread. `kind` distinguishes the
   * user's prompt, the agent's reasoning trace, each tool call + its result, the
   * final assistant reply, and errors — so the panel can render each distinctly
   * (collapsible reasoning, tool-call chips, etc.). `order` is monotonic within
   * a thread for stable display.
   */
  aiMessages: defineTable({
    threadId: v.id("aiThreads"),
    chapterId: v.id("chapters"),
    runId: v.optional(v.id("aiRuns")),
    kind: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("reasoning"),
      v.literal("tool_call"),
      v.literal("tool_result"),
      v.literal("error"),
    ),
    text: v.optional(v.string()),
    toolName: v.optional(v.string()),
    toolArgs: v.optional(v.any()),
    toolOk: v.optional(v.boolean()),
    order: v.number(),
    createdAt: v.number(),
  }).index("by_thread", ["threadId"]),

  /**
   * AI usage — token + dollar accounting per completion call, for the rolling
   * per-user / per-chapter / org budget windows.
   */
  aiUsage: defineTable({
    chapterId: v.id("chapters"),
    userId: v.id("users"),
    runId: v.optional(v.id("aiRuns")),
    feature: v.string(),
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cachedTokens: v.optional(v.number()),
    costUsd: v.number(),
    createdAt: v.number(),
  })
    .index("by_chapter_time", ["chapterId", "createdAt"])
    .index("by_user_time", ["userId", "createdAt"]),

  /**
   * AI settings — a single-row (singleton) table holding the deployment-wide
   * active model every run uses. Only superusers can change it. Read via
   * `.first()`; no index needed.
   */
  aiSettings: defineTable({
    activeModel: v.string(),
    updatedBy: v.optional(v.id("users")),
    updatedAt: v.number(),
  }),
});

export default schema;
