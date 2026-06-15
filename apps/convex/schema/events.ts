import { defineTable } from "convex/server";
import { v } from "convex/values";
import { columnFields, itemFieldsBase } from "./shared";

/**
 * Event — a dated instance of an event type (the core object the app revolves
 * around). Created from a template; its columns + items are cloned snapshots,
 * so it's insulated from later template edits.
 */
export const events = defineTable({
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
  .index("by_eventType", ["eventTypeId"]);

/** Column definitions cloned onto an event (snapshot of the template's). */
export const eventColumns = defineTable({
  eventId: v.id("events"),
  ...columnFields,
})
  .index("by_event", ["eventId"])
  .index("by_event_module", ["eventId", "module"]);

/**
 * An item on a specific event. Day-offset modules auto-schedule off the single
 * event date (`dueDate = eventDate + offsetDays`). Rolls up into readiness.
 */
export const eventItems = defineTable({
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
  .index("by_chapter", ["chapterId"]);

/**
 * Role assignment — who holds which role on an event. Rotatable; the history
 * across events surfaces burnout and rotation opportunities.
 */
export const roleAssignments = defineTable({
  eventId: v.id("events"),
  chapterId: v.id("chapters"),
  roleId: v.id("eventRoles"),
  personId: v.id("people"),
  createdAt: v.number(),
})
  .index("by_event", ["eventId"])
  .index("by_event_role", ["eventId", "roleId"])
  .index("by_person", ["personId"]);
