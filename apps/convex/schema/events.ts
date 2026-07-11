import { defineTable } from "convex/server";
import { v } from "convex/values";
import { EVENT_STATUSES } from "@events-os/shared";
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
  // Whether the public song-request page accepts new requests. Undefined is
  // treated as OPEN (so the link works as soon as it's shared); the worship
  // leader can explicitly close requests by setting this false.
  songRequestsOpen: v.optional(v.boolean()),
  // Academy sandbox flag. Training events are real events (real workstreams,
  // rows, assistant) but must never pollute operations: they're excluded from
  // events.list/pipeline, dashboard rollups, and reminder emails.
  isTraining: v.optional(v.boolean()),
  // Module deltas (cloned from the template, then editable). Core modules are
  // platform-wide constants; this stores only which core keys are toggled off +
  // per-core label/owner overrides. Custom modules live in `eventModules`.
  disabledCoreModules: v.optional(v.array(v.string())),
  coreModuleOverrides: v.optional(
    v.array(
      v.object({
        key: v.string(),
        label: v.optional(v.string()),
        ownerRoleKey: v.optional(v.string()),
      }),
    ),
  ),
  // Per-module readiness ("mark as ready" while editing). Distinct from the
  // whole-event `status` below — keyed by module key (core or custom).
  moduleReadiness: v.optional(
    v.array(
      v.object({
        key: v.string(),
        ready: v.boolean(),
        markedBy: v.optional(v.id("people")),
        markedAt: v.optional(v.number()),
      }),
    ),
  ),
  // Built from the shared `EVENT_STATUSES` tuple so the schema validator and the
  // app's status type stay in lock-step from one source of truth.
  status: v.union(...EVENT_STATUSES.map((s) => v.literal(s))),
  createdBy: v.id("users"),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  .index("by_chapter_date", ["chapterId", "eventDate"])
  // A person's owned events within their chapter — the Academy resolves a
  // caller's training events through this instead of scanning the chapter.
  .index("by_chapter_and_ownerPersonId", ["chapterId", "ownerPersonId"])
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
  // Provenance: the template item this row was cloned from (stamped at event
  // creation; backfilled when an event item is promoted to the template).
  // Powers exact event↔template diffing — rows without it (pre-provenance
  // events, hand-added items) fall back to (module, title) matching.
  sourceTemplateItemId: v.optional(v.id("templateItems")),
  // Per-event owner (a person); template items have no owner.
  ownerPersonId: v.optional(v.id("people")),
  // The subset of `prePlanColumns` (inherited from the template) that have been
  // explicitly checked off on this event. pre-plan% = checked ÷ marked.
  prePlanChecked: v.optional(v.array(v.string())),
  // Back-calculated from the event date for day-offset modules.
  dueDate: v.optional(v.number()),
})
  .index("by_event", ["eventId"])
  .index("by_event_module", ["eventId", "module"])
  .index("by_chapter", ["chapterId"])
  // Range-scan a chapter's due-dated items inside a date window (reminder
  // emails) without reading undated or out-of-window rows.
  .index("by_chapter_and_dueDate", ["chapterId", "dueDate"]);

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
