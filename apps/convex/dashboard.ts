/**
 * Leadership dashboard — chapter-level rollups.
 *
 * One query that aggregates the headline numbers for the chapter: upcoming load,
 * average readiness, roster size, recent throughput, and the next event.
 */
import { query } from "./_generated/server";
import { v } from "convex/values";
import { computeReadiness, isCompleteStatus, DAY_MS } from "@events-os/shared";
import { getChapterIdOrNull } from "./lib/context";

const EMPTY = {
  upcomingCount: 0,
  avgReadiness: 0,
  peopleCount: 0,
  eventsLast90Days: 0,
  nextEvent: null as {
    name: string;
    eventDate: number;
    readiness: number;
  } | null,
};

/** Chapter-level leadership summary. */
export const summary = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return EMPTY;
    const now = Date.now();

    const events = await ctx.db
      .query("events")
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", chapterId))
      .collect();

    const upcoming = events
      .filter((e: any) => e.eventDate >= now && e.status !== "cancelled")
      .sort((a: any, b: any) => a.eventDate - b.eventDate);

    // Per-upcoming-event readiness, off the planning-doc module.
    const readinessByEvent = await Promise.all(
      upcoming.map(async (event: any) => {
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
        const done = items.filter((it: any) =>
          isCompleteStatus(opts, it.status),
        ).length;
        return computeReadiness(items.length, done);
      }),
    );
    const avgReadiness =
      readinessByEvent.length > 0
        ? Math.round(
            readinessByEvent.reduce((sum, r) => sum + r, 0) /
              readinessByEvent.length,
          )
        : 0;

    const people = await ctx.db
      .query("people")
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", chapterId))
      .collect();

    const ninetyDaysAgo = now - 90 * DAY_MS;
    const eventsLast90Days = events.filter(
      (e: any) => e.eventDate >= ninetyDaysAgo && e.eventDate < now,
    ).length;

    const nextEvent =
      upcoming.length > 0
        ? {
            name: upcoming[0].name,
            eventDate: upcoming[0].eventDate,
            readiness: readinessByEvent[0],
          }
        : null;

    return {
      upcomingCount: upcoming.length,
      avgReadiness,
      peopleCount: people.length,
      eventsLast90Days,
      nextEvent,
    };
  },
});
