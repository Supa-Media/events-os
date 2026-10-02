/**
 * Goals authorization — the named gates for the year plans in `goals.ts`.
 *
 * Three questions, three pairs:
 *   view    — may the caller read the plans? Today: any approved member, the
 *             whole org reads the same plan. Graduates to a `goals.view` power.
 *   edit    — may the caller change a plan's CONTENT (mission, targets,
 *             objectives, key results, owners, order) or import/delete one?
 *             Today: whoever may edit the org chart (`org.chart.edit`, the
 *             Executive Director) or a superuser — the same people who reshape
 *             seats, because a plan is the same kind of structural decision.
 *             Graduates to a `goals.edit` power.
 *   update  — may the caller post a status update on a key result? Today: any
 *             approved member, so an owner can say how their result is going
 *             without asking. Graduates to an owner-only check (or a
 *             `goals.update` power) when the org decides who logs updates —
 *             one of the open decisions in the 2026-10-02 audit.
 *
 * Only the bodies below change when those graduate; every call site already
 * uses the `require` form. Copies the shape of `lib/campaignsAccess.ts` and
 * `lib/dutiesAccess.ts`.
 */
import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireAccess } from "./context";
import { canEditChart } from "./seatStructure";

/** May the caller read plans? Boolean twin of `requireGoalsView`. */
export async function hasGoalsView(ctx: QueryCtx | MutationCtx): Promise<boolean> {
  try {
    await requireAccess(ctx);
    return true;
  } catch {
    return false;
  }
}

export async function requireGoalsView(ctx: QueryCtx | MutationCtx): Promise<void> {
  await requireAccess(ctx);
}

/** May the caller change a plan's content? Boolean twin of `requireGoalsEdit`,
 *  for screens deciding whether to render editors. */
export async function hasGoalsEdit(ctx: QueryCtx | MutationCtx): Promise<boolean> {
  return await canEditChart(ctx);
}

export async function requireGoalsEdit(ctx: QueryCtx | MutationCtx): Promise<void> {
  await requireAccess(ctx);
  if (!(await hasGoalsEdit(ctx))) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message:
        "Only the Executive Director (or whoever can edit the org chart) can change the year plan.",
    });
  }
}

/** May the caller post an update on a key result? */
export async function hasGoalsUpdate(ctx: QueryCtx | MutationCtx): Promise<boolean> {
  return await hasGoalsView(ctx);
}

export async function requireGoalsUpdate(ctx: QueryCtx | MutationCtx): Promise<void> {
  await requireAccess(ctx);
}
