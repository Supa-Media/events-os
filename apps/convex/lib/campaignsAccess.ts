/**
 * Access gate for the email-campaigns surface (`audiences.ts`, `campaigns.ts`)
 * — CENTRAL-only, same criterion `smsUsage.ts#getSmsSpendSummary` uses for its
 * superuser-only Integrations panel: a superuser, or a central Executive
 * Director / Financial Manager (`lib/finance.ts#isCentralEdOrFm`, which
 * already short-circuits true for a superuser — the explicit
 * `isSuperuser` OR here mirrors `getSmsSpendSummary`'s belt-and-suspenders
 * style rather than relying on that internal short-circuit alone).
 */
import { ConvexError } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import { isCentralEdOrFm } from "./finance";
import { isSuperuser } from "./superuser";

export async function hasCampaignsAccess(ctx: QueryCtx): Promise<boolean> {
  return (await isCentralEdOrFm(ctx)) || (await isSuperuser(ctx));
}

/** The throwing gate for every campaigns/audiences read+write. Use
 *  `hasCampaignsAccess` directly (soft, non-throwing) for a passive
 *  visibility check like `myCampaignsAccess`. */
export async function requireCampaignsAccess(ctx: QueryCtx): Promise<void> {
  if (!(await hasCampaignsAccess(ctx))) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message:
        "Email campaigns are available to the Executive Director / Financial Manager only.",
    });
  }
}
