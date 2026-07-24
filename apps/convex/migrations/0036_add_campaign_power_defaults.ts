import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Two-party campaign approval (founder requirement, 2026-07-24) — mirrors
 * `0033_add_giving_power_defaults.ts` exactly, for the same reason: campaign
 * compose/approve access is already seat-capability-derived
 * (`apps/convex/lib/campaignsAccess.ts` off a seat def's `capabilities`
 * array), so making the two new capabilities live on an already-seeded org's
 * `seatDefs` rows is a data change, not an enforcement one. The TEMPLATE
 * (`packages/shared/src/seats.ts`) already carries `campaigns.approve` +
 * `campaigns.compose` on `executive_director`/`financial_manager` and both
 * (approve implies compose) on `marketing_director` — this migration patches
 * the LIVE rows `0022_seed_seat_defs` already stamped, so an org seeded
 * BEFORE this PR picks up the same default access a brand-new org gets
 * automatically from the template.
 *
 * ADDITIVE-ONLY, same two reasons `0033` documents (no wholesale template
 * re-sync path exists in this codebase; this migration only ever APPENDS
 * the missing capability to a row that lacks it, never removes one) — so a
 * runtime edit via `seats.ts#setSeatCampaignPower` (e.g. the ED turning a
 * seat's campaign power to "none") is never clobbered by a later re-run.
 */
const TARGET_SLUGS = ["executive_director", "financial_manager", "marketing_director"] as const;

export async function runAddCampaignPowerDefaults(ctx: MutationCtx) {
  let patched = 0;
  let skipped = 0;

  for (const slug of TARGET_SLUGS) {
    const rows = await ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .collect();

    for (const row of rows) {
      // Additive + content-idempotent — same shape as `0033`: only touch a
      // row still missing the default full power (`campaigns.approve`,
      // which already implies `campaigns.compose` — see `SEAT_DEFS`). A row
      // already carrying it (the default, or a runtime edit that already
      // granted it) is left exactly as-is, never rewritten, never
      // downgraded.
      if (row.capabilities.includes("campaigns.approve")) {
        skipped++;
        continue;
      }
      const next = [...row.capabilities, "campaigns.approve", "campaigns.compose"] as const;
      await ctx.db.patch(row._id, {
        capabilities: [...next],
        updatedAt: Date.now(),
      });
      patched++;
    }
  }

  return { patched, skipped };
}

export const addCampaignPowerDefaults: Migration = {
  name: "0036_add_campaign_power_defaults",
  run: runAddCampaignPowerDefaults,
};
