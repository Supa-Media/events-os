/**
 * Reading the fee schedule — the one way anything asks "what does this rail
 * cost?".
 *
 * Two layers, and the order matters: the typed defaults in
 * `@events-os/shared#DEFAULT_FEE_SCHEDULE` say which rails EXIST and what they
 * charge; a `processorFeeSchedule` row overrides the rate of a rail that
 * already exists. A stored row for an unknown rail is ignored, so no database
 * edit can make the giving page quote a price for something the code cannot
 * charge — and no missing row can leave a rail with no price at all.
 *
 * Every caller goes through `resolveFeeSchedule` / `resolveFeeRate` rather than
 * reading the table. That is what makes "the rate is written down once" true in
 * practice rather than only in intent.
 */
import {
  DEFAULT_FEE_SCHEDULE,
  defaultFeeRate,
  feeRateProblems,
  type FeeMethod,
  type FeeProcessor,
  type FeeRail,
  type FeeRate,
} from "@events-os/shared";
import type { QueryCtx } from "../_generated/server";

/**
 * Every rail, at the rate that applies right now — the published default
 * unless a stored row overrides it.
 *
 * ONE READ of a table with at most a handful of rows, so callers that need
 * several rails (the giving page needs card AND ACH to show the comparison)
 * pay for one query rather than one per rail.
 *
 * A stored row that fails `feeRateProblems` is DISCARDED, not thrown on. This
 * is read on the public giving page: a nonsense row must degrade to the
 * published rate, not take giving offline. The write path already refuses such
 * a row, so reaching this branch means something wrote around the mutation.
 */
export async function resolveFeeSchedule(ctx: QueryCtx): Promise<FeeRail[]> {
  const stored = await ctx.db.query("processorFeeSchedule").take(100);
  const byRail = new Map(stored.map((r) => [`${r.processor}:${r.method}`, r]));

  return DEFAULT_FEE_SCHEDULE.map((rail) => {
    const row = byRail.get(`${rail.processor}:${rail.method}`);
    if (!row) return { ...rail };
    const override: FeeRate = {
      percentBps: row.percentBps,
      fixedCents: row.fixedCents,
      ...(row.capCents != null ? { capCents: row.capCents } : {}),
    };
    if (feeRateProblems(override).length > 0) {
      console.error(
        `[feeSchedule] stored rate for ${rail.processor}:${rail.method} is not usable — ` +
          `falling back to the published rate`,
      );
      return { ...rail };
    }
    return { processor: rail.processor, method: rail.method, ...override };
  });
}

/** One rail's current rate. `null` for a rail this codebase doesn't have. */
export async function resolveFeeRate(
  ctx: QueryCtx,
  processor: FeeProcessor,
  method: FeeMethod,
): Promise<FeeRate | null> {
  if (defaultFeeRate(processor, method) == null) return null;
  const schedule = await resolveFeeSchedule(ctx);
  const rail = schedule.find(
    (r) => r.processor === processor && r.method === method,
  );
  if (!rail) return null;
  const { percentBps, fixedCents, capCents } = rail;
  return capCents == null
    ? { percentBps, fixedCents }
    : { percentBps, fixedCents, capCents };
}
