import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { runReawardCourseCompletions } from "./0028_reaward_course_completions";

/**
 * Re-award `courseCompletions` after `finance-transfers-and-payouts` was
 * deleted from the `treasurer` course (2026-09-01).
 *
 * Same situation as 0086 one deploy earlier, and as 0028 before it: the
 * course shrinks from four required modules to three, so anyone who had
 * passed the other three newly qualifies for the `treasurer` badge. Badges
 * are awarded inline by `submitQuiz`/`syncCapstone` when the LAST required
 * module passes — an event that has already gone by for these people — so
 * without this pass they would carry a permanently unearned badge for a
 * course they have in fact finished.
 *
 * `awardAllCourses` re-reads each person's progress against the CURRENT
 * catalog and inserts only the badges they have earned but do not hold, so
 * this is a no-op for existing `treasurer` holders (completion rows are
 * durable and never revoked — a reshape can only ADD eligibility) and
 * idempotent on a second run.
 *
 * Stale `academyProgress` rows for the deleted slug are left alone, for the
 * reason spelled out in 0086: every read path looks sections up by slug out
 * of `ACADEMY_SECTIONS`, so a row whose slug is no longer in the catalog is
 * never read, and deleting them would only discard the record that someone
 * once did the reading.
 */
export async function runReawardAfterTransfersRemoval(ctx: MutationCtx) {
  return await runReawardCourseCompletions(ctx);
}

export const reawardAfterTransfersRemoval: Migration = {
  name: "0087_reaward_after_transfers_removal",
  run: runReawardAfterTransfersRemoval,
};
