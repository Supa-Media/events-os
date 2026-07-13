/**
 * COMPATIBILITY SHIM — `eventTypes` → `templates` (Chapter-OS rename).
 *
 * The Templates API moved to `templates.ts` (`api.templates.*`). This module
 * re-exports those exact registered functions so `api.eventTypes.*` keeps
 * resolving for OTA-lagged mobile clients that shipped before the rename. Each
 * re-exported name is the SAME underlying Convex function as `api.templates.*`
 * — a true delegation, not a copy — so behavior can never drift between the two
 * paths.
 *
 * The schema table key `eventTypes` and all `eventTypeId` fields are unchanged
 * (Convex can't rename tables); only the API surface gained the `templates`
 * name. Remove this shim once every client has updated past `api.eventTypes.*`.
 */
export {
  list,
  listArchived,
  get,
  create,
  update,
  duplicate,
  archive,
  unarchive,
} from "./templates";
