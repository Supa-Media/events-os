import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Backfill `people.isActive` (legacy boolean) → `people.status` (lifecycle).
 *
 * The roster's active/inactive flag is superseded by the richer `status`
 * union ("active" | "inactive" | "transitioning_in" | …). This derives a
 * `status` for every row that lacks one: `isActive === false` → "inactive",
 * otherwise "active". Additive: `isActive` is kept (writers still sync it as a
 * convenience flag; dropped only in a later Deploy C).
 *
 * Idempotent: any row that already has a `status` is left untouched, so a
 * second run copies nothing and never overwrites a richer state. Single-pass
 * over the roster, consistent with the other people-scale backfills.
 */
export async function runBackfillPersonStatus(ctx: MutationCtx) {
  let copied = 0;
  for (const person of await ctx.db.query("people").collect()) {
    if (person.status !== undefined) continue;
    // `isActive` was dropped from the schema in Deploy C; this ledgered
    // migration only needs to typecheck (it never re-runs on prod), so read it
    // via `any`.
    const isActive = (person as any).isActive as boolean | undefined;
    await ctx.db.patch(person._id, {
      status: isActive === false ? "inactive" : "active",
    });
    copied++;
  }
  return { copied };
}

export const backfillPersonStatus: Migration = {
  name: "0011_backfill_person_status",
  run: runBackfillPersonStatus,
};
