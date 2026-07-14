import { describe, expect, test } from "vitest";
import {
  DEFAULT_COLUMNS,
  MINUTE_MS,
  RUN_OF_SHOW_FINAL_WINDOW_MS,
  computeDueDate,
  computeRunTime,
  isLocalMidnight,
  runOfShowSegmentEnd,
} from "@events-os/shared";
import { api } from "../_generated/api";
import { newT, run, setupChapter } from "./setup.helpers";
import { runBackfillRunOfShowDuration } from "../migrations/0019_backfill_run_of_show_duration";
import type { Id } from "../_generated/dataModel";

/**
 * Run of Show v1 — the start-time anchor + segment ranges.
 *
 * Covers the pure shared helpers (`isLocalMidnight`, `runOfShowSegmentEnd`), the
 * new `duration` default column, the reschedule re-anchoring (the path the
 * new-event start time and the Day-of "set start time" affordance both feed),
 * and the `0019` backfill migration.
 */

// ── Pure helpers ─────────────────────────────────────────────────────────────
describe("run of show helpers (shared)", () => {
  test("isLocalMidnight flags exactly 00:00 local, nothing else", () => {
    expect(isLocalMidnight(new Date(2026, 6, 27, 0, 0).getTime())).toBe(true);
    // One minute past midnight is NOT flagged.
    expect(isLocalMidnight(new Date(2026, 6, 27, 0, 1).getTime())).toBe(false);
    // A real evening start is not flagged.
    expect(isLocalMidnight(new Date(2026, 6, 27, 18, 30).getTime())).toBe(false);
  });

  test("runOfShowSegmentEnd: positive duration wins over the next start", () => {
    const start = new Date(2026, 6, 27, 18, 0).getTime();
    const nextStart = start + 60 * MINUTE_MS;
    expect(runOfShowSegmentEnd(start, 30, nextStart)).toBe(start + 30 * MINUTE_MS);
  });

  test("runOfShowSegmentEnd: absent/zero duration falls back to the next start", () => {
    const start = new Date(2026, 6, 27, 18, 0).getTime();
    const nextStart = start + 45 * MINUTE_MS;
    expect(runOfShowSegmentEnd(start, null, nextStart)).toBe(nextStart);
    expect(runOfShowSegmentEnd(start, 0, nextStart)).toBe(nextStart);
    expect(runOfShowSegmentEnd(start, undefined, nextStart)).toBe(nextStart);
  });

  test("runOfShowSegmentEnd: final row with no duration is capped, not open-ended", () => {
    const start = new Date(2026, 6, 27, 18, 0).getTime();
    expect(runOfShowSegmentEnd(start, null, null)).toBe(
      start + RUN_OF_SHOW_FINAL_WINDOW_MS,
    );
    // A final row WITH a duration still honors it.
    expect(runOfShowSegmentEnd(start, 20, null)).toBe(start + 20 * MINUTE_MS);
  });
});

// ── Duration column ──────────────────────────────────────────────────────────
describe("run_of_show duration column", () => {
  test("DEFAULT_COLUMNS carries a typed custom number `duration` column", () => {
    const dur = DEFAULT_COLUMNS.run_of_show?.find((c) => c.key === "duration");
    expect(dur).toBeDefined();
    expect(dur?.type).toBe("number");
    expect(dur?.kind).toBe("custom");
  });

  test("a fresh event's run_of_show grid is created with the duration column", async () => {
    const t = newT();
    const { as } = await setupChapter(t);
    const eventTypeId = (await as.mutation(api.eventTypes.create, {
      name: "Worship Night",
    })) as Id<"eventTypes">;
    const eventId = (await as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "Worship Night — August",
      eventDate: new Date(2026, 7, 1, 18, 0).getTime(),
    })) as Id<"events">;

    const cols = await run(t, async (ctx) =>
      ctx.db
        .query("eventColumns")
        .withIndex("by_event_module", (q) =>
          q.eq("eventId", eventId).eq("module", "run_of_show"),
        )
        .collect(),
    );
    const dur = cols.find((c) => c.key === "duration");
    expect(dur).toBeDefined();
    expect(dur?.type).toBe("number");
    expect(dur?.kind).toBe("custom");
  });
});

// ── Start-time anchor + reschedule ───────────────────────────────────────────
describe("event start time / reschedule", () => {
  test("createFromTemplate stores the chosen time-of-day, not midnight", async () => {
    const t = newT();
    const { as } = await setupChapter(t);
    const eventTypeId = (await as.mutation(api.eventTypes.create, {
      name: "Night",
    })) as Id<"eventTypes">;
    // The new-event form combines date + time into this timestamp.
    const evening = new Date(2026, 7, 1, 18, 30).getTime();
    const eventId = (await as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "N",
      eventDate: evening,
    })) as Id<"events">;

    const event = await run(t, (ctx) => ctx.db.get(eventId));
    expect(event?.eventDate).toBe(evening);
    expect(isLocalMidnight(event!.eventDate)).toBe(false);
  });

  test("reschedule re-anchors: day offsets re-derive, minute segments self-correct", async () => {
    const t = newT();
    const { as, chapterId } = await setupChapter(t);
    const eventTypeId = (await as.mutation(api.eventTypes.create, {
      name: "Night",
    })) as Id<"eventTypes">;
    // Simulate an OLD event created before start-times: anchored at midnight.
    const midnight = new Date(2026, 7, 1, 0, 0).getTime();
    const eventId = (await as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "N",
      eventDate: midnight,
    })) as Id<"events">;
    expect(isLocalMidnight(midnight)).toBe(true);

    const { rosId, taskId } = await run(t, async (ctx) => {
      const rosId = await ctx.db.insert("eventItems", {
        eventId,
        chapterId,
        module: "run_of_show",
        title: "Doors",
        order: 0,
        offsetMinutes: 15,
      });
      const taskId = await ctx.db.insert("eventItems", {
        eventId,
        chapterId,
        module: "planning_doc",
        title: "Book venue",
        order: 0,
        offsetDays: -7,
        dueDate: computeDueDate(midnight, -7),
      });
      return { rosId, taskId };
    });

    // Set a real start time (the Day-of "set start time" affordance reuses this).
    const evening = new Date(2026, 7, 1, 18, 30).getTime();
    await as.mutation(api.events.reschedule, { eventId, eventDate: evening });

    const { event, ros, task } = await run(t, async (ctx) => ({
      event: await ctx.db.get(eventId),
      ros: await ctx.db.get(rosId),
      task: await ctx.db.get(taskId),
    }));

    // Anchor moved and now carries a real time-of-day.
    expect(event?.eventDate).toBe(evening);
    expect(isLocalMidnight(event!.eventDate)).toBe(false);
    // A minute segment stores NO wall-clock — its offset is untouched and it
    // self-corrects off the new anchor.
    expect(ros?.offsetMinutes).toBe(15);
    expect(computeRunTime(event!.eventDate, ros!.offsetMinutes!)).toBe(
      evening + 15 * MINUTE_MS,
    );
    // The day-offset task's derived dueDate re-anchored to the new date.
    expect(task?.dueDate).toBe(computeDueDate(evening, -7));
  });
});

// ── Backfill migration (0019) ────────────────────────────────────────────────
describe("0019 backfill run_of_show duration", () => {
  /** Seed a run_of_show template + event grid WITHOUT the duration column. */
  async function seedLegacyGrids(t: ReturnType<typeof newT>) {
    const { chapterId, userId } = await setupChapter(t);
    return run(t, async (ctx) => {
      const now = Date.now();
      const eventTypeId = await ctx.db.insert("eventTypes", {
        chapterId,
        name: "Legacy",
        slug: `legacy-${now}`,
        version: 1,
        isArchived: false,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });
      const eventId = await ctx.db.insert("events", {
        chapterId,
        eventTypeId,
        templateVersion: 1,
        name: "Legacy Event",
        eventDate: now,
        status: "planning",
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });
      const legacyCols = [
        { key: "title", label: "Segment", kind: "system" as const, type: "text" as const, order: 0 },
        { key: "offset", label: "Time", kind: "system" as const, type: "offset_minutes" as const, order: 1 },
        { key: "notes", label: "Notes", kind: "custom" as const, type: "longtext" as const, order: 2 },
      ];
      for (const c of legacyCols) {
        await ctx.db.insert("templateColumns", {
          eventTypeId,
          module: "run_of_show",
          isVisible: true,
          ...c,
        });
        await ctx.db.insert("eventColumns", {
          eventId,
          module: "run_of_show",
          isVisible: true,
          ...c,
        });
      }
      return { eventTypeId, eventId };
    });
  }

  test("inserts the duration column, then is a no-op on re-run", async () => {
    const t = newT();
    const { eventTypeId, eventId } = await seedLegacyGrids(t);

    const res1 = await run(t, (ctx) => runBackfillRunOfShowDuration(ctx));
    expect(res1.templateColumnsAdded).toBe(1);
    expect(res1.eventColumnsAdded).toBe(1);

    const { tDur, eDur } = await run(t, async (ctx) => {
      const tCols = await ctx.db
        .query("templateColumns")
        .withIndex("by_eventType_module", (q) =>
          q.eq("eventTypeId", eventTypeId).eq("module", "run_of_show"),
        )
        .collect();
      const eCols = await ctx.db
        .query("eventColumns")
        .withIndex("by_event_module", (q) =>
          q.eq("eventId", eventId).eq("module", "run_of_show"),
        )
        .collect();
      return {
        tDur: tCols.find((c) => c.key === "duration"),
        eDur: eCols.find((c) => c.key === "duration"),
      };
    });
    expect(tDur?.type).toBe("number");
    expect(tDur?.kind).toBe("custom");
    expect(eDur?.type).toBe("number");

    // Idempotent: a second run adds nothing.
    const res2 = await run(t, (ctx) => runBackfillRunOfShowDuration(ctx));
    expect(res2.templateColumnsAdded).toBe(0);
    expect(res2.eventColumnsAdded).toBe(0);
  });
});
