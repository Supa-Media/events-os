/**
 * Email-action tokens for projects — act on a project straight from a
 * reminder email, no login.
 *
 * A token is a 30-day capability: THIS person may read a summary of THIS
 * project and move its status (in progress / blocked / done) via the public
 * `/p/<token>` page (http.ts). Reminder emails mint one per (project, owner)
 * as they send, reusing a still-fresh row so a project's link stays stable
 * across a month of digests. Status changes made this way are logged into
 * the project's comment thread, attributed to the token's person, so the
 * progression record stays complete.
 */
import {
  internalQuery,
  internalMutation,
  QueryCtx,
} from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  PROJECT_STATUS_LABELS,
  type ProjectStatus,
} from "@events-os/shared";
import { getBudgetForRef } from "./finances";

export const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Reuse an existing token only while it still has this long to live — a
 * link in a fresh email should never die in the reader's inbox next week. */
const REUSE_MIN_REMAINING_MS = 7 * 24 * 60 * 60 * 1000;

/** The statuses the email page offers. Everything else stays app-only. */
export const EMAIL_ACTION_STATUSES = [
  "in_progress",
  "blocked",
  "done",
] as const satisfies readonly ProjectStatus[];
export type EmailActionStatus = (typeof EMAIL_ACTION_STATUSES)[number];

const emailActionStatus = v.union(
  ...EMAIL_ACTION_STATUSES.map((s) => v.literal(s)),
);

function newToken(): string {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

/**
 * Tokens for one recipient across the projects an email is about to mention.
 * Returns { [projectId]: token }. Called by the reminder actions right before
 * rendering, so only projects that actually appear in an email get tokens.
 */
export const mintProjectTokens = internalMutation({
  args: { personId: v.id("people"), projectIds: v.array(v.id("projects")) },
  handler: async (ctx, { personId, projectIds }) => {
    const now = Date.now();
    const out: Record<Id<"projects">, string> = {};
    for (const projectId of projectIds) {
      const project = await ctx.db.get(projectId);
      if (!project) continue;
      // Every token for a (project, person) pair shares the fixed TTL, so the
      // newest row is the only reuse candidate — read just that one.
      const newest = await ctx.db
        .query("projectEmailTokens")
        .withIndex("by_project_and_person", (q) =>
          q.eq("projectId", projectId).eq("personId", personId),
        )
        .order("desc")
        .first();
      if (newest && newest.expiresAt - now >= REUSE_MIN_REMAINING_MS) {
        out[projectId] = newest.token;
        continue;
      }
      const token = newToken();
      await ctx.db.insert("projectEmailTokens", {
        chapterId: project.chapterId,
        projectId,
        personId,
        token,
        expiresAt: now + TOKEN_TTL_MS,
        createdAt: now,
      });
      out[projectId] = token;
    }
    return out;
  },
});

/** Resolve a token to a valid row, or null (unknown or expired). */
async function liveToken(
  ctx: QueryCtx,
  token: string,
): Promise<Doc<"projectEmailTokens"> | null> {
  if (!token) return null;
  const row = await ctx.db
    .query("projectEmailTokens")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (!row || row.expiresAt < Date.now()) return null;
  return row;
}

/**
 * Everything the `/p/<token>` page renders: the project's full management
 * summary (status, owner, deadline, budget, blocker, purpose, recent thread)
 * plus who the token belongs to. Null for unknown/expired tokens.
 */
export const pageData = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const row = await liveToken(ctx, token);
    if (!row) return null;
    const project = await ctx.db.get(row.projectId);
    if (!project) return null;
    const person = await ctx.db.get(row.personId);
    const owner = project.ownerPersonId
      ? await ctx.db.get(project.ownerPersonId)
      : null;
    const parent = project.parentProjectId
      ? await ctx.db.get(project.parentProjectId)
      : null;
    const event = project.eventId ? await ctx.db.get(project.eventId) : null;
    const comments = await ctx.db
      .query("projectComments")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .order("desc")
      .take(5);
    const commentRows = await Promise.all(
      comments.map(async (c) => {
        const author = await ctx.db.get(c.authorPersonId);
        return {
          body: c.body,
          authorName: author?.name ?? null,
          createdAt: c.createdAt,
        };
      }),
    );
    // WP-U2: the planned budget reads the budget ROW (single source of
    // truth), not the entity's mirror field.
    const budgetRow = await getBudgetForRef(ctx, "project", project._id);
    const budgetUsd =
      budgetRow && budgetRow.amountCents > 0 ? budgetRow.amountCents / 100 : null;
    return {
      personId: row.personId,
      personName: person?.name ?? null,
      project: {
        _id: project._id,
        name: project.name,
        purpose: project.purpose ?? null,
        status: project.status,
        deadline: project.deadline ?? null,
        startDate: project.startDate ?? null,
        budgetUsd,
        blocker: project.blocker ?? null,
        ownerName: owner?.name ?? null,
        parentName: parent?.name ?? null,
        eventName: event?.name ?? null,
      },
      comments: commentRows,
    };
  },
});

/**
 * Apply a status change carried by a token (the POST behind the page's
 * buttons). Also logs the change into the project's thread — attributed to
 * the token's person — so an email-side "done" shows up in the progression
 * record like any other update. Returns the fresh status, or null when the
 * token is unknown/expired.
 */
export const setStatusFromToken = internalMutation({
  args: { token: v.string(), status: emailActionStatus },
  handler: async (ctx, { token, status }) => {
    const row = await liveToken(ctx, token);
    if (!row) return null;
    const project = await ctx.db.get(row.projectId);
    const person = await ctx.db.get(row.personId);
    if (!project || !person) return null;
    if (project.status !== status) {
      await ctx.db.patch(project._id, { status, updatedAt: Date.now() });
      // The thread is the progression record — email-side changes belong in
      // it too. `createdBy` is the project creator's user only because the
      // token flow has no logged-in user; attribution reads from the person.
      await ctx.db.insert("projectComments", {
        chapterId: project.chapterId,
        projectId: project._id,
        authorPersonId: person._id,
        body: `Marked ${PROJECT_STATUS_LABELS[status]} via email link.`,
        createdBy: project.createdBy,
        createdAt: Date.now(),
      });
    }
    return { projectName: project.name, status };
  },
});

/** Daily sweep (crons.ts): drop expired tokens so dead capabilities don't
 * accumulate. Bounded per run; the backlog drains across days if huge. */
export const purgeExpiredTokens = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("projectEmailTokens")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", now))
      .take(500);
    for (const row of expired) await ctx.db.delete(row._id);
    return expired.length;
  },
});
