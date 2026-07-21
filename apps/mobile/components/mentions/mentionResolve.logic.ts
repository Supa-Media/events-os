/**
 * Resolves a parsed mention token to "who to link to, right now."
 *
 * A person mention resolves directly by id. A role (seat) mention has no
 * stored person id at all — it resolves by looking up the seat's CURRENT
 * holder in `chapterSeatHoldings`, so the same note keeps pointing at
 * whoever holds the seat as it changes hands, with no edit to the note
 * required. Both `people` and `seatHoldings` are data the Duties grid
 * already fetches for its own rendering — this is a pure lookup against
 * data already on the client, not a new Convex query.
 */
import type { MentionToken } from "@events-os/shared";

export type ResolvedMention = { personId: string; displayName: string };

export function resolveMentionToken(
  token: MentionToken,
  data: {
    people: { _id: string; name: string }[];
    seatHoldings: { personId: string; seatDefId: string }[];
  },
): ResolvedMention | null {
  const personId =
    token.type === "person"
      ? token.id
      : data.seatHoldings.find((h) => h.seatDefId === token.id)?.personId;
  if (!personId) return null;
  const person = data.people.find((p) => p._id === personId);
  return person ? { personId, displayName: person.name } : null;
}
