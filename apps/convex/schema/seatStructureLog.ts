import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Org-chart STRUCTURE audit log — one row per `seatStructure.ts` mutation
 * (addSeat / renameSeat / updateSeat / reparentSeat / removeSeat). Distinct
 * from `seatAssignments` (WHO sits in a seat): this logs edits to the SHAPE
 * of the chart itself — new/renamed/reparented/removed seats, and duties/
 * maxHolders/capabilities changes — gated by the `org.editChart` power (see
 * `lib/seatStructure.ts`'s `requireChartEditor`).
 *
 * `before`/`after` are small snapshots of only the fields THAT mutation
 * touched (never the full row) — mirrors `aiChanges`' generic revert-log
 * shape (`schema/ai.ts`), though this log is read-only (no undo yet).
 */
export const seatStructureLog = defineTable({
  editorUserId: v.id("users"),
  // The roster row that earned the caller edit access (holds the qualifying
  // seat, or just the caller's first roster row for a superuser backstop
  // edit) — absent only if the editor has no roster row at all.
  editorPersonId: v.optional(v.id("people")),
  mutation: v.union(
    v.literal("addSeat"),
    v.literal("renameSeat"),
    v.literal("updateSeat"),
    v.literal("reparentSeat"),
    v.literal("removeSeat"),
  ),
  slug: v.string(),
  before: v.optional(v.any()),
  after: v.optional(v.any()),
  createdAt: v.number(),
}).index("by_createdAt", ["createdAt"]);
