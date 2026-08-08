/**
 * Pure logic behind `AttendeeCheckInList` — the search filter, the checked-in
 * progress tally, and the per-team standings. Extracted so it's testable (this
 * app tests pure helpers, not components — see `ticketScan.test.ts`'s doc
 * comment).
 */

/** One row of `api.ticketing.listCheckInAttendees` — VIEW-ONLY: the server
 *  deliberately withholds the ticket code (admission must prove possession
 *  of the ticket; the guest supplies their code, scanned or typed). */
export type DoorAttendee = {
  _id: string;
  attendeeName: string;
  ticketTypeName: string;
  status: "valid" | "checked_in" | "void";
  checkedInAt: number | null;
  /** The guest team assigned at check-in, when the event uses teams. Null
   *  before the guest arrives — teams are handed out at the door, not sold. */
  teamId: string | null;
  teamName: string | null;
  teamColor: string | null;
};

/**
 * Case-insensitive substring match on the attendee's name OR their team name.
 * Matching the team too turns the search box into "show me everyone on Blue",
 * which is what a door volunteer reaches for when a team needs rounding up.
 * An empty/whitespace query returns the full list.
 */
export function filterAttendees<
  T extends Pick<DoorAttendee, "attendeeName"> & Partial<Pick<DoorAttendee, "teamName">>,
>(attendees: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return attendees;
  return attendees.filter(
    (a) =>
      a.attendeeName.toLowerCase().includes(q) ||
      (a.teamName ?? "").toLowerCase().includes(q),
  );
}

/**
 * "12 of 49 checked in" — void tickets don't count toward either number
 * (they can't be admitted, so they'd make the door look forever short).
 */
export function checkInProgress(
  attendees: Pick<DoorAttendee, "status">[],
): { checkedIn: number; total: number } {
  const admittable = attendees.filter((a) => a.status !== "void");
  return {
    checkedIn: admittable.filter((a) => a.status === "checked_in").length,
    total: admittable.length,
  };
}

/** One team's live headcount, for the door's standings strip. */
export type TeamStanding = {
  teamId: string;
  name: string;
  color: string;
  count: number;
};

/**
 * Live headcount per team, biggest first, from the guest list itself.
 *
 * Derived from the rows rather than read off `guestTeams.assignedCount` so the
 * strip can't disagree with the list it sits above — this is the number a
 * volunteer sanity-checks the balance against, and two sources that drift
 * would be worse than none. Teams nobody has been assigned to yet are absent
 * by construction, which is correct for a door that's still filling up.
 *
 * Grouped by team ID, not by name. Names are meant to be unique (renaming
 * rejects a clash) but the id is the identity, so two rows that somehow share
 * a label still count as the two teams they actually are instead of silently
 * merging into one chip with a combined total.
 */
export function teamStandings(
  attendees: Pick<DoorAttendee, "teamId" | "teamName" | "teamColor">[],
): TeamStanding[] {
  const byId = new Map<string, TeamStanding>();
  for (const a of attendees) {
    if (!a.teamId || !a.teamName) continue;
    const existing = byId.get(a.teamId);
    if (existing) existing.count += 1;
    else
      byId.set(a.teamId, {
        teamId: a.teamId,
        name: a.teamName,
        color: a.teamColor ?? "",
        count: 1,
      });
  }
  return [...byId.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );
}
