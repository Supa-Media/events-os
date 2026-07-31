import { defineTable } from "convex/server";
import { v } from "convex/values";
import { EXPORT_JOB_STATUSES, EXPORT_FORMATS } from "@events-os/shared";

/**
 * Data Export jobs — ONE row per "give me this database as a spreadsheet"
 * request, and the app's record that it happened.
 *
 * This table wears two hats on purpose:
 *
 *  1. It is the JOB. Exports can't run in a single transaction (the `people`
 *     export joins six tables per row and the finance ledger runs to tens of
 *     thousands of rows), so a request is accepted, persisted here, and walked
 *     page-by-page by a scheduled runner that parks its cursor in `progress`.
 *     The client watches this row rather than holding a request open.
 *
 *  2. It is the AUDIT TRAIL. A finished export is the densest concentration of
 *     personal data the product can emit — every name, address, phone, giving
 *     history and free-text form answer in a chapter, in one file, on someone's
 *     laptop. `financeAuditLog` covers money edits and is typed to
 *     `subjectType: "transaction" | "budget"`, so it is not a fit; this row is
 *     the answer to "who extracted what, when, and how much of it".
 *
 * THAT SECOND HAT IS WHY EXPIRY PURGES BYTES, NOT ROWS. When the sweep runs it
 * deletes the storage blobs, clears `files[].storageId` and flips `status` to
 * `expired` — the row itself, with its dataset list, row counts and requester,
 * is kept forever. Deleting a job row to reclaim space would erase the only
 * evidence an extraction occurred. Nothing in this feature may delete one.
 *
 * `requestedByLabel` is a deliberate DENORMALIZED SNAPSHOT of the requester's
 * name/email at request time. The person row it came from can be renamed,
 * merged away or deleted; an audit line that reads "unknown person" a year
 * later is not an audit line.
 */
export const exportJobs = defineTable({
  /** Chapter, or the org level — the same `"central"` sentinel `donors.scope`,
   *  `seatAssignments.scope` and the finance scopes use. */
  scope: v.union(v.id("chapters"), v.literal("central")),
  /** Denormalized for the picker's header and the filename; the chapter can be
   *  renamed later without rewriting history. */
  scopeLabel: v.string(),

  requestedByUserId: v.id("users"),
  requestedByPersonId: v.optional(v.id("people")),
  /** Snapshot — see the module doc. Never resolved live at read time. */
  requestedByLabel: v.string(),

  /** `ExportDatasetId[]` (`@events-os/shared`). Stored as strings so retiring a
   *  dataset in code doesn't make old audit rows unreadable. */
  datasetIds: v.array(v.string()),
  /** `ExportSectionId[]` the requester asked for. */
  sectionIds: v.array(v.string()),
  /** Sections dropped because the requester lacked the reach (giving/finance).
   *  Recorded rather than silently discarded, so the job can TELL them the file
   *  is narrower than they ticked. */
  omittedSectionIds: v.array(v.string()),

  format: v.union(...EXPORT_FORMATS.map((f) => v.literal(f))),

  filters: v.object({
    from: v.optional(v.number()),
    to: v.optional(v.number()),
    activeOnly: v.optional(v.boolean()),
    persona: v.optional(v.string()),
    rosterOnly: v.optional(v.boolean()),
  }),

  status: v.union(...EXPORT_JOB_STATUSES.map((s) => v.literal(s))),
  /** Human-readable failure, safe to render. Never a raw stack. */
  error: v.optional(v.string()),

  /** One entry per finished file, in `datasetIds` order. `storageId` is cleared
   *  (not the entry) when the sweep expires the job. */
  files: v.array(
    v.object({
      datasetId: v.string(),
      fileName: v.string(),
      storageId: v.optional(v.id("_storage")),
      rowCount: v.number(),
      byteSize: v.number(),
      /** Hit `EXPORT_MAX_ROWS`. Every surface showing this file MUST say so —
       *  a silently short spreadsheet is worse than a failed export. */
      truncated: v.boolean(),
    }),
  ),

  /** Runner cursor. `chunkStorageIds` holds the partial blobs of the dataset
   *  currently being written; it is emptied each time a dataset is assembled
   *  into its final file. */
  progress: v.optional(
    v.object({
      datasetIndex: v.number(),
      cursor: v.optional(v.string()),
      rowsWritten: v.number(),
      chunkStorageIds: v.array(v.id("_storage")),
    }),
  ),

  totalRows: v.number(),

  createdAt: v.number(),
  startedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
  /** When the sweep may purge the bytes. Absent until the job is `ready`. */
  expiresAt: v.optional(v.number()),

  /** Download telemetry — part of the audit answer ("was it actually taken?"). */
  downloadCount: v.number(),
  lastDownloadedAt: v.optional(v.number()),
})
  .index("by_scope_and_created", ["scope", "createdAt"])
  .index("by_requester", ["requestedByUserId"])
  .index("by_status", ["status"])
  /** Drives the expiry sweep: oldest live job first. */
  .index("by_status_and_expires", ["status", "expiresAt"]);
