/**
 * Leadership dashboard — chapter-level rollups.
 *
 * One query that aggregates the headline numbers for the chapter: upcoming load,
 * average readiness, roster size, recent throughput, and the next event.
 */
import { query } from "./_generated/server";
import { v } from "convex/values";
import { computeReadiness, DAY_MS } from "@events-os/shared";
import { requireChapterId } from "./lib/context";

/** Chapter-level leadership summary. */
export const summary = query({
  args: {},
  handler: async (ctx) => {
    const chapterId = await requireChapterId(ctx);
    const now = Date.now();

    const events = await ctx.db
      .query("events")
      .withIndex("by_chapter", (q: any) => q.eq("chapterId", chapterId))
      .collect();

    const upcoming = events
      .filter((e: any) => e.eventDate >= now && e.status !== "cancelled")
      .sort((a: any, b: any) => a.eventDate - b.eventDate);

    // Per-upcoming-event readiness.
    const readinessByEvent = await Promise.all(
      upcoming.map(async (event: any) => {
        const tasks = await ctx.db
          .query("tasks")
          .withIndex("by_event", (q: any) => q.eq("eventId", event._id))
          .collect();
        const done = tasks.filter((t: any) => t.status === "done").length;
        return computeReadiness(tasks.length, done);
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
