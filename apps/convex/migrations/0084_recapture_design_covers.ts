import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { internal } from "../_generated/api";

/**
 * Run cover capture again, now that it can actually reach Canva.
 *
 * 0083 scheduled the first capture pass — and in production that pass FAILED
 * for the founder's own design, for two reasons the tests' stubbed fetch could
 * never surface: the stored link was the /edit URL (never served anonymously;
 * only the embed rewrite was normalizing it), and the pipeline announced
 * itself with a bot UA that Canva's WAF refuses. Both are fixed in
 * `lib/ogImage.ts` / `captureCover`, but 0083's ledger entry is spent, so the
 * rows it failed on need this second pass.
 *
 * Identical body to 0083, same `onlyIfBare` safety: a cover that exists —
 * captured, or hand-uploaded — is never touched, so re-running is harmless,
 * and a page that still refuses just leaves its tile as it was.
 */
export const recaptureDesignCovers: Migration = {
  name: "0084_recapture_design_covers",
  run: async (ctx: MutationCtx) => {
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
