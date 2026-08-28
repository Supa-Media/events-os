import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { internal } from "../_generated/api";

/**
 * Give every linked design that predates cover capture its real tile picture.
 *
 * Cover capture (see `marketingDesigns.ts`'s covers section) runs when a
 * design is SAVED — so a design already sitting in production keeps its
 * typographic placeholder until somebody happens to edit it or press Refresh.
 * The founder's own "PW Flyer" is exactly that row. Same registry lesson as
 * 0081, in scheduling form: a behavior added to the write path reaches only
 * future writes, and existing rows need a migration to catch up.
 *
 * This schedules the SAME `captureCover` the save path schedules, with the
 * same `onlyIfBare: true` — so a design whose cover a human already uploaded
 * is untouched, by the same atomic guard, and re-running this is harmless.
 * The fetches happen in scheduled actions after the deploy, not inside the
 * migration transaction; a page that offers no preview just leaves its tile
 * as it was.
 */
export const captureDesignCovers: Migration = {
  name: "0083_capture_design_covers",
  run: async (ctx: MutationCtx) => {
    // Bounded read, same cap as the library's own list. The library refuses
    // inserts past DESIGN_MAX_COUNT (200), so this take is the whole table.
    const designs = await ctx.db.query("designAssets").take(200);
    let scheduled = 0;
    for (const design of designs) {
      if (!design.url || design.thumbnailStorage !== undefined) continue;
      await ctx.scheduler.runAfter(0, internal.marketingDesigns.captureCover, {
        designId: design._id,
        onlyIfBare: true,
      });
      scheduled += 1;
    }
    return { scheduled };
  },
};
