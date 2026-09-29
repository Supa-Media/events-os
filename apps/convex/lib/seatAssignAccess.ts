/**
 * Who may FILL a seat directly — put a person in it, or take them out,
 * without the two-party proposal flow (`seatProposals.ts`).
 *
 * Gate: superuser OR a held seat granting `org.seats.edit` ("Fill seats").
 * `org.chart.edit` implies it (see `powers.ts`), so the Executive Director
 * holds it through the chart power today; it exists as its own string so it
 * can be handed to a seat that should staff the chart without reshaping it.
 *
 * Like `requireChartEditor`, the power reaches every scope from whichever
 * seat grants it. Before 2026-09-29 this was a bare `requireSuperuser` on
 * `seats.assignSeat`/`unassignSeat`, which meant the ED could only staff their
 * own chart by being a superuser.
 */
import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { requireAccess, requireUserId } from "./context";
import { isSuperuser } from "./superuser";
import { callerPersonIds, effectiveCapabilities } from "./seatStructure";

/** Non-throwing: may the caller fill seats directly? `false` for a signed-out
 *  or unapproved caller rather than a throw, so a read can surface it. */
export async function hasSeatFillPower(ctx: QueryCtx | MutationCtx): Promise<boolean> {
  try {
    await requireAccess(ctx);
  } catch {
    return false;
  }
  if (await isSuperuser(ctx)) return true;
  const userId = (await requireUserId(ctx)) as Id<"users">;
  const caps = await effectiveCapabilities(ctx, await callerPersonIds(ctx, userId));
  return caps.has("org.seats.edit");
}

/** Throwing form, for every direct assign/unassign call site. */
export async function requireSeatFillPower(ctx: QueryCtx | MutationCtx): Promise<void> {
  await requireAccess(ctx);
  if (!(await hasSeatFillPower(ctx))) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message:
        "Only someone with the Fill seats power can change who holds a seat directly. Propose the change instead.",
    });
  }
}
