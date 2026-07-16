/**
 * Deployment-wide housekeeping that doesn't belong to any one feature file.
 *
 * Today: TTL sweep for the rate-limit "attempt" tables (`reimbursements.ts`
 * §submit rate limit / #134, `cards.ts` §revealCardDetails rate limit / #161).
 * Both only ever INSERT a timestamped row per attempt and never delete —
 * left alone they'd grow forever. Both windows are 1 hour (see
 * SUBMIT_RATE_LIMIT_WINDOW_MS / CARD_DETAILS_REVEAL_WINDOW_MS), so sweeping
 * once a day comfortably keeps the tables bounded to a day's worth of
 * attempts. Bounded per run via `by_time`; the backlog drains across days if
 * the table is ever unusually large (mirrors `purgeExpiredTokens`).
 */
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";

const RATE_LIMIT_ATTEMPT_WINDOW_MS = 60 * 60 * 1000; // 1 hour — both tables
const SWEEP_BATCH_SIZE = 500;

async function sweepOldAttempts(
  ctx: MutationCtx,
  table: "reimbursementSubmitAttempts" | "cardDetailsRevealAttempts",
): Promise<number> {
  const cutoff = Date.now() - RATE_LIMIT_ATTEMPT_WINDOW_MS;
  const stale = await ctx.db
    .query(table)
    .withIndex("by_time", (q) => q.lt("createdAt", cutoff))
    .take(SWEEP_BATCH_SIZE);
  for (const row of stale) await ctx.db.delete(row._id);
  return stale.length;
}

export const sweepRateLimitAttempts = internalMutation({
  args: {},
  handler: async (ctx) => {
    const reimbursementAttempts = await sweepOldAttempts(
      ctx,
      "reimbursementSubmitAttempts",
    );
    const cardRevealAttempts = await sweepOldAttempts(
      ctx,
      "cardDetailsRevealAttempts",
    );
    return { reimbursementAttempts, cardRevealAttempts };
  },
});
