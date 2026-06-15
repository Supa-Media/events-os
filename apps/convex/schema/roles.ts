import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Template role — an editable role OWNED by a template (Event Lead, Comms
 * Lead, … seeded from DEFAULT_ROLES). Renamable/reorderable/deletable per
 * template; `key` stays stable across rename so item/owner references resolve.
 * Cloned onto each event as `eventRoles` at creation.
 */
export const templateRoles = defineTable({
  eventTypeId: v.id("eventTypes"),
  key: v.string(),
  label: v.string(),
  description: v.optional(v.string()),
  order: v.number(),
  isArchived: v.optional(v.boolean()),
})
  .index("by_template", ["eventTypeId"])
  .index("by_template_key", ["eventTypeId", "key"]);

/**
 * Event role — a role owned by a live event, cloned from its template's
 * `templateRoles` at creation and independently editable thereafter (so an
 * event can add/remove roles its template didn't have). `roleAssignments` and
 * event items reference these.
 */
export const eventRoles = defineTable({
  eventId: v.id("events"),
  key: v.string(),
  label: v.string(),
  description: v.optional(v.string()),
  order: v.number(),
})
  .index("by_event", ["eventId"])
  .index("by_event_key", ["eventId", "key"]);
