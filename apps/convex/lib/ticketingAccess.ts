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
 * Access is granted ANY of three ways, all equally sufficient:
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
 *   3. DOOR GRANT — an active `doorGrants` row for THIS event matches the
 *      caller's email (`doorAccess.ts` — granted from the event page).
 *      Checked MEMBERSHIP-FREE, before the member paths: the grantee is
 *      usually an outside volunteer with no chapter and no `people` row,
 *      whose chapterlessness is exactly what keeps them out of every other
 *      member surface. Requires `requireAccess` (domain or allowlist) like
 *      everything else.
 *
 * Superuser bypasses all three, per the bootstrap path mirrored across the
 * repo.
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
import { getUserEmail, normalizeEmail, requireAccess } from "./access";

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
 * The active `doorGrants` row for `(eventId, email)`, or null. The probe
 * email is normalized the same way grants are stored
 * (`lib/access.ts#normalizeEmail`), so callers may pass a raw auth email.
 */
export async function activeDoorGrantFor(
  ctx: QueryCtx,
  eventId: Id<"events">,
  email: string | null | undefined,
): Promise<Doc<"doorGrants"> | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const grant = await ctx.db
    .query("doorGrants")
    .withIndex("by_event_email", (q) =>
      q.eq("eventId", eventId).eq("email", normalized),
    )
    .first();
  return grant && grant.isActive !== false ? grant : null;
}

/** True iff `email` holds ANY active door grant — drives `profiles.me`'s
 *  `doorOnly` flag (a chapterless-but-allowed account with a grant gets the
 *  door-mode shell instead of onboarding). Bounded: one volunteer's grants,
 *  not a table scan. */
export async function hasAnyActiveDoorGrant(
  ctx: QueryCtx,
  email: string | null | undefined,
): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const grants = await ctx.db
    .query("doorGrants")
    .withIndex("by_email", (q) => q.eq("email", normalized))
    .collect();
  return grants.some((g) => g.isActive !== false);
}

/**
 * Assert the caller may check guests in at `eventId` — superuser, OR an
 * active door grant for their email on THIS event, OR holds `events.checkin`
 * at the event's chapter (any of their `people` rows), OR holds a
 * `roleAssignments` row for this specific event (any of their `people` rows,
 * any role). Returns the event so the call site needs no second lookup.
 *
 * The door-grant path runs BEFORE `requireEvent` because that gate resolves
 * the caller's chapter (`requireChapterId`) and a door volunteer has none —
 * `NO_CHAPTER` would win before the grant was ever read. `requireAccess`
 * still applies to the door path; with no grant the flow falls through to
 * `requireEvent` unchanged, so members keep the exact errors they had
 * (`NOT_FOUND` for a bad/foreign event id, then FORBIDDEN).
 */
export async function requireCheckInAccess(
  ctx: QueryCtx,
  eventId: Id<"events">,
): Promise<Doc<"events">> {
  await requireAccess(ctx);
  const doorGrant = await activeDoorGrantFor(ctx, eventId, await getUserEmail(ctx));
  if (doorGrant) {
    const granted = await ctx.db.get(eventId);
    if (granted) return granted;
  }

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

/**
 * Assert the caller may MANAGE door grants for `eventId` (grant/revoke/list —
 * `doorAccess.ts`). Today: any signed-in member of the event's chapter — the
 * same bare gate `roleAssignments.assign` uses to staff an event, and
 * deliberately NOT `requireCheckInAccess` (door volunteers hold check-in but
 * must never grant it onward). Per CLAUDE.md's "gate it behind a power" rule
 * this resolver exists so the restriction can graduate to a named
 * `events.door.manage` seat capability by changing THIS body only — no
 * call-site churn.
 */
export async function requireDoorGrantManage(
  ctx: QueryCtx,
  eventId: Id<"events">,
): Promise<Doc<"events">> {
  return await requireEvent(ctx, eventId);
}
