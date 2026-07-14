import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Academy progress — one row per (person, curriculum section).
 *
 * The curriculum itself (sections, bodies, quizzes) is code, not data
 * (ACADEMY_SECTIONS in @events-os/shared); this table stores only the
 * per-person state the hub renders: when the article was read, the best quiz
 * score across retakes, and when the quiz was passed (all answers correct).
 * Each capstone section's row is stamped by `academy.syncCapstone` once its
 * training event's quest rows are all terminal (server-verified), so the pass
 * SURVIVES the training event being completed or deleted; reads additionally
 * fall back to live quest derivation for events stamped before syncing.
 */
export const academyProgress = defineTable({
  chapterId: v.id("chapters"),
  personId: v.id("people"),
  // A slug from ACADEMY_SECTIONS — validated at the mutation boundary.
  sectionSlug: v.string(),
  // First time the article was opened.
  readAt: v.optional(v.number()),
  // Best score across quiz attempts (retakes allowed, best kept).
  quizBestScore: v.optional(v.number()),
  // Question count at the time of the best attempt (denominator for display).
  quizTotal: v.optional(v.number()),
  // Set the first time an attempt scores perfect (or, for the capstone, when
  // syncCapstone verifies every quest terminal). Never cleared by retakes.
  passedAt: v.optional(v.number()),
})
  // A person's rows within their chapter (myProgress; markRead/submitQuiz
  // upsert by scanning these ≤ ACADEMY_SECTION_COUNT rows for the slug).
  .index("by_chapter_and_person", ["chapterId", "personId"])
  // The whole chapter's rows (chapterProgress — "who's trained").
  .index("by_chapter", ["chapterId"]);

/**
 * Course completion — the earned BADGE (one row per person per completed
 * course). Stored, not computed: a credential should survive the code-defined
 * catalog (ACADEMY_COURSES in @events-os/shared) being restructured, so the
 * "who completed this course" and profile-badge surfaces read a durable row
 * rather than re-deriving from per-module progress each time.
 *
 * Awarded the moment a course's last REQUIRED module passes (in submitQuiz /
 * syncCapstone), and backfilled for existing progress by migration 0018. A
 * course's required set excludes `optional` modules, so the bonus worship
 * capstone never gates the Owning-an-event badge. `courseSlug` is a slug from
 * ACADEMY_COURSES; the course a module belongs to is derived from the catalog,
 * not stored on the progress row (module slug === section slug already keys it).
 */
export const courseCompletions = defineTable({
  chapterId: v.id("chapters"),
  personId: v.id("people"),
  // A slug from ACADEMY_COURSES.
  courseSlug: v.string(),
  // When the last required module passed (max of the modules' passedAt).
  earnedAt: v.number(),
})
  // A person's earned badges (profile chips) + the per-(person,course) dedupe
  // the award/backfill paths check before inserting.
  .index("by_chapter_and_person", ["chapterId", "personId"])
  // Everyone who completed a given course (the course page's completer list).
  .index("by_chapter_and_course", ["chapterId", "courseSlug"]);
