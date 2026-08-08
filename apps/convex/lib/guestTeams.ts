/**
 * Server side of guest teams — reading an event's active team set and
 * assigning an arriving guest to one at check-in.
 *
 * The balancing rule itself lives in `@events-os/shared#pickTeamIndex` (pure,
 * unit-tested there); this module is the Convex-facing half that reads the
 * standings, writes the assignment, and keeps the denormalized counter honest.
 *
 * Every write here runs inside a Convex mutation, so the read-standings →
 * pick-least-loaded → write-assignment sequence is a serializable transaction:
 * two volunteers scanning at the same instant cannot both claim the same slot,
 * and the loser is retried rather than allowed to double-fill a team.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { pickTeamIndex } from "@events-os/shared";

/** What the door shows for a ticket's team — the two fields it renders. */
export interface AssignedTeam {
  teamId: Id<"guestTeams">;
  name: string;
  color: string;
}

/** Every team row for an event, active and inactive, in display order. */
export async function allTeamsForEvent(
  ctx: QueryCtx,
  eventId: Id<"events">,
): Promise<Doc<"guestTeams">[]> {
  const teams = await ctx.db
    .query("guestTeams")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .collect();
  return teams.sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Just the teams a new arrival can actually be put on. */
export async function activeTeamsForEvent(
  ctx: QueryCtx,
  eventId: Id<"events">,
): Promise<Doc<"guestTeams">[]> {
  return (await allTeamsForEvent(ctx, eventId)).filter(
    (t) => t.isActive !== false,
  );
}

/** True iff this event assigns teams at the door right now. */
export async function teamsEnabledFor(
  ctx: QueryCtx,
  eventId: Id<"events">,
): Promise<boolean> {
  const page = await ctx.db
    .query("eventPages")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .unique();
  return page?.teamsEnabled === true;
}

/** Render shape for a team row the caller already has in hand. */
export function toAssignedTeam(team: Doc<"guestTeams">): AssignedTeam {
  return { teamId: team._id, name: team.name, color: team.color };
}

/** The team a ticket is already on, or null. */
export async function teamForTicket(
  ctx: QueryCtx,
  ticket: Doc<"tickets">,
): Promise<AssignedTeam | null> {
  if (!ticket.guestTeamId) return null;
  const team = await ctx.db.get(ticket.guestTeamId);
  return team ? toAssignedTeam(team) : null;
}

/**
 * Put `ticket` on a team if it isn't on one yet, and return the team it's on.
 *
 * Idempotent by design and that matters more here than almost anywhere else in
 * the app: the guest is wearing a physical wristband by the time anyone
 * re-scans them, so a second scan must return the SAME team rather than
 * rebalancing them onto a new one. An already-assigned ticket short-circuits
 * before any write.
 *
 * Called on both the "ok" and the "already" check-in paths. The "already" call
 * is what makes turning teams on halfway through a door shift recoverable —
 * re-scan the guests admitted before the switch and they pick up teams,
 * balanced against everyone already assigned.
 *
 * Returns null when the event has teams off or has no active teams, which is
 * the normal state for every event that never opted in.
 */
export async function assignTeamIfNeeded(
  ctx: MutationCtx,
  ticket: Doc<"tickets">,
): Promise<AssignedTeam | null> {
  const existing = await teamForTicket(ctx, ticket);
  if (existing) return existing;

  if (!(await teamsEnabledFor(ctx, ticket.eventId))) return null;
  const teams = await activeTeamsForEvent(ctx, ticket.eventId);
  const index = pickTeamIndex(teams, ticket.code);
  if (index < 0) return null;

  const team = teams[index];
  await ctx.db.patch(ticket._id, { guestTeamId: team._id });
  await ctx.db.patch(team._id, { assignedCount: team.assignedCount + 1 });
  return toAssignedTeam(team);
}

/**
 * Recount `assignedCount` for every team on an event from the tickets that
 * actually point at them, and write back the ones that drifted.
 *
 * The counter is maintained incrementally by the two writers that move tickets
 * between teams, so this is a repair path, not the normal one: it exists
 * because a denormalized counter that only ever goes up on one code path is
 * exactly the kind of thing that silently desyncs, and a desynced counter
 * quietly stops balancing. Cheap at door scale (one event's tickets) and run
 * whenever the team set is resized, which is the moment the standings are read
 * for a decision that persists.
 */
export async function recountTeams(
  ctx: MutationCtx,
  eventId: Id<"events">,
): Promise<void> {
  const tickets = await ctx.db
    .query("tickets")
    .withIndex("by_event", (q) => q.eq("eventId", eventId))
    .collect();
  const counts = new Map<string, number>();
  for (const t of tickets) {
    if (!t.guestTeamId) continue;
    counts.set(t.guestTeamId, (counts.get(t.guestTeamId) ?? 0) + 1);
  }
  for (const team of await allTeamsForEvent(ctx, eventId)) {
    const actual = counts.get(team._id) ?? 0;
    if (actual !== team.assignedCount) {
      await ctx.db.patch(team._id, { assignedCount: actual });
    }
  }
}
