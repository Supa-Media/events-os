/**
 * Deployment-wide housekeeping that doesn't belong to any one feature file.
 *
 * Today: TTL sweep for the rate-limit "attempt" tables (`reimbursements.ts`
 * §submit rate limit / #134, `cards.ts` §revealCardDetails rate limit / #161,
 * `cards.ts` §manual receipt-nudge rate limit). All three only ever INSERT a
 * timestamped row per attempt and never delete — left alone they'd grow
 * forever. The first two windows are 1 hour (see SUBMIT_RATE_LIMIT_WINDOW_MS /
 * CARD_DETAILS_REVEAL_WINDOW_MS); the manual-nudge window is 24h
 * (MANUAL_NUDGE_WINDOW_MS in cards.ts) since it caps a per-cardholder nudge to
 * once a day, so it's swept with its own (longer) cutoff rather than folded
 * into the shared 1-hour one. Sweeping once a day comfortably keeps every
 * table bounded to roughly a day's worth of attempts. Bounded per run via
 * `by_time`; the backlog drains across days if a table is ever unusually
 * large (mirrors `purgeExpiredTokens`).
 */
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";

const RATE_LIMIT_ATTEMPT_WINDOW_MS = 60 * 60 * 1000; // 1 hour — the two hourly tables
// Mirrors cards.ts's MANUAL_NUDGE_WINDOW_MS — kept as a literal here (rather
// than imported) so this file's own doc comment stays the single place that
// explains the sweep, matching how the two 1-hour tables are handled below.
const MANUAL_NUDGE_ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

async function sweepOldAttempts(
  ctx: MutationCtx,
  table:
    | "reimbursementSubmitAttempts"
    | "cardDetailsRevealAttempts"
    | "receiptNudgeAttempts",
  windowMs: number,
  batchSize = 500,
): Promise<number> {
  const cutoff = Date.now() - windowMs;
  const stale = await ctx.db
    .query(table)
    .withIndex("by_time", (q) => q.lt("createdAt", cutoff))
    .take(batchSize);
  for (const row of stale) await ctx.db.delete(row._id);
  return stale.length;
}

export const sweepRateLimitAttempts = internalMutation({
  args: {},
  handler: async (ctx) => {
    const reimbursementAttempts = await sweepOldAttempts(
      ctx,
      "reimbursementSubmitAttempts",
      RATE_LIMIT_ATTEMPT_WINDOW_MS,
    );
    const cardRevealAttempts = await sweepOldAttempts(
      ctx,
      "cardDetailsRevealAttempts",
      RATE_LIMIT_ATTEMPT_WINDOW_MS,
    );
    const receiptNudgeAttempts = await sweepOldAttempts(
      ctx,
      "receiptNudgeAttempts",
      MANUAL_NUDGE_ATTEMPT_WINDOW_MS,
    );
    return { reimbursementAttempts, cardRevealAttempts, receiptNudgeAttempts };
  },
});
