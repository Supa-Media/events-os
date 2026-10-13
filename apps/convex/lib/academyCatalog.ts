/**
 * The Academy as learners see it right now: the code-defined curriculum with
 * every published in-app course edit laid over it (`buildAcademyCatalog` in
 * `@events-os/shared`). Every Academy read and the quiz grader go through
 * `loadAcademyCatalog`, so the server always grades against the version the
 * learner was shown — the client builds its copy from the same rows
 * (`academy.publishedCourseEdits`).
 *
 * The read is one indexed scan of `academyCourseEdits`, bounded by the number
 * of courses (one row per course ever edited in the app).
 */
import {
  ACADEMY_COURSES,
  BUILT_IN_ACADEMY_CATALOG,
  buildAcademyCatalog,
  type AcademyCatalog,
  type PublishedCourseEdit,
} from "@events-os/shared";
import type { QueryCtx } from "../_generated/server";

/** Every published course edit. */
export async function publishedCourseEdits(
  ctx: QueryCtx,
): Promise<PublishedCourseEdit[]> {
  const rows = await ctx.db
    .query("academyCourseEdits")
    .take(ACADEMY_COURSES.length + 1);
  return rows.map((r) => ({
    courseSlug: r.courseSlug,
    edit: r.edit,
    publishedAt: r.publishedAt,
  }));
}

/** The live catalog. Cheap when nothing has been edited. */
export async function loadAcademyCatalog(ctx: QueryCtx): Promise<AcademyCatalog> {
  const edits = await publishedCourseEdits(ctx);
  return edits.length === 0 ? BUILT_IN_ACADEMY_CATALOG : buildAcademyCatalog(edits);
}
