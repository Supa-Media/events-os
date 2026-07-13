import { v } from "convex/values";
import { COLUMN_TYPES } from "@events-os/shared";

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
  // Constrained to the canonical `COLUMN_TYPES` universe (packages/shared).
  // The `0015_audit_column_types` migration reported 0 out-of-vocabulary `type`
  // values on prod, so tightening from `v.string()` to this union validates
  // against every existing template/event column.
  type: v.union(...COLUMN_TYPES.map((t) => v.literal(t))),
  options: v.optional(v.array(selectOption)),
  // Type-specific config bag (mirrors shared `ColumnDef.config`, typed
  // `Record<string, unknown>`). Left as `v.any()` — NOT tightened. Unlike
  // `type` (verified safe by the `0015` 0-offenders audit), there is no
  // `0015`-style audit of config VALUE shapes on prod, and the public
  // `columns.addColumn/update` args accept `v.any()`, so a stored config could
  // in principle be a non-object. `config` is "reserved" and currently unread,
  // so tightening it has ~zero value while risking a rejected schema push on a
  // destructive deploy. Tightening is deferred until a config-shape audit exists.
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
  // Manual row height (px) when the user has drag-resized this row; absent means
  // the row auto-fits its content. Cloned template → event like other fields.
  rowHeight: v.optional(v.number()),
  // Custom-column values, keyed by column key.
  fields: v.optional(v.record(v.string(), v.any())),
};
