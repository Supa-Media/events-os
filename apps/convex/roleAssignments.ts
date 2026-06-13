/**
 * Role assignments — who holds which role on an event.
 *
 * Rotatable (one person per role per event). The history across events surfaces
 * burnout and rotation opportunities. References a role by id (`roles` table),
 * scoped to the event's active roles.
 */
import { query, mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireChapterId, requireInChapter } from "./lib/context";

/** Every active role on an event's type, each with its assigned person (or null). */
export const listForEvent = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    const eventType = await ctx.db.get(event!.eventTypeId);
    const roleIds: Id<"roles">[] = eventType?.activeRoleIds ?? [];

    const assignments = await ctx.db
      .query("roleAssignments")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();

    return await Promise.all(
      roleIds.map(async (roleId) => {
        const role = await ctx.db.get(roleId);
        const assignment = assignments.find(
          (a: any) => a.roleId === roleId,
        );
        const person = assignment ? await ctx.db.get(assignment.personId) : null;
        return {
          roleId,
          roleLabel: role?.label ?? "Unknown role",
          person: person ? { _id: person._id, name: person.name } : null,
        };
      }),
    );
  },
});

/** Upsert a role's assignment (one person per role; replaces any existing). */
export const assign = mutation({
  args: {
    eventId: v.id("events"),
    roleId: v.id("roles"),
    personId: v.id("people"),
  },
  handler: async (ctx, { eventId, roleId, personId }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    const person = await ctx.db.get(personId);
    await requireInChapter(ctx, chapterId, person, "Person");

    const existing = await ctx.db
      .query("roleAssignments")
      .withIndex("by_event_role", (q: any) =>
        q.eq("eventId", eventId).eq("roleId", roleId),
      )
      .collect();
    for (const a of existing) await ctx.db.delete(a._id);

    return await ctx.db.insert("roleAssignments", {
      eventId,
      chapterId: chapterId as Id<"chapters">,
      roleId,
      personId,
      createdAt: Date.now(),
    });
  },
});

/** Clear a role's assignment on an event. */
export const unassign = mutation({
  args: { eventId: v.id("events"), roleId: v.id("roles") },
  handler: async (ctx, { eventId, roleId }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    const existing = await ctx.db
      .query("roleAssignments")
      .withIndex("by_event_role", (q: any) =>
        q.eq("eventId", eventId).eq("roleId", roleId),
      )
      .collect();
    for (const a of existing) await ctx.db.delete(a._id);
    return eventId;
  },
});

/** A person's past role assignments with event name + date, for rotation view. */
export const historyForPerson = query({
  args: { personId: v.id("people") },
  handler: async (ctx, { personId }) => {
    const chapterId = await requireChapterId(ctx);
    const person = await ctx.db.get(personId);
    await requireInChapter(ctx, chapterId, person, "Person");

    const assignments = await ctx.db
      .query("roleAssignments")
      .withIndex("by_person", (q: any) => q.eq("personId", personId))
      .collect();

    const history = await Promise.all(
      assignments.map(async (a: any) => {
        const event = await ctx.db.get(a.eventId as Id<"events">);
        const role = await ctx.db.get(a.roleId as Id<"roles">);
        return {
          _id: a._id,
          roleId: a.roleId,
          roleLabel: role?.label ?? "Unknown role",
          eventId: a.eventId,
          eventName: event?.name ?? "Unknown",
          eventDate: event?.eventDate ?? 0,
        };
      }),
    );
    return history.sort((x, y) => y.eventDate - x.eventDate);
  },
});
