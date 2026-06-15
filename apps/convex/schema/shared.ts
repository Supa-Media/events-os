import { v } from "convex/values";

/** Reusable validator for a select/status option (mirrors shared SelectOption). */
export const selectOption = v.object({
  value: v.string(),
  label: v.string(),
  color: v.optional(v.string()),
  isComplete: v.optional(v.boolean()),
});

/** Reusable validator for a column definition (template + event copies share it). */
export const columnFields = {
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
export const itemFieldsBase = {
  module: v.string(),
  title: v.string(),
  order: v.number(),
  // Signed day offset (negative = before event), for planning_doc + comms.
  offsetDays: v.optional(v.number()),
  // Signed minute offset from event start, for run_of_show.
  offsetMinutes: v.optional(v.number()),
  // Status value (matches a value in the module's status column options).
  status: v.optional(v.string()),
  // Column keys on THIS row that a template author marked as "pre-plan" — cells
  // that need explicit sign-off before the event (often pre-filled with
  // placeholder text the user must edit, so completion is the explicit tick, not
  // just filling the cell). Cloned template → event. Drives the pre-plan phase.
  prePlanColumns: v.optional(v.array(v.string())),
  // Custom-column values, keyed by column key.
  fields: v.optional(v.record(v.string(), v.any())),
};
