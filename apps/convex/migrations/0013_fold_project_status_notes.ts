import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Fold legacy `projects.statusNote` / `projects.nextSteps` into a single
 * `projectComments` row (the append-only progression log that superseded them).
 *
 * The one-slot status note + next-steps fields are superseded by the running
 * comment history. For every project carrying either legacy field, this writes
 * ONE comment combining them, authored by the project's effective owner (the
 * first owner up the parent chain), attributed to the project's creating user.
 * Additive: the legacy fields are left in place as a fallback (dropped only in a
 * later Deploy C).
 *
 * Idempotent: skips a project when a comment with the exact composed body
 * already exists on it, so a re-run creates no duplicate. Projects with no
 * resolvable roster person to attribute authorship to are skipped (their legacy
 * fields still render via the fallback).
 */

/** First owner up the parent chain (bounded against corrupt chains). */
async function effectiveOwnerId(
  ctx: MutationCtx,
  project: Pick<Doc<"projects">, "ownerPersonId" | "parentProjectId">,
): Promise<Id<"people"> | undefined> {
  let cur: Pick<Doc<"projects">, "ownerPersonId" | "parentProjectId"> = project;
  for (let hops = 0; hops < 100; hops++) {
    if (cur.ownerPersonId) return cur.ownerPersonId;
    if (!cur.parentProjectId) return undefined;
    const parent = await ctx.db.get(cur.parentProjectId);
    if (!parent) return undefined;
    cur = parent;
  }
  return undefined;
}

/** Combine the two legacy fields into one comment body, or null if both empty. */
function composeBody(
  statusNote?: string,
  nextSteps?: string,
): string | null {
  const parts: string[] = [];
  const s = statusNote?.trim();
  const n = nextSteps?.trim();
  if (s) parts.push(s);
  if (n) parts.push(`Next steps: ${n}`);
  return parts.length ? parts.join("\n\n") : null;
}

export async function runFoldProjectStatusNotes(ctx: MutationCtx) {
  let folded = 0;
  let skippedNoAuthor = 0;

  for (const project of await ctx.db.query("projects").collect()) {
    const body = composeBody(project.statusNote, project.nextSteps);
    if (!body) continue;

    // Idempotency: a matching comment already exists → this project is folded.
    const existing = await ctx.db
      .query("projectComments")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .collect();
    if (existing.some((c) => c.body === body)) continue;

    // Author = effective owner up the chain, else the creating user's linked
    // roster person, else the oldest person in the chapter.
    let authorPersonId = await effectiveOwnerId(ctx, project);
    if (!authorPersonId) {
      const linked = await ctx.db
        .query("people")
        .withIndex("by_user", (q) => q.eq("userId", project.createdBy))
        .first();
      authorPersonId =
        linked && linked.chapterId === project.chapterId
          ? linked._id
          : undefined;
    }
    if (!authorPersonId) {
      const anyPerson = await ctx.db
        .query("people")
        .withIndex("by_chapter", (q) => q.eq("chapterId", project.chapterId))
        .first();
      authorPersonId = anyPerson?._id;
    }
    if (!authorPersonId) {
      skippedNoAuthor++;
      continue;
    }

    await ctx.db.insert("projectComments", {
      chapterId: project.chapterId,
      projectId: project._id,
      authorPersonId,
      body,
      createdBy: project.createdBy,
      createdAt: Date.now(),
    });
    folded++;
  }

  return { folded, skippedNoAuthor };
}

export const foldProjectStatusNotes: Migration = {
  name: "0013_fold_project_status_notes",
  run: runFoldProjectStatusNotes,
};
