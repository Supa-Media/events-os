import { defineTable } from "convex/server";
import { v } from "convex/values";
import { columnFields, itemFieldsBase } from "./shared";

/**
 * Event Type / Template — the canonical, reusable blueprint for a kind of
 * event. Its columns + base items live in `templateColumns` / `templateItems`.
 * `version` bumps on every structural edit; events clone the template at
 * creation so in-flight events are never disrupted by later edits.
 */
export const eventTypes = defineTable({
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
  .index("by_chapter_slug", ["chapterId", "slug"]);

/** Column definitions for a template's modules (configurable per template). */
export const templateColumns = defineTable({
  eventTypeId: v.id("eventTypes"),
  ...columnFields,
})
  .index("by_eventType", ["eventTypeId"])
  .index("by_eventType_module", ["eventTypeId", "module"]);

/** Base items for a template's modules (the rows authors edit). */
export const templateItems = defineTable({
  eventTypeId: v.id("eventTypes"),
  ...itemFieldsBase,
  // Role reference scoped to this template's roles.
  roleId: v.optional(v.id("templateRoles")),
})
  .index("by_eventType", ["eventTypeId"])
  .index("by_eventType_module", ["eventTypeId", "module"]);
