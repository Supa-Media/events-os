import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * The `campaigns.design` rung (2026-07-28) — mirrors
 * `0036_add_campaign_power_defaults.ts` exactly, for the same reason:
 * campaigns access is seat-capability-derived
 * (`apps/convex/lib/campaignsAccess.ts` off a seat def's `capabilities`
 * array), so making a NEW capability live on an already-seeded org's
 * `seatDefs` rows is a data change, not an enforcement one. Without this, the
 * template change in `packages/shared/src/seats.ts` only reaches BRAND-NEW
 * orgs and the Graphic Designer stays locked out of the Campaigns desk in
 * every existing deployment — which is the entire bug.
 *
 * Two distinct cases, deliberately handled differently:
 *
 *  1. `graphic_designer` / `social_media_manager` — the seats the fix is FOR.
 *     They carried no campaign capability at all, and the org chart's power
 *     control had no "Design" option to set, so there is no runtime state to
 *     preserve: a row with no campaign capability here has never been an
 *     intentional revocation. Grant `campaigns.design`.
 *
 *  2. Any row that ALREADY carries `campaigns.compose` or `campaigns.approve`
 *     — design is implied by both (`CAMPAIGN_CAPABILITY_SATISFIERS`), so
 *     appending it changes NO access whatsoever. It's written anyway so the
 *     stored row is self-describing and matches what
 *     `setSeatCampaignPower` now writes, keeping the org chart's "Powers"
 *     chips honest.
 *
 * Everything else is left alone — crucially, an ED/FM/Marketing Director row
 * that an ED deliberately set to `none` at runtime has NO campaign capability
 * and is NOT in case 1, so this migration will never quietly re-open the desk
 * for a seat someone closed. That's the one way it's stricter than `0036`,
 * whose additive-only shape couldn't distinguish "never had it" from
 * "was demoted from it".
 *
 * Idempotent: a row already carrying `campaigns.design` is skipped, so a
 * re-run touches nothing.
 */

/** Seats that get `campaigns.design` even with no campaign capability today
 *  — the two marketing seats the rung was introduced for. */
const DESIGN_DEFAULT_SLUGS = new Set(["graphic_designer", "social_media_manager"]);

/** Bounded scan of the seat chart — the template ships 27 rows; 300 matches
 *  `seats.ts#MAX_CHART_SEATS`, well above any real chart. */
const SEAT_DEF_SCAN_LIMIT = 300;

export async function runAddCampaignDesignDefaults(ctx: MutationCtx) {
  let patched = 0;
  let skipped = 0;

  const rows = await ctx.db.query("seatDefs").take(SEAT_DEF_SCAN_LIMIT);

  for (const row of rows) {
    if (row.capabilities.includes("campaigns.design")) {
      skipped++;
      continue;
    }
    const impliedByStrongerRung =
      row.capabilities.includes("campaigns.compose") ||
      row.capabilities.includes("campaigns.approve");
    if (!impliedByStrongerRung && !DESIGN_DEFAULT_SLUGS.has(row.slug)) {
      skipped++;
      continue;
    }
    await ctx.db.patch(row._id, {
      capabilities: [...row.capabilities, "campaigns.design"],
      updatedAt: Date.now(),
    });
    patched++;
  }

  return { patched, skipped };
}

export const addCampaignDesignDefaults: Migration = {
  name: "0053_add_campaign_design_defaults",
  run: runAddCampaignDesignDefaults,
};
