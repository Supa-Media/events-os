import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { runReawardCourseCompletions } from "./0028_reaward_course_completions";

/**
 * Re-award `courseCompletions` after `foundations-data-export` ("Taking data
 * out of the app") was deleted from the `how-we-work` course (2026-09-01).
 *
 * The course shrinks from six required modules to five, so anyone who had
 * passed the other five but never the export lesson newly qualifies for the
 * `how-we-work` badge the moment it disappears. Badges are awarded inline by
 * `submitQuiz`/`syncCapstone` when the LAST required module passes — an event
 * that has already gone by for these people — so without this pass they'd
 * carry a permanently unearned badge for a course they have in fact finished.
 *
 * Exactly migration 0028's situation and exactly its body: `awardAllCourses`
 * re-reads each person's progress against the CURRENT catalog and inserts
 * only the badges they've earned but don't hold. That makes this a no-op for
 * everyone who already holds `how-we-work` (completion rows are durable and
 * never revoked — a reshape can only ADD eligibility), and idempotent on a
 * second run.
 *
 * The stale `academyProgress` rows for the deleted slug are deliberately left
 * alone: every read path looks sections up BY SLUG out of `ACADEMY_SECTIONS`,
 * so a row whose slug is no longer in the catalog is never read. Deleting
 * them would only discard the record that someone once did the reading, at
 * the cost of a destructive pass over the table.
 */
export async function runReawardAfterDataExportRemoval(ctx: MutationCtx) {
  return await runReawardCourseCompletions(ctx);
}

export const reawardAfterDataExportRemoval: Migration = {
  name: "0086_reaward_after_data_export_removal",
  run: runReawardAfterDataExportRemoval,
};
