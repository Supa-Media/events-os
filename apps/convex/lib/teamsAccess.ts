/**
 * Teams authorization — the named gate for editing `orgTeams` (who is on
 * which team, which seat leads it, how teams nest).
 *
 * Reading teams needs only membership (the Goals screen shows owners to
 * everyone). Editing them is, today, the org-chart power: a team is a group
 * of seats, so whoever reshapes seats (`org.chart.edit`, or a superuser)
 * reshapes teams. Teams grant NO powers themselves — seats still do — so
 * this gate only protects the labels the plan uses for ownership.
 *
 * Graduates to an `org.teams.edit` power (implied by `org.chart.edit`, the
 * way `org.seats.edit` is) by changing `hasTeamsEdit`'s body only.
 */
import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireAccess } from "./context";
import { canEditChart } from "./seatStructure";

export async function hasTeamsEdit(ctx: QueryCtx | MutationCtx): Promise<boolean> {
  return await canEditChart(ctx);
}

export async function requireTeamsEdit(ctx: QueryCtx | MutationCtx): Promise<void> {
  await requireAccess(ctx);
  if (!(await hasTeamsEdit(ctx))) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "Only someone who can edit the org chart can change teams.",
    });
  }
}
