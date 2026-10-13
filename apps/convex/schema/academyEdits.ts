import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * In-app Academy course edits — the layer `buildAcademyCatalog`
 * (`@events-os/shared`, `academy/catalog.ts`) lays over the code-defined
 * curriculum. One course is the unit of editing: its details, its lesson
 * order, and the lessons it changed or created, all in one `CourseEdit`.
 *
 * Three tables, split so the hot read stays small:
 *  - `academyCourseEdits` — what learners see. Read by EVERY Academy query and
 *    the quiz grader, so it holds only the published edit, one row per course
 *    that has ever been changed in the app.
 *  - `academyCourseDrafts` — the editors' work in progress. One shared draft
 *    per course; only the editor screens read it.
 *  - `academyCourseVersions` — every publish, append-only, so any version
 *    (including "built-in") can be restored.
 *
 * Org-wide, not per chapter: there is one Academy.
 */

const inlineText = v.string();

const blockValidator = v.union(
  v.object({ kind: v.literal("p"), text: inlineText }),
  v.object({ kind: v.literal("heading"), text: inlineText }),
  v.object({ kind: v.literal("bullets"), items: v.array(inlineText) }),
  v.object({ kind: v.literal("story"), title: v.string(), text: inlineText }),
  v.object({ kind: v.literal("rule"), title: v.string(), text: inlineText }),
  v.object({
    kind: v.literal("table"),
    headers: v.array(v.string()),
    rows: v.array(v.array(v.string())),
  }),
  v.object({ kind: v.literal("tip"), text: inlineText }),
  v.object({
    kind: v.literal("link"),
    label: v.string(),
    url: v.string(),
    note: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal("tree"),
    caption: v.optional(v.string()),
    nodes: v.array(
      v.object({
        label: v.string(),
        depth: v.number(),
        highlight: v.optional(
          v.union(v.literal("self"), v.literal("manager"), v.literal("reports")),
        ),
      }),
    ),
  }),
  v.object({
    kind: v.literal("try_status"),
    title: v.string(),
    options: v.array(
      v.object({ value: v.string(), label: v.string(), color: v.string() }),
    ),
    terminal: v.string(),
    caption: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal("try_offset"),
    eventDateLabel: v.optional(v.string()),
  }),
  v.object({ kind: v.literal("try_chain") }),
  v.object({ kind: v.literal("try_ready"), criteria: v.array(v.string()) }),
  v.object({ kind: v.literal("reveal"), prompt: v.string(), answer: v.string() }),
  v.object({
    kind: v.literal("scenario"),
    prompt: v.string(),
    options: v.array(
      v.object({
        text: v.string(),
        correct: v.optional(v.boolean()),
        feedback: v.string(),
      }),
    ),
  }),
  v.object({
    kind: v.literal("agent_demo"),
    exchanges: v.array(
      v.object({
        who: v.union(v.literal("you"), v.literal("agent")),
        text: v.string(),
      }),
    ),
  }),
);

const questionValidator = v.object({
  prompt: v.string(),
  options: v.array(v.string()),
  answerIndex: v.number(),
  explanation: v.string(),
});

export const editedSectionValidator = v.object({
  slug: v.string(),
  title: v.string(),
  subtitle: v.string(),
  minutes: v.number(),
  blocks: v.array(blockValidator),
  quiz: v.array(questionValidator),
  optional: v.optional(v.boolean()),
  baseFingerprint: v.optional(v.string()),
});

export const courseEditValidator = v.object({
  course: v.object({
    title: v.string(),
    description: v.string(),
    level: v.union(
      v.literal("beginner"),
      v.literal("intermediate"),
      v.literal("advanced"),
      v.literal("leader"),
    ),
    themeKey: v.union(
      v.literal("foundations"),
      v.literal("events"),
      v.literal("works"),
      v.literal("management"),
      v.literal("finances"),
      v.literal("music"),
      v.literal("marketing"),
      v.literal("development"),
    ),
    audience: v.union(v.literal("role"), v.literal("ownership"), v.literal("team")),
    icon: v.string(),
  }),
  moduleSlugs: v.array(v.string()),
  removedSlugs: v.array(v.string()),
  sections: v.array(editedSectionValidator),
});

/** What learners see: the published edit of one course. */
export const academyCourseEdits = defineTable({
  courseSlug: v.string(),
  edit: courseEditValidator,
  // The `academyCourseVersions.version` this row came from.
  version: v.number(),
  publishedAt: v.number(),
  publishedBy: v.id("users"),
}).index("by_course", ["courseSlug"]);

/** The editors' shared draft of one course. `edit: null` is a draft that,
 *  when published, puts the course back to its built-in version. */
export const academyCourseDrafts = defineTable({
  courseSlug: v.string(),
  edit: v.union(courseEditValidator, v.null()),
  // The published version this draft started from (0 = built-in). Publishing
  // refuses a draft whose base someone else has published over since.
  basedOnVersion: v.number(),
  updatedAt: v.number(),
  updatedBy: v.id("users"),
  updatedByName: v.string(),
}).index("by_course", ["courseSlug"]);

/** Every publish of a course, append-only. `edit: null` records a reset to
 *  the built-in version. */
export const academyCourseVersions = defineTable({
  courseSlug: v.string(),
  version: v.number(),
  edit: v.union(courseEditValidator, v.null()),
  summary: v.array(v.string()),
  publishedAt: v.number(),
  publishedBy: v.id("users"),
  publishedByName: v.string(),
}).index("by_course_and_version", ["courseSlug", "version"]);
