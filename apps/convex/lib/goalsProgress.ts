/**
 * Key-result progress, read from the real record at query time.
 *
 * Automatic measures never store their number: a seat-filled result counts
 * `seatAssignments` made since it started watching the seat (a holder already
 * seated before then isn't the recruit the plan asks for), an event-count result counts completed `events` now,
 * so the Goals screen can't drift from the org chart or the calendar. Manual
 * measures use the number someone typed (`current`).
 */
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { deriveKeyResultProgress, type KeyResultStatus } from "@events-os/shared";

export interface KeyResultProgress {
  current: number | null;
  target: number | null;
  fraction: number | null;
  met: boolean;
  /** The stored status, or "done" when an automatic measure is met. */
  displayStatus: KeyResultStatus;
}

/** The first and last instant of a plan's year (UTC; plans are whole years). */
export function planYearBounds(year: number): { start: number; end: number } {
  return { start: Date.UTC(year, 0, 1), end: Date.UTC(year + 1, 0, 1) };
}

async function seatHolderCount(ctx: QueryCtx, kr: Doc<"goalKeyResults">): Promise<number> {
  const { seatSlug, seatScope: scope } = kr;
  if (!seatSlug || !scope) return 0;
  const def = await ctx.db
    .query("seatDefs")
    .withIndex("by_slug", (q) => q.eq("slug", seatSlug))
    .first();
  if (!def) return 0;
  const rows = await ctx.db
    .query("seatAssignments")
    .withIndex("by_scope_and_seat", (q) => q.eq("scope", scope).eq("seatDefId", def._id))
    .take(100);
  const since = kr.seatWatchSince ?? kr._creationTime;
  return rows.filter((r) => r.createdAt >= since).length;
}

async function completedEventCount(
  ctx: QueryCtx,
  kr: Doc<"goalKeyResults">,
  year: number,
): Promise<number> {
  const { start, end } = planYearBounds(year);
  let n = 0;
  for (const eventTypeId of kr.eventTypeIds ?? []) {
    const rows = await ctx.db
      .query("events")
      .withIndex("by_eventType", (q) => q.eq("eventTypeId", eventTypeId))
      .take(1000);
    for (const e of rows) {
      if (e.status !== "completed") continue;
      if (e.eventDate < start || e.eventDate >= end) continue;
      if (kr.eventChapterId && e.chapterId !== kr.eventChapterId) continue;
      n++;
    }
  }
  return n;
}

export async function keyResultProgress(
  ctx: QueryCtx,
  kr: Doc<"goalKeyResults">,
  planYear: number,
): Promise<KeyResultProgress> {
  let current: number | null = kr.current ?? null;
  let target: number | null = kr.target ?? null;
  const automatic = kr.measureKind !== "manual";
  if (kr.measureKind === "seat_filled" && kr.seatSlug) {
    current = await seatHolderCount(ctx, kr);
    target = target ?? 1;
  } else if (kr.measureKind === "event_count") {
    current = await completedEventCount(ctx, kr, planYear);
  }
  const { fraction, met } = deriveKeyResultProgress(current ?? undefined, target ?? undefined);
  return {
    current,
    target,
    fraction,
    met,
    displayStatus: automatic && met ? "done" : kr.status,
  };
}
