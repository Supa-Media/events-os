import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Backfill the territories launch pot (docs/plans/giving-territories.md §D3).
 *
 * The pot (`territories.launchFundCents`) + its gift-level flag
 * (`gifts.countedInLaunchFund`) shipped unwired — this stamps both from the
 * existing gift history. For every territory still `prospect`/`raising` (a
 * launched territory's pot is FROZEN — untouched here), it:
 *
 *  1. reads that territory's chapter-scope gifts (bounded `gifts.by_scope`),
 *  2. stamps `countedInLaunchFund: true` on each (100% pre-launch accrual),
 *  3. sets `launchFundCents` to their exact sum.
 *
 * RECOMPUTE-STYLE (not incremental), so it's idempotent: a re-run re-derives
 * the pot from the same gift sum and re-asserts the same flags — never doubles
 * the pot. Launched territories are skipped entirely, preserving the freeze.
 */

/** Bounded reads — the territory + per-chapter gift sets are tiny at this
 *  stage (pre-launch chapters have at most a handful of backers). */
const SCAN_LIMIT = 10000;

export async function runBackfillLaunchFund(ctx: MutationCtx) {
  const result = {
    territoriesProcessed: 0,
    giftsStamped: 0,
    totalPotCents: 0,
  };

  const prelaunch: Doc<"territories">[] = [];
  for (const stage of ["prospect", "raising"] as const) {
    const rows = await ctx.db
      .query("territories")
      .withIndex("by_stage", (q) => q.eq("stage", stage))
      .take(SCAN_LIMIT);
    prelaunch.push(...rows);
  }

  for (const territory of prelaunch) {
    const chapterId = territory.chapterId as Id<"chapters">;
    const gifts = await ctx.db
      .query("gifts")
      .withIndex("by_scope", (q) => q.eq("scope", chapterId))
      .take(SCAN_LIMIT);

    let sum = 0;
    for (const gift of gifts) {
      sum += gift.amountCents;
      if (gift.countedInLaunchFund !== true) {
        await ctx.db.patch(gift._id, { countedInLaunchFund: true });
        result.giftsStamped++;
      }
    }

    if (territory.launchFundCents !== sum) {
      await ctx.db.patch(territory._id, {
        launchFundCents: sum,
        updatedAt: Date.now(),
      });
    }
    result.territoriesProcessed++;
    result.totalPotCents += sum;
  }

  return result;
}

export const backfillLaunchFund: Migration = {
  name: "0030_backfill_launch_fund",
  run: runBackfillLaunchFund,
};
