import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Delete site-map placements whose referenced source row is gone.
 *
 * `siteMapPlacements.refId` is an untyped `v.string()` with no referential
 * integrity, so before the delete-cascades were added to the four source-row
 * delete mutations (items.removeEventItem / removeTemplateItem, engagements.remove,
 * templatePeople.remove) a deleted supply / engagement / template row could leave
 * a dangling chip. This sweeps existing orphans: for each placement, resolve its
 * target by scope (`eventId` → live rows, `eventTypeId` → template rows) and
 * delete the placement when the target no longer exists.
 *
 * The `refId` string carries its own table, so `ctx.db.get` resolves the right
 * document regardless of the TS id type we cast to — we only test existence.
 *
 * Idempotent: a second run finds no orphans. The placements table is small
 * (chips on maps), so a single-transaction `.collect()` sweep is safe.
 */
export async function runCleanupOrphanedPlacements(ctx: MutationCtx) {
  let deleted = 0;
  const placements = await ctx.db.query("siteMapPlacements").collect();
  for (const p of placements) {
    // The refId's embedded table drives resolution; the cast is cosmetic.
    const target = await ctx.db.get(p.refId as Id<"eventItems">);
    if (!target) {
      await ctx.db.delete(p._id);
      deleted++;
    }
  }
  return { deleted };
}

export const cleanupOrphanedPlacements: Migration = {
  name: "0008_cleanup_orphaned_placements",
  run: runCleanupOrphanedPlacements,
};
