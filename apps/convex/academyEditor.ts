/**
 * The in-app Academy course editor's backend.
 *
 * One course is the unit of editing (`CourseEdit` in `@events-os/shared`):
 * editors share ONE draft per course, which autosaves as they type, and
 * Publish makes it what every learner sees. Every publish is kept in
 * `academyCourseVersions`, so any earlier version — or the built-in one from
 * code — can be restored into the draft and published again.
 *
 * Every function here is gated by `requireAcademyEditPower`
 * (`people.academy.edit`), except `canEditCourses`, which only answers the
 * question so the course page knows whether to show "Edit course".
 *
 * Publishing is the editor's own call: no second approver. That is the
 * founder's choice (2026-10-13), and it is safe because a publish never
 * touches anyone's progress — a pass already earned is kept — and the version
 * history makes every publish undoable.
 */
import { query, mutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import {
  builtInCourse,
  courseEditProblems,
  describeCourseEditChanges,
} from "@events-os/shared";
import { courseEditValidator } from "./schema/academyEdits";
import { requireUserId } from "./lib/context";
import { callerPersonIds } from "./lib/seatStructure";
import {
  hasAcademyEditPower,
  requireAcademyEditPower,
} from "./lib/academyContentAccess";
import { loadAcademyCatalog } from "./lib/academyCatalog";

/** How many past versions the editor lists. */
const HISTORY_LIMIT = 30;

function requireKnownCourse(courseSlug: string) {
  if (!builtInCourse(courseSlug)) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "That course doesn't exist.",
    });
  }
}

async function callerName(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<string> {
  const [personId] = await callerPersonIds(ctx, userId);
  const person = personId ? await ctx.db.get(personId) : null;
  return person?.name?.trim() || "Someone";
}

async function draftRow(ctx: QueryCtx | MutationCtx, courseSlug: string) {
  return await ctx.db
    .query("academyCourseDrafts")
    .withIndex("by_course", (q) => q.eq("courseSlug", courseSlug))
    .unique();
}

async function publishedRow(ctx: QueryCtx | MutationCtx, courseSlug: string) {
  return await ctx.db
    .query("academyCourseEdits")
    .withIndex("by_course", (q) => q.eq("courseSlug", courseSlug))
    .unique();
}

/** The newest version number of a course (0 = never published in the app). */
async function currentVersion(
  ctx: QueryCtx | MutationCtx,
  courseSlug: string,
): Promise<number> {
  const latest = await ctx.db
    .query("academyCourseVersions")
    .withIndex("by_course_and_version", (q) => q.eq("courseSlug", courseSlug))
    .order("desc")
    .first();
  return latest?.version ?? 0;
}

/** May the caller edit courses? Drives the "Edit course" button. */
export const canEditCourses = query({
  args: {},
  handler: async (ctx) => await hasAcademyEditPower(ctx),
});

/** Everything the editor screens need for one course. */
export const courseEditor = query({
  args: { courseSlug: v.string() },
  handler: async (ctx, { courseSlug }) => {
    await requireAcademyEditPower(ctx);
    requireKnownCourse(courseSlug);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const [published, draft, versionRows] = await Promise.all([
      publishedRow(ctx, courseSlug),
      draftRow(ctx, courseSlug),
      ctx.db
        .query("academyCourseVersions")
        .withIndex("by_course_and_version", (q) => q.eq("courseSlug", courseSlug))
        .order("desc")
        .take(HISTORY_LIMIT),
    ]);
    return {
      currentVersion: versionRows[0]?.version ?? 0,
      published: published
        ? { edit: published.edit, version: published.version }
        : null,
      draft: draft
        ? {
            edit: draft.edit,
            basedOnVersion: draft.basedOnVersion,
            updatedAt: draft.updatedAt,
            updatedByName: draft.updatedByName,
            updatedByMe: draft.updatedBy === userId,
          }
        : null,
      versions: versionRows.map((r) => ({
        version: r.version,
        publishedAt: r.publishedAt,
        publishedByName: r.publishedByName,
        summary: r.summary,
        isBuiltIn: r.edit === null,
      })),
    };
  },
});

/**
 * Save the shared draft. Autosaved by the editor as people type, so it only
 * checks shape (the validator) — the publish checks run on Publish, where a
 * half-written lesson is expected until then.
 */
export const saveDraft = mutation({
  args: {
    courseSlug: v.string(),
    edit: courseEditValidator,
    basedOnVersion: v.number(),
  },
  handler: async (ctx, { courseSlug, edit, basedOnVersion }) => {
    await requireAcademyEditPower(ctx);
    requireKnownCourse(courseSlug);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const now = Date.now();
    const fields = {
      edit,
      basedOnVersion,
      updatedAt: now,
      updatedBy: userId,
      updatedByName: await callerName(ctx, userId),
    };
    const existing = await draftRow(ctx, courseSlug);
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("academyCourseDrafts", { courseSlug, ...fields });
    return { updatedAt: now };
  },
});

/** Throw the draft away; learners keep seeing what's published. */
export const discardDraft = mutation({
  args: { courseSlug: v.string() },
  handler: async (ctx, { courseSlug }) => {
    await requireAcademyEditPower(ctx);
    const existing = await draftRow(ctx, courseSlug);
    if (existing) await ctx.db.delete(existing._id);
    return null;
  },
});

/**
 * Load an earlier version into the draft, ready to review and publish.
 * `version: 0` is the built-in version from code.
 */
export const restoreVersion = mutation({
  args: { courseSlug: v.string(), version: v.number() },
  handler: async (ctx, { courseSlug, version }) => {
    await requireAcademyEditPower(ctx);
    requireKnownCourse(courseSlug);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    let edit = null;
    if (version !== 0) {
      const row = await ctx.db
        .query("academyCourseVersions")
        .withIndex("by_course_and_version", (q) =>
          q.eq("courseSlug", courseSlug).eq("version", version),
        )
        .unique();
      if (!row) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "That version of the course doesn't exist.",
        });
      }
      edit = row.edit;
    }
    const fields = {
      edit,
      basedOnVersion: await currentVersion(ctx, courseSlug),
      updatedAt: Date.now(),
      updatedBy: userId,
      updatedByName: await callerName(ctx, userId),
    };
    const existing = await draftRow(ctx, courseSlug);
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("academyCourseDrafts", { courseSlug, ...fields });
    return null;
  },
});

/**
 * Publish the draft to every learner. Refuses a draft that isn't finished
 * (`courseEditProblems`), and one that started from a version someone else
 * has since published over — the editor reloads that version first, so a
 * publish never silently erases another editor's work.
 */
export const publishDraft = mutation({
  args: { courseSlug: v.string() },
  handler: async (ctx, { courseSlug }) => {
    await requireAcademyEditPower(ctx);
    requireKnownCourse(courseSlug);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const draft = await draftRow(ctx, courseSlug);
    if (!draft) {
      throw new ConvexError({
        code: "NO_DRAFT",
        message: "There's nothing to publish — the draft is empty.",
      });
    }
    const version = await currentVersion(ctx, courseSlug);
    if (draft.basedOnVersion !== version) {
      throw new ConvexError({
        code: "STALE_DRAFT",
        message:
          "Someone published this course after your draft started. Discard the draft and edit the new version.",
      });
    }

    const catalog = await loadAcademyCatalog(ctx);
    let summary: string[];
    if (draft.edit) {
      const problems = courseEditProblems(courseSlug, draft.edit, catalog);
      if (problems.length > 0) {
        throw new ConvexError({
          code: "NOT_READY",
          message: `Fix these before publishing: ${problems.slice(0, 5).join(" ")}${
            problems.length > 5 ? ` …and ${problems.length - 5} more.` : ""
          }`,
        });
      }
      summary = describeCourseEditChanges(courseSlug, draft.edit, catalog);
      if (summary.length === 0) summary = ["Published with no visible changes"];
    } else {
      summary = ["Restored the built-in version"];
    }

    const now = Date.now();
    const next = version + 1;
    const publishedByName = await callerName(ctx, userId);
    await ctx.db.insert("academyCourseVersions", {
      courseSlug,
      version: next,
      edit: draft.edit,
      summary,
      publishedAt: now,
      publishedBy: userId,
      publishedByName,
    });
    const live = await publishedRow(ctx, courseSlug);
    if (draft.edit === null) {
      if (live) await ctx.db.delete(live._id);
    } else if (live) {
      await ctx.db.patch(live._id, {
        edit: draft.edit,
        version: next,
        publishedAt: now,
        publishedBy: userId,
      });
    } else {
      await ctx.db.insert("academyCourseEdits", {
        courseSlug,
        edit: draft.edit,
        version: next,
        publishedAt: now,
        publishedBy: userId,
      });
    }
    await ctx.db.delete(draft._id);
    return { version: next, summary };
  },
});
