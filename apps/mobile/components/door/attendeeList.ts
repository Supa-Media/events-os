/**
 * Pure logic behind `AttendeeCheckInList` — the search filter and the
 * checked-in progress tally. Extracted so it's testable (this app tests pure
 * helpers, not components — see `ticketScan.test.ts`'s doc comment).
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
};

/**
 * Case-insensitive substring match on the attendee's name. An
 * empty/whitespace query returns the full list.
 */
export function filterAttendees<T extends Pick<DoorAttendee, "attendeeName">>(
  attendees: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return attendees;
  return attendees.filter((a) => a.attendeeName.toLowerCase().includes(q));
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
