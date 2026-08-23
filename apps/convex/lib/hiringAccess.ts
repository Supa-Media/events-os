/**
 * HIRING authorization — the People desk's gate.
 *
 * The named resolver pair CLAUDE.md's "Gate It Behind a Power" section
 * requires: nothing in `hiring.ts` checks a seat, a title, or a chapter
 * inline. Three rungs, because the Academy's pipeline has three distinct
 * jobs and the org already separates them:
 *
 *   `hiring.view`     read the desk — applications, rubric cards, timelines.
 *   `hiring.edit`     RUN the funnel — move a candidate, file a review, start
 *                     an Empowerment Trial. What a Recruiting Associate does.
 *   `hiring.approve`  make the CALL — close a file with an outcome and send
 *                     the message. The Director's, and only the Director's:
 *                     "the Director has the final say — this process supports
 *                     their prayerful decision, it doesn't replace it."
 *
 * `hiring.approve` explicitly implies `hiring.edit` (see `powers.ts`), so a
 * Director isn't locked out of their own pipeline; the split exists to stop an
 * associate closing a file, not to stop a Director running one.
 *
 * CENTRAL ONLY. Unlike `givingAccess.ts` — whose chapter-scope reach is the
 * point, since a chapter treasurer stewards their own donors — hiring has no
 * per-chapter scope at all. One funnel, one standard, for roles central and
 * chapter alike. A chapter-scoped hiring grant reaches nothing, which is what
 * `scope: "central"` on all three powers already tells the org chart.
 *
 * Every refusal throws `ConvexError({ code, message })` (never a plain
 * `Error`) so the app's AuthErrorBoundary can surface it, exactly like the
 * finance and giving gates.
 */
import { ConvexError } from "convex/values";
import { Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";
import { isSuperuser } from "./superuser";
import { requireUserId } from "./context";
import { getSeatDerivedHiringCapabilities } from "./seats";

/** The caller's resolved reach on the Hiring desk. */
export interface HiringAccess {
  /** Superuser — the bootstrap path, mirrored across the repo. */
  isSuperuser: boolean;
  /** Read the desk. */
  canView: boolean;
  /** Run the pipeline (implies `canView`). */
  canManage: boolean;
  /** Close a file (implies `canManage`). */
  canDecide: boolean;
}

const NONE: HiringAccess = {
  isSuperuser: false,
  canView: false,
  canManage: false,
  canDecide: false,
};

/**
 * Resolve the caller's hiring reach across every non-placeholder `people` row
 * their `userId` owns — the same whole-user walk `resolveGivingAccess` does,
 * so a seat held on a non-home roster row still counts. Central-scope grants
 * only; a chapter-scope hiring seat contributes nothing (see the module doc).
 * Pure read.
 */
export async function resolveHiringAccess(ctx: QueryCtx): Promise<HiringAccess> {
  if (await isSuperuser(ctx)) {
    return { isSuperuser: true, canView: true, canManage: true, canDecide: true };
  }

  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return { ...NONE }; // signed out — no reach (quiet, not a throw)

  const userId = (await requireUserId(ctx)) as Id<"users">;
  const people = await ctx.db
    .query("people")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();

  const access: HiringAccess = { ...NONE };
  for (const person of people) {
    if (person.isPlaceholder === true) continue;
    const caps = await getSeatDerivedHiringCapabilities(ctx, person._id);
    if (caps.view) access.canView = true;
    if (caps.manage) access.canManage = true;
    if (caps.decide) access.canDecide = true;
  }
  return access;
}

/** Assert the caller may READ the Hiring desk, else throw. */
export async function requireHiringView(ctx: QueryCtx): Promise<HiringAccess> {
  const access = await resolveHiringAccess(ctx);
  if (!access.canView) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "You don't have access to the hiring desk.",
    });
  }
  return access;
}

/** Assert the caller may RUN the pipeline (move a file, file a review, start a
 *  trial), else throw. */
export async function requireHiringManage(ctx: QueryCtx): Promise<HiringAccess> {
  const access = await resolveHiringAccess(ctx);
  if (!access.canManage) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "You don't have permission to run the hiring pipeline.",
    });
  }
  return access;
}

/**
 * Assert the caller may CLOSE a file — place, not-now, or decline someone.
 * Separate from `requireHiringManage` on purpose: this is the one hiring act
 * the org reserves to a director, and the reservation is worth a gate rather
 * than a convention.
 */
export async function requireHiringDecide(ctx: QueryCtx): Promise<HiringAccess> {
  const access = await resolveHiringAccess(ctx);
  if (!access.canDecide) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message:
        "Only a director can make the call on a candidate. Ask the People Director or the ED.",
    });
  }
  return access;
}
