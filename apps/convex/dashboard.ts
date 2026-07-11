/**
 * Leadership dashboard — chapter-level rollups.
 *
 * One query that aggregates the headline numbers for the chapter: upcoming load,
 * average readiness, roster size, recent throughput, and the next event.
 */
import { query } from "./_generated/server";
import { currentPhase, DAY_MS, isOperationalEvent } from "@events-os/shared";
import { getChapterIdOrNull } from "./lib/context";
import { phaseReadiness } from "./lib/readiness";

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

    // Academy training sandboxes never count toward chapter operations.
    const events = (
      await ctx.db
        .query("events")
        .withIndex("by_chapter", (q: any) => q.eq("chapterId", chapterId))
        .collect()
    ).filter((e: any) => isOperationalEvent(e));

    const upcoming = events
      .filter((e: any) => e.eventDate >= now && e.status !== "cancelled")
      .sort((a: any, b: any) => a.eventDate - b.eventDate);

    // Per-upcoming-event readiness = that event's CURRENT-phase score (by date),
    // as a 0–100 integer. Events whose current phase has no items to measure
    // (null) are excluded from the average so they don't drag it to 0.
    const readinessByEvent = await Promise.all(
      upcoming.map(async (event: any) => {
        const phases = await phaseReadiness(ctx, event);
        const score = phases[currentPhase(event.eventDate, now)];
        return score == null ? null : Math.round(score * 100);
      }),
    );
    const measured = readinessByEvent.filter(
      (r): r is number => r != null,
    );
    const avgReadiness =
      measured.length > 0
        ? Math.round(
            measured.reduce((sum, r) => sum + r, 0) / measured.length,
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
            // Current-phase score of the soonest event (0 when unmeasured).
            readiness: readinessByEvent[0] ?? 0,
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
