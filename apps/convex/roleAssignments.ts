/**
 * Role assignments — who holds which role on an event.
 *
 * Rotatable (one person per role per event). The history across events surfaces
 * burnout and rotation opportunities. References a role by id (`eventRoles`
 * table), scoped to the event's own roles.
 */
import { query, mutation } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireEvent, requireOwned } from "./lib/context";

/** Every role on an event, each with its assigned person (or null). */
export const listForEvent = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    await requireEvent(ctx, eventId);

    const roles = (
      await ctx.db
        .query("eventRoles")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect()
    ).sort((a, b) => a.order - b.order);

    const assignments = await ctx.db
      .query("roleAssignments")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();
    // Build a roleId → assignment map once (O(n)), not a `.find` per role (O(n²)).
    const assignmentByRole = new Map<string, Doc<"roleAssignments">>(
      assignments.map((a) => [String(a.roleId), a]),
    );

    return await Promise.all(
      roles.map(async (role) => {
        const assignment = assignmentByRole.get(String(role._id));
        const person = assignment ? await ctx.db.get(assignment.personId) : null;
        return {
          roleId: role._id as Id<"eventRoles">,
          roleLabel: role.label ?? "Unknown role",
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
    roleId: v.id("eventRoles"),
    personId: v.id("people"),
  },
  handler: async (ctx, { eventId, roleId, personId }) => {
    const event = await requireEvent(ctx, eventId);
    await requireOwned(ctx, "people", personId, "Person");

    const existing = await ctx.db
      .query("roleAssignments")
      .withIndex("by_event_role", (q) =>
        q.eq("eventId", eventId).eq("roleId", roleId),
      )
      .collect();
    for (const a of existing) await ctx.db.delete(a._id);

    return await ctx.db.insert("roleAssignments", {
      eventId,
      chapterId: event.chapterId,
      roleId,
      personId,
      createdAt: Date.now(),
    });
  },
});

/** Clear a role's assignment on an event. */
export const unassign = mutation({
  args: { eventId: v.id("events"), roleId: v.id("eventRoles") },
  handler: async (ctx, { eventId, roleId }) => {
    await requireEvent(ctx, eventId);
    const existing = await ctx.db
      .query("roleAssignments")
      .withIndex("by_event_role", (q) =>
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
    await requireOwned(ctx, "people", personId, "Person");

    const assignments = await ctx.db
      .query("roleAssignments")
      .withIndex("by_person", (q) => q.eq("personId", personId))
      .collect();

    const history = await Promise.all(
      assignments.map(async (a) => {
        const event = await ctx.db.get(a.eventId as Id<"events">);
        const role = await ctx.db.get(a.roleId as Id<"eventRoles">);
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
