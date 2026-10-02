/**
 * Linking a project to the ONE key result it moves (`projects.keyResultId`).
 *
 * Lives beside `projects.ts` rather than in it (that file is past the size
 * limit). Same gate as every other project edit — anyone on the chapter's
 * roster, or a chapter admin — and the change lands in the project's update
 * log like any other field.
 */
import { mutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import { requireOwned } from "./lib/context";
import { isChapterAdmin, viewerPerson } from "./lib/org";
import { requireGoalsView } from "./lib/goalsAccess";

export const setKeyResult = mutation({
  args: {
    projectId: v.id("projects"),
    keyResultId: v.union(v.id("goalKeyResults"), v.null()),
  },
  handler: async (ctx, { projectId, keyResultId }) => {
    const project = await requireOwned(ctx, "projects", projectId, "Project");
    await requireGoalsView(ctx);
    const author = await viewerPerson(ctx, project.chapterId);
    if (!author && !(await isChapterAdmin(ctx, project.chapterId))) {
      throw new ConvexError({ code: "FORBIDDEN", message: "You need a roster profile to edit projects." });
    }
    if ((project.keyResultId ?? null) === keyResultId) return;

    let summary = "Key result cleared";
    if (keyResultId) {
      const kr = await ctx.db.get(keyResultId);
      if (!kr) throw new ConvexError({ code: "NOT_FOUND", message: "Key result not found." });
      summary = `Key result → ${kr.title}`;
    }
    const now = Date.now();
    await ctx.db.patch(projectId, {
      keyResultId: (keyResultId ?? undefined) as Id<"goalKeyResults"> | undefined,
      updatedAt: now,
    });
    await ctx.db.insert("projectUpdates", {
      chapterId: project.chapterId,
      projectId,
      authorPersonId: author?._id,
      field: "keyResult",
      summary,
      createdAt: now,
    });
  },
});
