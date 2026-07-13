import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Backfill `templatePeople.team` (single) → `templatePeople.teams` (multi).
 *
 * A placeholder crew row used to carry one `team` string; it now carries a
 * `teams` array (a placeholder can stand in across several teams). This copies
 * the legacy single value into the array for every row that has a `team` but no
 * `teams` yet. Additive: `team` is left intact (dropped in a later Deploy C).
 *
 * Idempotent: rows that already have `teams` are skipped. The template-crew
 * table is small (a handful of rows per template), so a single-pass sweep is
 * safe.
 */
export async function runBackfillTemplatePeopleTeams(ctx: MutationCtx) {
  let copied = 0;
  for (const row of await ctx.db.query("templatePeople").collect()) {
    if (row.teams !== undefined) continue;
    if (!row.team) continue;
    await ctx.db.patch(row._id, { teams: [row.team] });
    copied++;
  }
  return { copied };
}

export const backfillTemplatePeopleTeams: Migration = {
  name: "0010_backfill_template_people_teams",
  run: runBackfillTemplatePeopleTeams,
};
