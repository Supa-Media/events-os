import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { awardAllCourses } from "../academy";

/**
 * Re-award `courseCompletions` after the `chapter-money-model` reshape (the
 * shared core course that pulled `finance-tiers-and-skim` out of the Chapter
 * Director course): people who'd already passed both of the Chapter
 * Director's REMAINING modules (`finance-raise-vs-manage`,
 * `finance-approving-budgets`) but not `finance-tiers-and-skim` newly
 * qualify for the `chapter-director` badge the moment the course shrinks to
 * just those two.
 *
 * Same exact machinery as migration 0018's original backfill —
 * `awardAllCourses` reads a person's progress once and inserts only the
 * badges the CURRENT catalog says they've earned but don't yet hold. That
 * makes this both:
 *  - a no-op for anyone who already holds `chapter-director` (courseCompletions
 *    rows are durable and never deleted/revoked by anything in this codebase —
 *    a reshape can only ADD eligibility, never take away an earned badge), and
 *  - the exact backfill a NEWLY-shrunk course needs, with zero bespoke logic.
 *
 * Nobody can hold the new `chapter-money-model` badge yet — its two brand-new
 * sections (`finance-budget-lifecycle`, `finance-one-home-per-dollar`) have
 * no `academyProgress` rows for anyone until they're actually read and
 * quizzed — `courseEarnedAt` gates on ALL required modules passing, so this
 * runs harmlessly for that course too (nothing to award until real progress
 * exists).
 *
 * Idempotent: `awardAllCourses` skips any (person, course) badge that already
 * exists, so a second run inserts nothing.
 */
export async function runReawardCourseCompletions(ctx: MutationCtx) {
  let awarded = 0;
  for (const person of await ctx.db.query("people").collect()) {
    awarded += await awardAllCourses(ctx, person.chapterId, person._id);
  }
  return { awarded };
}

export const reawardCourseCompletions: Migration = {
  name: "0028_reaward_course_completions",
  run: runReawardCourseCompletions,
};
