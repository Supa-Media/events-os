import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { awardAllCourses } from "../academy";

/**
 * Backfill `courseCompletions` from existing `academyProgress`.
 *
 * The Academy redesign (D4) grouped the flat curriculum into courses and made
 * completion an earned badge row. Anyone who had already passed every REQUIRED
 * module of a course (before the badge existed) must get their badge — so this
 * walks the roster and awards each person every course they've completed.
 *
 * `awardAllCourses` is the exact same logic the live write paths
 * (submitQuiz / syncCapstone) use, so a backfilled badge and a freshly-earned
 * one are identical. It reads a person's progress once, checks all courses,
 * and inserts only the missing badges — including the capstone live-derivation
 * fallback, so a learner who finished a sandbox before `syncCapstone` ever ran
 * is still credited. Module slug === section slug, so no progress re-key is
 * needed; the course a module belongs to is derived from the shared catalog.
 *
 * Idempotent: `awardAllCourses` skips any (person, course) badge that already
 * exists, so a second run inserts nothing.
 */
export async function runBackfillCourseCompletions(ctx: MutationCtx) {
  let awarded = 0;
  for (const person of await ctx.db.query("people").collect()) {
    awarded += await awardAllCourses(ctx, person.chapterId, person._id);
  }
  return { awarded };
}

export const backfillCourseCompletions: Migration = {
  name: "0018_backfill_course_completions",
  run: runBackfillCourseCompletions,
};
