import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  supaAuthTables,
  supaTenantTables,
  supaNotificationTables,
} from "@supa/convex/schema";

/**
 * Database schema for Events OS.
 *
 * Framework base tables: auth (`users` + @convex-dev/auth), multi-tenant by
 * `chapter` (`chapters` + `userChapters`), and push notifications.
 *
 * App tables model the spec's core concepts:
 *   Event Type / Template → eventTypes (+ templateTasks, templateRunOfShow)
 *   Event                 → events (+ tasks, eventRunOfShow, roleAssignments)
 *   Person / Volunteer    → people
 *
 * Chapter scoping is on every app table from day one (multi-city is V3, but the
 * column is here now so the migration is painless).
 */
const schema = defineSchema({
  ...supaAuthTables,
  ...supaTenantTables({ tenantName: "chapter" }),
  ...supaNotificationTables,

  /**
   * Event Type / Template — the canonical, reusable blueprint for a kind of
   * event (e.g. "Worship With Strangers", "Eden"). A template is structured
   * data: a roles set + active components, with its task list and run-of-show
   * in `templateTasks` / `templateRunOfShow`.
   *
   * `version` bumps on every edit. Events clone the template at creation, so
   * in-flight events are never disrupted by later template edits.
   */
  eventTypes: defineTable({
    chapterId: v.id("chapters"),
    name: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
    // WwS is a ~10% scaled-down variant of Eden — a template can inherit from
    // a parent so variants stay structurally aligned.
    deriveFromEventTypeId: v.optional(v.id("eventTypes")),
    // Active role keys for this type (subset of the 4 canonical roles).
    roles: v.array(v.string()),
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

  /** A task in a template's task list, carrying its T-minus offset + owning role. */
  templateTasks: defineTable({
    eventTypeId: v.id("eventTypes"),
    title: v.string(),
    // Days before the event date this task is due (T-minus). 0 = day-of.
    tMinusOffsetDays: v.number(),
    owningRole: v.string(),
    order: v.number(),
  }).index("by_eventType", ["eventTypeId"]),

  /** A row in a template's run-of-show table. */
  templateRunOfShow: defineTable({
    eventTypeId: v.id("eventTypes"),
    // Minutes relative to event start; negative = before start (setup/soundcheck).
    offsetMinutes: v.number(),
    segment: v.string(),
    owningRole: v.optional(v.string()),
    notes: v.optional(v.string()),
    order: v.number(),
  }).index("by_eventType", ["eventTypeId"]),

  /**
   * Event — a dated instance of an event type (the core object the whole app
   * revolves around). Created from a template; its tasks/run-of-show are cloned
   * snapshots so it's insulated from later template edits.
   */
  events: defineTable({
    chapterId: v.id("chapters"),
    eventTypeId: v.id("eventTypes"),
    // Template version this event was spun up from (for display / drift checks).
    templateVersion: v.number(),
    name: v.string(),
    // Event start (timestamp). Moving this re-derives every task's due date.
    eventDate: v.number(),
    location: v.optional(v.string()),
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

  /**
   * A task on a specific event. Auto-scheduled off the single event date:
   * `dueDate = eventDate - tMinusOffsetDays`. Rolls up into per-event readiness.
   */
  tasks: defineTable({
    eventId: v.id("events"),
    chapterId: v.id("chapters"),
    title: v.string(),
    tMinusOffsetDays: v.number(),
    // Back-calculated from the event date; recomputed when the date moves.
    dueDate: v.number(),
    owningRole: v.string(),
    assigneePersonId: v.optional(v.id("people")),
    status: v.union(
      v.literal("not_started"),
      v.literal("in_progress"),
      v.literal("done"),
    ),
    order: v.number(),
    createdAt: v.number(),
  })
    .index("by_event", ["eventId"])
    .index("by_event_status", ["eventId", "status"])
    .index("by_chapter", ["chapterId"]),

  /** A run-of-show row cloned onto a specific event (the day-of script). */
  eventRunOfShow: defineTable({
    eventId: v.id("events"),
    offsetMinutes: v.number(),
    segment: v.string(),
    owningRole: v.optional(v.string()),
    notes: v.optional(v.string()),
    order: v.number(),
  }).index("by_event", ["eventId"]),

  /**
   * Role assignment — who holds which role on an event. Rotatable; the history
   * across events surfaces burnout and rotation opportunities.
   */
  roleAssignments: defineTable({
    eventId: v.id("events"),
    chapterId: v.id("chapters"),
    role: v.string(),
    personId: v.id("people"),
    createdAt: v.number(),
  })
    .index("by_event", ["eventId"])
    .index("by_event_role", ["eventId", "role"])
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
});

export default schema;
