import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import {
  OPERATIONS_TEAM_DESCRIPTION,
  PEOPLE_TEAM_DESCRIPTION,
  SEAT_DEFS,
} from "@events-os/shared";

const SLUG = "recruiting_associate";
const OLD_TITLE = "Recruiting Associate";
const OLD_KR_TITLE = "Recruit a recruiting associate.";
const NEW_KR_TITLE = "Recruit a People Associate.";

/**
 * Founder asks (2026-10-28): the Recruiting Associate is now the People
 * Associate, whose work includes the monthly all-team meeting and team hangs
 * alongside recruiting; and People, Recruiting and Finance sit under an
 * Operations team that owns email accounts, Google groups and Chapter OS
 * changes.
 *
 * The seat template (`packages/shared/src/seats.ts`) and the One Pager seed
 * (`goals.ts`) carry the new shape, but neither reaches rows already stamped
 * or imported, so this carries it onto the live data. Every write only
 * replaces the OLD value, so anything an editor has changed in the app since
 * is left alone. Reporting lines are NOT touched: the live chart already has
 * an Operations Director (added in the app, under its own slug) with the
 * Financial Manager and People Associate under it.
 *  - the seat row: title if still "Recruiting Associate", duties if still
 *    empty;
 *  - job listings for the seat whose title is still the old one;
 *  - an "Operations team" is created if no live team has that name, led by
 *    the live central seat titled "Operations Director" when there is one,
 *    and the People and Finance teams go under it if they have no parent yet;
 *  - the key result titled "Recruit a recruiting associate.".
 */
export async function runPeopleAssociateAndOperationsTeam(ctx: MutationCtx) {
  const now = Date.now();
  const seat = SEAT_DEFS[SLUG];
  let seatRows = 0;
  for (const row of await ctx.db
    .query("seatDefs")
    .withIndex("by_slug", (q) => q.eq("slug", SLUG))
    .collect()) {
    const patch: { title?: string; duties?: string[] } = {};
    if (row.title === OLD_TITLE) patch.title = seat.title;
    if (row.duties.length === 0) patch.duties = [...seat.duties];
    if (Object.keys(patch).length === 0) continue;
    await ctx.db.patch(row._id, { ...patch, updatedAt: now });
    seatRows++;
  }

  let listings = 0;
  for (const listing of await ctx.db.query("jobListings").take(500)) {
    if (listing.seatId !== SLUG || listing.title !== OLD_TITLE) continue;
    await ctx.db.patch(listing._id, { title: seat.title });
    listings++;
  }

  const teams = await ctx.db.query("orgTeams").withIndex("by_sortOrder").take(300);
  const live = new Map(
    teams.filter((t) => !t.isArchived).map((t) => [t.name.toLowerCase(), t]),
  );
  let teamsChanged = 0;
  // Only touch teams on an org that has imported the plan: an org with no
  // teams yet gets the whole shape from the One Pager import.
  if (live.size > 0) {
    let operationsId = live.get("operations team")?._id;
    if (!operationsId) {
      const director = (
        await ctx.db
          .query("seatDefs")
          .withIndex("by_chart", (q) => q.eq("chart", "central"))
          .collect()
      ).find((d) => d.title.trim().toLowerCase() === "operations director");
      operationsId = await ctx.db.insert("orgTeams", {
        name: "Operations team",
        leadSeatSlug: director?.slug,
        seatSlugs: [],
        description: OPERATIONS_TEAM_DESCRIPTION,
        sortOrder: teams.reduce((m, t) => Math.max(m, t.sortOrder), -1) + 1,
        createdAt: now,
        updatedAt: now,
      });
      teamsChanged++;
    }
    for (const name of ["people team", "finance team"]) {
      const team = live.get(name);
      if (!team) continue;
      const patch: { parentTeamId?: typeof operationsId; description?: string } = {};
      if (!team.parentTeamId) patch.parentTeamId = operationsId;
      if (name === "people team" && !team.description) {
        patch.description = PEOPLE_TEAM_DESCRIPTION;
      }
      if (Object.keys(patch).length === 0) continue;
      await ctx.db.patch(team._id, { ...patch, updatedAt: now });
      teamsChanged++;
    }
  }

  let keyResults = 0;
  for (const kr of await ctx.db.query("goalKeyResults").take(1000)) {
    if (kr.title !== OLD_KR_TITLE) continue;
    await ctx.db.patch(kr._id, { title: NEW_KR_TITLE, updatedAt: now });
    keyResults++;
  }

  return { seatRows, listings, teamsChanged, keyResults };
}

export const peopleAssociateAndOperationsTeam: Migration = {
  name: "0096_people_associate_and_operations_team",
  run: runPeopleAssociateAndOperationsTeam,
};
