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

/** Reusable validator for an item's promoted fields + custom-field bag. */
const itemFields = {
  module: v.string(),
  title: v.string(),
  order: v.number(),
  // Signed day offset (negative = before event), for planning_doc + comms.
  offsetDays: v.optional(v.number()),
  // Signed minute offset from event start, for run_of_show.
  offsetMinutes: v.optional(v.number()),
  // Status value (matches a value in the module's status column options).
  status: v.optional(v.string()),
  roleId: v.optional(v.id("roles")),
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
   * Role — an editable, chapter-scoped event-team role (Event Lead, Comms Lead,
   * Logistics Lead, Production Lead by default). Renamable/reorderable; a
   * template declares which roles it uses (`eventTypes.activeRoleIds`).
   */
  roles: defineTable({
    chapterId: v.id("chapters"),
    key: v.string(),
    label: v.string(),
    description: v.optional(v.string()),
    order: v.number(),
    isArchived: v.optional(v.boolean()),
    createdAt: v.number(),
  })
    .index("by_chapter", ["chapterId"])
    .index("by_chapter_key", ["chapterId", "key"]),

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
    // Active roles for this type (subset of the chapter's roles).
    activeRoleIds: v.array(v.id("roles")),
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
    ...itemFields,
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
    // Event start (timestamp). Moving this re-derives every item's due date.
    eventDate: v.number(),
    location: v.optional(v.string()),
    budget: v.optional(v.number()),
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
    ...itemFields,
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
    roleId: v.id("roles"),
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
    skills: v.optional(v.array(v.string())),
    vettingStatus: v.optional(
      v.union(
        v.literal("unvetted"),
        v.literal("pending"),
        v.literal("vetted"),
      ),
    ),
    isActive: v.optional(v.boolean()),
    createdAt: v.number(),
  })
    .index("by_chapter", ["chapterId"])
    .index("by_user", ["userId"]),

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
   * AI change — one revertible edit an agent run made to an item field. The
   * generic key/before/after shape is intentional: any future agent edit to any
   * field reuses this same log, and Undo restores `before`.
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
});

export default schema;
