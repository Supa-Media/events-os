/**
 * Guest teams — the admin surface (turn on, resize, rename) plus the door's
 * read and its manual override.
 *
 * The feature: an event switches teams on, says how many it wants, and every
 * guest is put on the least-loaded team at the moment they're checked in, so
 * the teams come out even without anyone tracking a tally. See
 * `@events-os/shared/guestTeams.ts` for the rule and why assignment happens at
 * the door rather than at purchase; `lib/guestTeams.ts` for the write path.
 *
 * Access follows `lib/ticketingAccess.ts`: `requireGuestTeamManage` to
 * configure (a chapter member, like every other Tickets-tab setting),
 * `requireCheckInAccess` to move a guest (whoever is working the door),
 * `requireGuestTeamRead` to look (either of the above).
 */
import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  clampTeamCount,
  defaultTeamNameAt,
  teamColorKeyAt,
  DEFAULT_GUEST_TEAM_COUNT,
  MAX_GUEST_TEAMS,
} from "@events-os/shared";
import {
  requireCheckInAccess,
  requireGuestTeamManage,
  requireGuestTeamRead,
} from "./lib/ticketingAccess";
import {
  activeTeamsForEvent,
  allTeamsForEvent,
  recountTeams,
} from "./lib/guestTeams";

/** Longest a team name may be — it has to fit the door's confirmation panel
 *  at a size readable across a folding table. */
const MAX_TEAM_NAME = 40;

/**
 * The event's teams for both the settings card and the door.
 *
 * Returns INACTIVE teams too (flagged), because a guest admitted before the
 * team set was shrunk still points at one and their row would otherwise render
 * teamless. `enabled` is the page flag, reported separately from "are there
 * any teams" so the UI can tell "switched off" from "not set up yet".
 */
export const listForEvent = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    await requireGuestTeamRead(ctx, eventId);
    const page = await ctx.db
      .query("eventPages")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .unique();
    const teams = await allTeamsForEvent(ctx, eventId);
    return {
      enabled: page?.teamsEnabled === true,
      maxTeams: MAX_GUEST_TEAMS,
      teams: teams.map((t) => ({
        _id: t._id,
        name: t.name,
        color: t.color,
        sortOrder: t.sortOrder,
        isActive: t.isActive !== false,
        assignedCount: t.assignedCount,
      })),
    };
  },
});

/**
 * Grow or shrink the team set to exactly `count` active teams.
 *
 * Growing reuses the deactivated rows first (in order) before inserting new
 * ones, so an event that drops from 10 teams to 6 and back to 10 gets its
 * original four names back rather than four fresh "Yellow"/"Purple" defaults.
 * Shrinking deactivates from the end and deliberately does NOT move the guests
 * already on those teams — they're wearing the wristband, and silently
 * re-teaming someone who has already walked in is worse than a temporarily
 * lopsided set that the next arrivals even out.
 *
 * Colors are positional and permanent: team N always renders `TEAM_COLORS[N]`,
 * so renaming is the only way a team's identity changes and the wristbands
 * never shift under the door team mid-event.
 */
export const setTeamCount = mutation({
  args: { eventId: v.id("events"), count: v.number() },
  handler: async (ctx, { eventId, count }) => {
    const event = await requireGuestTeamManage(ctx, eventId);
    const target = clampTeamCount(count);
    const teams = await allTeamsForEvent(ctx, eventId);

    // Reactivate/insert up to `target`, deactivate everything past it. Indexed
    // by position so a row's color always matches its slot in the palette.
    for (let i = 0; i < Math.max(target, teams.length); i++) {
      const existing = teams[i];
      const shouldBeActive = i < target;
      if (existing) {
        if ((existing.isActive !== false) !== shouldBeActive) {
          await ctx.db.patch(existing._id, { isActive: shouldBeActive });
        }
      } else if (shouldBeActive) {
        await ctx.db.insert("guestTeams", {
          eventId,
          chapterId: event.chapterId,
          name: defaultTeamNameAt(i),
          color: teamColorKeyAt(i),
          sortOrder: i,
          isActive: true,
          assignedCount: 0,
          createdAt: Date.now(),
        });
      }
    }

    // Resizing is the one moment the standings drive a decision that sticks,
    // so true them up against the tickets before the next arrival is balanced.
    await recountTeams(ctx, eventId);
    return { count: target };
  },
});

/**
 * Switch door team assignment on or off for the event.
 *
 * Turning it on for the first time seeds the default team set so the organizer
 * isn't handed an empty list; turning it off leaves every row (and every
 * already-assigned guest) alone, so flipping back on resumes with the same
 * names, colors and standings.
 */
export const setEnabled = mutation({
  args: { eventId: v.id("events"), enabled: v.boolean() },
  handler: async (ctx, { eventId, enabled }) => {
    await requireGuestTeamManage(ctx, eventId);
    const page = await ctx.db
      .query("eventPages")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .unique();
    if (!page) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Create the event's RSVP page before setting up teams.",
      });
    }
    await ctx.db.patch(page._id, { teamsEnabled: enabled, updatedAt: Date.now() });

    if (enabled && (await activeTeamsForEvent(ctx, eventId)).length === 0) {
      const event = await ctx.db.get(eventId);
      const teams = await allTeamsForEvent(ctx, eventId);
      for (let i = 0; i < DEFAULT_GUEST_TEAM_COUNT; i++) {
        const existing = teams[i];
        if (existing) {
          await ctx.db.patch(existing._id, { isActive: true });
        } else if (event) {
          await ctx.db.insert("guestTeams", {
            eventId,
            chapterId: event.chapterId,
            name: defaultTeamNameAt(i),
            color: teamColorKeyAt(i),
            sortOrder: i,
            isActive: true,
            assignedCount: 0,
            createdAt: Date.now(),
          });
        }
      }
    }
    return { enabled };
  },
});

/** Rename one team. The color stays put — see `setTeamCount`'s note on why. */
export const renameTeam = mutation({
  args: { teamId: v.id("guestTeams"), name: v.string() },
  handler: async (ctx, { teamId, name }) => {
    const team = await ctx.db.get(teamId);
    if (!team) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Team not found." });
    }
    await requireGuestTeamManage(ctx, team.eventId);
    const trimmed = name.trim().slice(0, MAX_TEAM_NAME);
    if (trimmed === "") {
      throw new ConvexError({
        code: "INVALID",
        message: "Give the team a name.",
      });
    }
    // Two teams with the same name is a door problem before it's a data
    // problem: the volunteer calls out "Red" and two groups answer. The name
    // is how a team is spoken about, so it has to be the unique thing.
    const clash = (await allTeamsForEvent(ctx, team.eventId)).find(
      (t) => t._id !== teamId && t.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (clash) {
      throw new ConvexError({
        code: "INVALID",
        message: `Another team is already called "${clash.name}".`,
      });
    }
    await ctx.db.patch(teamId, { name: trimmed });
  },
});

/**
 * Move one guest to a different team by hand — the door's escape hatch.
 *
 * Exists because assignment hands out a physical wristband: a mis-scan, a
 * family that wants to be together, or a guest handed the wrong color is not
 * recoverable any other way (there is no un-check-in anywhere in this app).
 * Gated on check-in access, not manage access, because the person who needs it
 * is whoever is standing at the door when it goes wrong.
 *
 * Both counters are adjusted so the balancing rule keeps working; the
 * resulting one-over/one-under is absorbed by the next few arrivals rather
 * than by a rebalance, which is the whole point of picking least-loaded.
 */
export const setTicketTeam = mutation({
  args: { ticketId: v.id("tickets"), teamId: v.union(v.id("guestTeams"), v.null()) },
  handler: async (ctx, { ticketId, teamId }) => {
    const ticket = await ctx.db.get(ticketId);
    if (!ticket) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Ticket not found." });
    }
    await requireCheckInAccess(ctx, ticket.eventId);

    let next: Doc<"guestTeams"> | null = null;
    if (teamId !== null) {
      next = await ctx.db.get(teamId);
      if (!next || next.eventId !== ticket.eventId) {
        throw new ConvexError({
          code: "NOT_FOUND",
          message: "That team isn't on this event.",
        });
      }
      // A deactivated team is one the door has stopped handing out bands for.
      // Moving someone onto it would grow a count that `pickTeamIndex` never
      // sees (it balances over ACTIVE teams only), so the guest would hold a
      // retired color and their head would be invisible to the balance.
      if (next.isActive === false) {
        throw new ConvexError({
          code: "INVALID",
          message: "That team isn't in play for this event any more.",
        });
      }
    }
    if ((ticket.guestTeamId ?? null) === (next?._id ?? null)) return;

    const prevId: Id<"guestTeams"> | null = ticket.guestTeamId ?? null;
    if (prevId) {
      const prev = await ctx.db.get(prevId);
      if (prev) {
        await ctx.db.patch(prev._id, {
          assignedCount: Math.max(0, prev.assignedCount - 1),
        });
      }
    }
    if (next) {
      await ctx.db.patch(next._id, { assignedCount: next.assignedCount + 1 });
    }
    await ctx.db.patch(ticketId, {
      guestTeamId: next ? next._id : undefined,
    });
  },
});
