/**
 * Events — dated instances of an event type.
 *
 * The core object the app revolves around. Created from a template by cloning
 * its columns + items as snapshots (so later template edits never disrupt an
 * in-flight event). Day-offset modules back-calculate every item's due date from
 * the single event date; moving the date shifts the whole timeline.
 */
import { query, mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  computeDueDate,
  computeReadiness,
  isCompleteStatus,
  DAY_OFFSET_MODULES,
  type ModuleKey,
} from "@events-os/shared";
import {
  requireUserId,
  requireChapterId,
  requireInChapter,
  getChapterIdOrNull,
} from "./lib/context";
import { instantiateEvent } from "./lib/templates";
import { paidTotalForEvent } from "./engagements";

const statusUnion = v.union(
  v.literal("planning"),
  v.literal("ready"),
  v.literal("completed"),
  v.literal("cancelled"),
);

function isDayOffsetModule(module: string): boolean {
  return DAY_OFFSET_MODULES.includes(module as ModuleKey);
}

/**
 * Per-event readiness off the planning-doc module: complete items / total,
 * using that event's planning-doc status column to decide "complete".
 */
async function eventReadiness(ctx: any, eventId: Id<"events">) {
  const items = await ctx.db
    .query("eventItems")
    .withIndex("by_event_module", (q: any) =>
      q.eq("eventId", eventId).eq("module", "planning_doc"),
    )
    .collect();
  const statusCol = await ctx.db
    .query("eventColumns")
    .withIndex("by_event_module", (q: any) =>
      q.eq("eventId", eventId).eq("module", "planning_doc"),
    )
    .filter((q: any) => q.eq(q.field("key"), "status"))
    .first();
  const opts = statusCol?.options;
  const total = items.length;
  const done = items.filter((it: any) => isCompleteStatus(opts, it.status)).length;
  return { total, done, readiness: computeReadiness(total, done) };
}

/**
 * THE TEMPLATING ENGINE. Snapshot a template into a live event: clone its
 * columns onto the event, then clone its items (back-calculating due dates for
 * day-offset modules). Supplies items keep their template's acquisition status,
 * which IS the "what do we still need" reset; tasks/comms start at their status
 * column's first option.
 */
export const createFromTemplate = mutation({
  args: {
    eventTypeId: v.id("eventTypes"),
    name: v.string(),
    eventDate: v.number(),
    location: v.optional(v.string()),
    budget: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    const userId = await requireUserId(ctx);
    const eventType = await ctx.db.get(args.eventTypeId);
    await requireInChapter(ctx, chapterId, eventType, "Event type");

    return await instantiateEvent(ctx, {
      eventType,
      chapterId: chapterId as Id<"chapters">,
      userId: userId as Id<"users">,
      name: args.name,
      eventDate: args.eventDate,
      location: args.location,
      budget: args.budget,
    });
  },
});

/** List chapter events (default upcoming) with readiness + task counts. */
export const list = query({
  args: {
    scope: v.optional(v.union(v.literal("upcoming"), v.literal("all"))),
  },
  handler: async (ctx, { scope }) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const now = Date.now();
    const all = await ctx.db
      .query("events")
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", chapterId))
      .collect();
    const filtered =
      scope === "all"
        ? all
        : all.filter(
            (e: any) => e.eventDate >= now && e.status !== "cancelled",
          );

    const enriched = await Promise.all(
      filtered.map(async (event: any) => {
        const eventType = await ctx.db.get(event.eventTypeId as Id<"eventTypes">);
        const r = await eventReadiness(ctx, event._id);
        return {
          ...event,
          eventTypeName: eventType?.name ?? "Unknown",
          readiness: r.readiness,
          taskTotal: r.total,
          taskDone: r.done,
        };
      }),
    );
    return enriched.sort((a, b) => a.eventDate - b.eventDate);
  },
});

/** Fetch a single event plus its event-type name + readiness. */
export const get = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    if (!event || event.chapterId !== chapterId) return null;
    const eventType = await ctx.db.get(event.eventTypeId as Id<"eventTypes">);
    const r = await eventReadiness(ctx, eventId);

    // Roll up every item's `cost` field against the event budget.
    const allItems = await ctx.db
      .query("eventItems")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    const itemCost = allItems.reduce((sum: number, it: any) => {
      const c = Number(it.fields?.cost);
      return sum + (Number.isFinite(c) ? c : 0);
    }, 0);
    // Paid vendors count against the budget too.
    const paidVendorCost = await paidTotalForEvent(ctx, eventId);
    const budgetSpent = itemCost + paidVendorCost;
    const budget = event.budget ?? 0;
    const budgetPct = budget > 0 ? Math.round((budgetSpent / budget) * 100) : 0;

    // Resolve the accountable owner (a person) for display.
    let owner: { _id: Id<"people">; name: string } | null = null;
    if (event.ownerPersonId) {
      const person = await ctx.db.get(event.ownerPersonId as Id<"people">);
      if (person) owner = { _id: person._id, name: person.name };
    }

    return {
      event,
      eventTypeName: eventType?.name ?? "Unknown",
      activeComponents: eventType?.activeComponents ?? [],
      owner,
      readiness: r.readiness,
      taskTotal: r.total,
      taskDone: r.done,
      budgetSpent,
      budgetPct,
    };
  },
});

/**
 * PUBLIC, no-auth volunteer briefing for an event — reachable by share link.
 *
 * Intentionally public-by-link: it does NOT call requireChapterId/requireUserId,
 * so a logged-out caller can load it. It returns a sanitized, volunteer-facing
 * payload ONLY — teams, their expectations, and who's on each team. No payment,
 * vendor, or budget ($) information is ever included.
 */
export const publicCrew = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get(eventId);
    if (!event) return null;

    // Team options come from the volunteer_expectations "team" column.
    const teamCol = await ctx.db
      .query("eventColumns")
      .withIndex("by_event_module", (q: any) =>
        q.eq("eventId", eventId).eq("module", "volunteer_expectations"),
      )
      .filter((q: any) => q.eq(q.field("key"), "team"))
      .first();
    const teamOptions: { value: string; label: string; color?: string | null }[] =
      teamCol?.options ?? [];
    const knownTeams = new Set(teamOptions.map((o) => o.value));

    // Expectations = volunteer_expectations items, grouped by fields.team.
    const expectationItems = await ctx.db
      .query("eventItems")
      .withIndex("by_event_module", (q: any) =>
        q.eq("eventId", eventId).eq("module", "volunteer_expectations"),
      )
      .collect();
    const toExpectation = (it: any) => ({
      title: it.title ?? "",
      details:
        typeof it.fields?.details === "string" ? it.fields.details : null,
    });

    // People = volunteer engagements, person name resolved, grouped by team.
    const volunteers = await ctx.db
      .query("engagements")
      .withIndex("by_event_type", (q: any) =>
        q.eq("eventId", eventId).eq("type", "volunteer"),
      )
      .collect();
    const people = await Promise.all(
      volunteers.map(async (e: any) => {
        const person = await ctx.db.get(e.personId as Id<"people">);
        return {
          teams: Array.isArray(e.teams) ? (e.teams as string[]) : [],
          name: person?.name ?? "Unknown",
          callTime: e.callTime ?? null,
          status: e.status ?? null,
        };
      }),
    );

    const teams = teamOptions.map((opt) => ({
      value: opt.value,
      label: opt.label,
      color: opt.color ?? null,
      expectations: expectationItems
        .filter((it: any) => it.fields?.team === opt.value)
        .map(toExpectation),
      people: people
        .filter((p) => p.teams.includes(opt.value))
        .map(({ name, callTime, status }) => ({ name, callTime, status })),
    }));

    // Anything whose team isn't a known option → the unassigned bucket.
    const unassigned = {
      expectations: expectationItems
        .filter((it: any) => {
          const t = it.fields?.team;
          return typeof t !== "string" || !t || !knownTeams.has(t);
        })
        .map(toExpectation),
      people: people
        .filter((p) => !p.teams.some((t) => knownTeams.has(t)))
        .map(({ name, callTime, status }) => ({ name, callTime, status })),
    };

    return {
      name: event.name,
      eventDate: event.eventDate,
      location: event.location ?? null,
      teams,
      unassigned,
    };
  },
});

/** Move an event's date and re-derive every day-offset item's due date. */
export const reschedule = mutation({
  args: { eventId: v.id("events"), eventDate: v.number() },
  handler: async (ctx, { eventId, eventDate }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    await ctx.db.patch(eventId, { eventDate, updatedAt: Date.now() });
    const items = await ctx.db
      .query("eventItems")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    for (const it of items) {
      if (isDayOffsetModule(it.module) && it.offsetDays !== undefined) {
        await ctx.db.patch(it._id, {
          dueDate: computeDueDate(eventDate, it.offsetDays),
        });
      }
    }
    return eventId;
  },
});

/** Edit an event's top-level fields (name, location, budget, owner). */
export const updateDetails = mutation({
  args: {
    eventId: v.id("events"),
    name: v.optional(v.string()),
    location: v.optional(v.union(v.string(), v.null())),
    budget: v.optional(v.union(v.number(), v.null())),
    ownerPersonId: v.optional(v.union(v.id("people"), v.null())),
  },
  handler: async (ctx, { eventId, ...patch }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    if (patch.ownerPersonId) {
      const person = await ctx.db.get(patch.ownerPersonId);
      await requireInChapter(ctx, chapterId, person, "Person");
    }
    const fields: Record<string, unknown> = { updatedAt: Date.now() };
    if (patch.name !== undefined) fields.name = patch.name;
    if (patch.location !== undefined) fields.location = patch.location ?? undefined;
    if (patch.budget !== undefined) fields.budget = patch.budget ?? undefined;
    if (patch.ownerPersonId !== undefined)
      fields.ownerPersonId = patch.ownerPersonId ?? undefined;
    await ctx.db.patch(eventId, fields);
    return eventId;
  },
});

/** Set an event's lifecycle status. */
export const setStatus = mutation({
  args: { eventId: v.id("events"), status: statusUnion },
  handler: async (ctx, { eventId, status }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    await requireInChapter(ctx, chapterId, event, "Event");
    await ctx.db.patch(eventId, { status, updatedAt: Date.now() });
    return eventId;
  },
});

/** Delete an event and all its columns, items, and role assignments. */
export const remove = mutation({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    await requireInChapter(ctx, chapterId, event, "Event");

    const items = await ctx.db
      .query("eventItems")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    for (const it of items) await ctx.db.delete(it._id);

    const cols = await ctx.db
      .query("eventColumns")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    for (const c of cols) await ctx.db.delete(c._id);

    const assignments = await ctx.db
      .query("roleAssignments")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    for (const a of assignments) await ctx.db.delete(a._id);

    await ctx.db.delete(eventId);
    return eventId;
  },
});

/** Upcoming events with readiness + blocker count, for the pipeline dashboard. */
export const pipeline = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const now = Date.now();
    const all = await ctx.db
      .query("events")
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", chapterId))
      .collect();
    const upcoming = all.filter(
      (e: any) => e.eventDate >= now && e.status !== "cancelled",
    );

    const enriched = await Promise.all(
      upcoming.map(async (event: any) => {
        const eventType = await ctx.db.get(event.eventTypeId as Id<"eventTypes">);
        const items = await ctx.db
          .query("eventItems")
          .withIndex("by_event_module", (q: any) =>
            q.eq("eventId", event._id).eq("module", "planning_doc"),
          )
          .collect();
        const statusCol = await ctx.db
          .query("eventColumns")
          .withIndex("by_event_module", (q: any) =>
            q.eq("eventId", event._id).eq("module", "planning_doc"),
          )
          .filter((q: any) => q.eq(q.field("key"), "status"))
          .first();
        const opts = statusCol?.options;
        const total = items.length;
        const done = items.filter((it: any) =>
          isCompleteStatus(opts, it.status),
        ).length;
        const blockerCount = items.filter(
          (it: any) =>
            !isCompleteStatus(opts, it.status) &&
            it.dueDate !== undefined &&
            it.dueDate < now,
        ).length;
        return {
          ...event,
          eventTypeName: eventType?.name ?? "Unknown",
          readiness: computeReadiness(total, done),
          taskTotal: total,
          taskDone: done,
          blockerCount,
        };
      }),
    );
    return enriched.sort((a, b) => a.eventDate - b.eventDate);
  },
});

/** Mobile day-of view: event, run-of-show, role holders, and tasks. */
export const dayOf = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const chapterId = await requireChapterId(ctx);
    const event = await ctx.db.get(eventId);
    if (!event || event.chapterId !== chapterId) return null;
    const eventType = await ctx.db.get(event.eventTypeId as Id<"eventTypes">);

    const runOfShow = (
      await ctx.db
        .query("eventItems")
        .withIndex("by_event_module", (q: any) =>
          q.eq("eventId", eventId).eq("module", "run_of_show"),
        )
        .collect()
    ).sort((a: any, b: any) => a.order - b.order);

    const roleIds: Id<"roles">[] = eventType?.activeRoleIds ?? [];
    const assignments = await ctx.db
      .query("roleAssignments")
      .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
      .collect();
    const roles = await Promise.all(
      roleIds.map(async (roleId) => {
        const role = await ctx.db.get(roleId);
        const assignment = assignments.find((a: any) => a.roleId === roleId);
        const person = assignment ? await ctx.db.get(assignment.personId) : null;
        return {
          roleId,
          roleLabel: role?.label ?? "Unknown role",
          person: person ? { _id: person._id, name: person.name } : null,
        };
      }),
    );

    // Day-of view shows only what's imminent: tasks from T-2 onwards (and any
    // undated tasks). Earlier prep tasks (T-14, T-7…) are hidden here.
    const tasks = (
      await ctx.db
        .query("eventItems")
        .withIndex("by_event_module", (q: any) =>
          q.eq("eventId", eventId).eq("module", "planning_doc"),
        )
        .collect()
    )
      .filter((t: any) => t.offsetDays == null || t.offsetDays >= -2)
      .sort((a: any, b: any) => (a.dueDate ?? 0) - (b.dueDate ?? 0));

    return {
      event,
      eventTypeName: eventType?.name ?? "Unknown",
      runOfShow,
      roles,
      tasks,
    };
  },
});
