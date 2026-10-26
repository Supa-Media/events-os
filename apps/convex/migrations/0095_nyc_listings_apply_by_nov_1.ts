import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { listingRegions, roleAcceptsApplications } from "@events-os/shared";

/** The deadline the founder set for the NYC seats (2026-10-26). */
const NYC_APPLY_BY = "2026-11-01";

/**
 * Put an "Apply by Nov 1" deadline on the NYC seats (2026-10-26).
 *
 * The founder asked that the NYC roles show a Nov 1 deadline so people know
 * there isn't much time. Display only: nothing closes on the day. An NYC seat
 * is one whose location line puts it in NYC alone (`listingRegions` is just
 * `nyc`), so remote seats that show under both cities are left alone. Only
 * seats taking applications get it, and a seat the desk already gave a date
 * keeps its own.
 *
 * Idempotent by content: a second run finds every NYC seat already dated.
 */
export async function runNycListingsApplyBy(ctx: MutationCtx) {
  const listings = await ctx.db.query("jobListings").take(500);
  let changed = 0;
  for (const listing of listings) {
    if (listing.applyBy || !roleAcceptsApplications(listing.status)) continue;
    const regions = listingRegions(listing.location);
    if (regions.length !== 1 || regions[0] !== "nyc") continue;
    await ctx.db.patch(listing._id, { applyBy: NYC_APPLY_BY });
    changed += 1;
  }
  return { changed };
}

export const nycListingsApplyBy: Migration = {
  name: "0095_nyc_listings_apply_by_nov_1",
  run: runNycListingsApplyBy,
};
