import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Backfill `people.skills` → `people.services` (Chapter-OS rename).
 *
 * Copies the legacy `skills` array into the new `services` field for every
 * roster row that has skills but no services yet. Purely additive: `skills` is
 * left untouched (dropped only in a later Deploy C).
 *
 * Idempotent: a row that already has `services` is skipped, so a second run
 * copies nothing. Reads the whole roster in one transaction — the same
 * single-pass approach as the existing column/role backfills; at
 * chapter-roster scale that stays well within a mutation's limits. If the
 * roster ever outgrows a single transaction this would move to the
 * `.take(n)` + `scheduler.runAfter` self-batching pattern.
 */
export async function runBackfillPeopleServices(ctx: MutationCtx) {
  let copied = 0;
  for (const person of await ctx.db.query("people").collect()) {
    if (person.services !== undefined) continue;
    if (person.skills === undefined) continue;
    await ctx.db.patch(person._id, { services: person.skills });
    copied++;
  }
  return { copied };
}

export const backfillPeopleServices: Migration = {
  name: "0009_backfill_people_services",
  run: runBackfillPeopleServices,
};
