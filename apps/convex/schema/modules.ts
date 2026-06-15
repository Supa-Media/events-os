import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Custom (author-created) modules, owned by a TEMPLATE and cloned to each EVENT
 * on creation — mirroring the roles clone-on-create pattern. Core modules stay
 * platform-wide constants (CORE_MODULES in @events-os/shared); only their deltas
 * (toggled-off + label/owner overrides) live on the parent eventType/event rows.
 *
 * A custom module's columns live in `templateColumns` / `eventColumns` keyed by
 * the module string `key` (no FK), so the grid renders them exactly like a core
 * module. `ownerRoleKey` resolves against roles in the SAME scope (templateRoles
 * for templates, eventRoles for events), so the owner survives the clone without
 * a dangling id. `key` stays stable across rename so columns/items keep resolving.
 */
const offsetMode = v.union(
  v.literal("none"),
  v.literal("days"),
  v.literal("minutes"),
);

/** A template's custom modules. */
export const templateModules = defineTable({
  eventTypeId: v.id("eventTypes"),
  key: v.string(),
  label: v.string(),
  ownerRoleKey: v.optional(v.string()),
  offsetMode: v.optional(offsetMode),
  order: v.number(),
  isActive: v.optional(v.boolean()),
})
  .index("by_template", ["eventTypeId"])
  .index("by_template_key", ["eventTypeId", "key"]);

/** An event's custom modules (cloned from the template, then edited freely). */
export const eventModules = defineTable({
  eventId: v.id("events"),
  key: v.string(),
  label: v.string(),
  ownerRoleKey: v.optional(v.string()),
  offsetMode: v.optional(offsetMode),
  order: v.number(),
})
  .index("by_event", ["eventId"])
  .index("by_event_key", ["eventId", "key"]);
