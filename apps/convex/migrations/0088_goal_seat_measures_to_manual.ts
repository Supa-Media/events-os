import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Turn every "seat filled" key result into a manual one (2026-10-03).
 *
 * Seat measures counted holders of a seat as recruits, so "Recruit the NYC
 * Chapter Director" read Done because the chapter's existing president sits
 * in that seat. The founder's call: recruiting is marked by hand for now. Each
 * row keeps its status and target (1 when unset) and is counted in people;
 * the seat fields are cleared so nothing reads them again.
 *
 * Idempotent by content: a second run finds no seat_filled rows.
 */
export async function runGoalSeatMeasuresToManual(ctx: MutationCtx) {
  const rows = await ctx.db.query("goalKeyResults").take(2000);
  let converted = 0;
  for (const kr of rows) {
    if (kr.measureKind !== "seat_filled") continue;
    await ctx.db.patch(kr._id, {
      measureKind: "manual",
      target: kr.target ?? 1,
      unit: kr.unit ?? "people",
      seatSlug: undefined,
      seatScope: undefined,
      seatWatchSince: undefined,
      updatedAt: Date.now(),
    });
    converted++;
  }
  return { converted };
}

export const goalSeatMeasuresToManual: Migration = {
  name: "0088_goal_seat_measures_to_manual",
  run: runGoalSeatMeasuresToManual,
};
