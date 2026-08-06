/**
 * Access gate for the door check-in action (`ticketing.ts#checkInTicket`) —
 * narrower than the bare `requireEvent` gate every OTHER ticketing admin
 * query/mutation still uses (the Tickets tab's page setup, ticket types,
 * guest list, orders). "Who can admit guests at the door" is a real,
 * asked-for restriction (see the door-check-in-flow spec), so this file
 * follows `lib/campaignsAccess.ts`'s pattern: a named, event-scoped resolver
 * with a throwing + soft pair, mirroring that file's `requireBlastSend`/
 * `hasBlastSend` (the closest analogue — event-scoped, not central-scoped).
 *
 * Access is granted EITHER way, both equally sufficient:
 *
 *   1. GRANTED — the caller holds the `events.checkin` seat capability at
 *      the event's own chapter (`lib/seats.ts#holdsCheckInSeatAt`). This is
 *      "we've given this signed-in person access," expressed through the
 *      existing seat-assignment UI — no new grant mechanism. Default holders
 *      (`packages/shared/src/seats.ts#SEAT_DEFS`): `chapter_director`,
 *      `event_lead`, `event_organizers`, `production_coordinator`.
 *   2. ASSIGNED — the caller holds a `roleAssignments` row for THIS
 *      SPECIFIC event (any role) — "the assigned public worship team on the
 *      event page" (`schema/events.ts#roleAssignments`), already how a
 *      chapter staffs an event.
 *
 * Superuser bypasses both, per the bootstrap path mirrored across the repo.
 * The caller's people rows are resolved the same "union across every
 * non-placeholder `people` row the userId owns" way `campaignsAccess.ts`'s
 * `ownPeopleRows` does — a person can hold more than one roster row, and any
 * one of them carrying the seat or the event assignment is enough.
 */
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { holdsCheckInSeatAt } from "./seats";
import { isSuperuser } from "./superuser";
import { requireEvent, requireUserId } from "./context";

/** Bound on how many seat assignments / role assignments a single person can
 *  hold — mirrors `lib/campaignsAccess.ts#PERSON_SEAT_ASSIGNMENT_LIMIT` /
 *  `lib/seats.ts#holdsApprovalSeatAt`. */
const PERSON_SEAT_ASSIGNMENT_LIMIT = 200;

/** Every non-placeholder `people` row the caller's userId owns — see
 *  `campaignsAccess.ts`'s `ownPeopleRows` (same shape, copied locally so this
 *  file has no cross-module coupling for a three-line query). */
async function ownPeopleRows(ctx: QueryCtx): Promise<Doc<"people">[]> {
  const userId = (await requireUserId(ctx)) as Id<"users">;
  const people = await ctx.db
    .query("people")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return people.filter((p) => p.isPlaceholder !== true);
}

/**
 * Assert the caller may check guests in at `eventId` — superuser, OR holds
 * `events.checkin` at the event's chapter (any of their `people` rows), OR
 * holds a `roleAssignments` row for this specific event (any of their
 * `people` rows, any role). Returns the event so the call site needs no
 * second lookup. Calls `requireEvent` FIRST so a bad/foreign event id throws
 * its own `NOT_FOUND` before the access check runs.
 */
export async function requireCheckInAccess(
  ctx: QueryCtx,
  eventId: Id<"events">,
): Promise<Doc<"events">> {
  const event = await requireEvent(ctx, eventId);

  if (await isSuperuser(ctx)) return event;

  const people = await ownPeopleRows(ctx);

  for (const person of people) {
    if (await holdsCheckInSeatAt(ctx, person._id, event.chapterId)) return event;
  }

  const personIds = new Set(people.map((p) => p._id));
  if (personIds.size > 0) {
    const assignments = await ctx.db
      .query("roleAssignments")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .take(PERSON_SEAT_ASSIGNMENT_LIMIT);
    if (assignments.some((a) => personIds.has(a.personId))) return event;
  }

  throw new ConvexError({
    code: "FORBIDDEN",
    message:
      "Door access needed — ask an event lead to add you to this event's team, or grant your seat check-in access.",
  });
}

/** Soft, non-throwing form of `requireCheckInAccess` — for a passively
 *  rendered gate like `myCheckInAccess`. Derived from the throwing form on
 *  purpose: there is exactly one body to change if this gate ever widens. */
export async function hasCheckInAccess(
  ctx: QueryCtx,
  eventId: Id<"events">,
): Promise<boolean> {
  try {
    await requireCheckInAccess(ctx, eventId);
    return true;
  } catch {
    return false;
  }
}
