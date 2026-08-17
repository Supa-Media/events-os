import { describe, expect, test } from "vitest";
import {
  DEFAULT_COLUMNS,
  EASTERN_TIME_ZONE,
  MINUTE_MS,
  RUN_OF_SHOW_FINAL_WINDOW_MS,
  RUN_OF_SHOW_LEAD_IN_MS,
  buildRunOfShowSegments,
  computeDueDate,
  computeRunTime,
  eventTimeZone,
  isMidnightInZone,
  isRunOfShowLive,
  runOfShowNowIndex,
  runOfShowSegmentEnd,
  zonedTimeToUtc,
} from "@events-os/shared";
import { api } from "../_generated/api";
import { newT, run, setupChapter } from "./setup.helpers";
import { runBackfillRunOfShowDuration } from "../migrations/0019_backfill_run_of_show_duration";
import type { Id } from "../_generated/dataModel";

/**
 * Run of Show v1 — the start-time anchor + segment ranges.
 *
 * Covers the pure shared helpers (`isMidnightInZone`, `runOfShowSegmentEnd`,
 * `isRunOfShowLive`, `eventTimeZone`), the
 * new `duration` default column, the reschedule re-anchoring (the path the
 * new-event start time and the Day-of "set start time" affordance both feed),
 * and the `0019` backfill migration.
 */

// ── Pure helpers ─────────────────────────────────────────────────────────────
describe("run of show helpers (shared)", () => {
  test("isMidnightInZone flags exactly 00:00 IN THE ZONE, nothing else", () => {
    // Built in the zone, so the assertion means the same thing on a UTC CI box
    // and on a laptop in Los Angeles — the whole point of the helper.
    const etMidnight = zonedTimeToUtc(
      { year: 2026, month: 7, day: 27, hour: 0, minute: 0 },
      EASTERN_TIME_ZONE,
    );
    expect(isMidnightInZone(etMidnight, EASTERN_TIME_ZONE)).toBe(true);
    // One minute past midnight is NOT flagged.
    expect(isMidnightInZone(etMidnight + MINUTE_MS, EASTERN_TIME_ZONE)).toBe(
      false,
    );
    // A real evening start is not flagged.
    expect(
      isMidnightInZone(
        zonedTimeToUtc(
          { year: 2026, month: 7, day: 27, hour: 18, minute: 30 },
          EASTERN_TIME_ZONE,
        ),
        EASTERN_TIME_ZONE,
      ),
    ).toBe(false);
    // The device's clock is irrelevant: ET midnight is 9 PM the previous day in
    // Los Angeles, and asking in LA's zone must say so.
    expect(isMidnightInZone(etMidnight, "America/Los_Angeles")).toBe(false);
    // …and the instant that IS midnight in Los Angeles is not midnight in ET.
    const laMidnight = zonedTimeToUtc(
      { year: 2026, month: 7, day: 27, hour: 0, minute: 0 },
      "America/Los_Angeles",
    );
    expect(isMidnightInZone(laMidnight, "America/Los_Angeles")).toBe(true);
    expect(isMidnightInZone(laMidnight, EASTERN_TIME_ZONE)).toBe(false);
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

  test("buildRunOfShowSegments sorts by offset and resolves start/end/showEnd", () => {
    const eventStart = new Date(2026, 6, 27, 18, 0).getTime();
    const rows = [
      { title: "Set", offsetMinutes: 30, durationMinutes: null },
      { title: "Doors", offsetMinutes: -15, durationMinutes: 10 },
      { title: "Send-off", offsetMinutes: 90, durationMinutes: null },
    ];
    const segs = buildRunOfShowSegments(eventStart, rows);
    expect(segs.map((s) => s.row.title)).toEqual(["Doors", "Set", "Send-off"]);
    // Doors: explicit 10-min duration wins over the next start.
    expect(segs[0].start).toBe(eventStart - 15 * MINUTE_MS);
    expect(segs[0].end).toBe(segs[0].start + 10 * MINUTE_MS);
    expect(segs[0].showEnd).toBe(true);
    // Set: no duration → runs until Send-off starts.
    expect(segs[1].end).toBe(segs[2].start);
    // Send-off: final row, no duration → 2h cap, and no end label.
    expect(segs[2].end).toBe(segs[2].start + RUN_OF_SHOW_FINAL_WINDOW_MS);
    expect(segs[2].showEnd).toBe(false);
  });

  test("runOfShowNowIndex: in-window, pre-show, and after-the-end", () => {
    const eventStart = new Date(2026, 6, 27, 18, 0).getTime();
    const segs = buildRunOfShowSegments(eventStart, [
      { offsetMinutes: 0, durationMinutes: 30 },
      { offsetMinutes: 30, durationMinutes: 30 },
    ]);
    // Mid-first-segment → 0; mid-second → 1.
    expect(runOfShowNowIndex(segs, eventStart + 10 * MINUTE_MS)).toBe(0);
    expect(runOfShowNowIndex(segs, eventStart + 40 * MINUTE_MS)).toBe(1);
    // Before the show, the first row reads "up next".
    expect(runOfShowNowIndex(segs, eventStart - 60 * MINUTE_MS)).toBe(0);
    // After the last window closes, nothing is highlighted.
    expect(runOfShowNowIndex(segs, eventStart + 61 * MINUTE_MS)).toBe(-1);
    expect(runOfShowNowIndex([], eventStart)).toBe(-1);
  });

  /**
   * The liveness gate — the thing that stops "UP NEXT" being a permanent
   * decoration on an event that is weeks away. Every clock below is a fixed
   * literal: no `Date.now()`, so this suite reads the same in July as in
   * December and a failure is always a real regression.
   */
  describe("isRunOfShowLive — the gate the UP NEXT / NOW badge hangs on", () => {
    const eventStart = new Date(2026, 6, 27, 18, 0).getTime();
    const segs = buildRunOfShowSegments(eventStart, [
      { offsetMinutes: 0, durationMinutes: 30 },
      { offsetMinutes: 30, durationMinutes: 30 },
    ]);
    const lastEnd = segs[segs.length - 1].end;

    test("an event three weeks out is not live — nothing may be badged", () => {
      const threeWeeksOut = eventStart - 21 * 24 * 60 * MINUTE_MS;
      expect(isRunOfShowLive(segs, threeWeeksOut)).toBe(false);
      // And this is exactly why the gate has to exist: the raw index still
      // points at row 0, which is the bug Day-of shipped for months.
      expect(runOfShowNowIndex(segs, threeWeeksOut)).toBe(0);
    });

    test("the morning of the event is still not live", () => {
      expect(isRunOfShowLive(segs, new Date(2026, 6, 27, 9, 0).getTime())).toBe(
        false,
      );
    });

    test("the lead-in opens exactly RUN_OF_SHOW_LEAD_IN_MS before the first row", () => {
      expect(isRunOfShowLive(segs, eventStart - RUN_OF_SHOW_LEAD_IN_MS - 1)).toBe(
        false,
      );
      expect(isRunOfShowLive(segs, eventStart - RUN_OF_SHOW_LEAD_IN_MS)).toBe(
        true,
      );
    });

    test("inside the lead-in the first row is genuinely UP NEXT", () => {
      const soon = eventStart - 30 * MINUTE_MS;
      expect(isRunOfShowLive(segs, soon)).toBe(true);
      const i = runOfShowNowIndex(segs, soon);
      expect(i).toBe(0);
      // The badge reads "UP NEXT" while `now < start` and "NOW" once inside it —
      // the same expression both surfaces use to pick the word.
      expect(soon < segs[i].start).toBe(true);
      expect(eventStart + 10 * MINUTE_MS < segs[0].start).toBe(false);
    });

    test("live right through the show, dark once the last window closes", () => {
      expect(isRunOfShowLive(segs, eventStart + 10 * MINUTE_MS)).toBe(true);
      expect(isRunOfShowLive(segs, lastEnd - 1)).toBe(true);
      expect(isRunOfShowLive(segs, lastEnd)).toBe(false);
      expect(isRunOfShowLive(segs, lastEnd + 60 * MINUTE_MS)).toBe(false);
    });

    test("an empty run of show is never live", () => {
      expect(isRunOfShowLive([], eventStart)).toBe(false);
    });

    test("liveness is an INSTANT question, so the device's zone can't change it", () => {
      // `isRunOfShowLive` compares epoch instants, never wall-clock parts. This
      // asserts that on purpose: the moment a "what time is it here?" reading
      // sneaks into the gate, Day-of and the briefing start disagreeing for a
      // travelling leader — the same class of bug as the labels.
      const eventStart = zonedTimeToUtc(
        { year: 2026, month: 7, day: 27, hour: 18, minute: 0 },
        EASTERN_TIME_ZONE,
      );
      const zoned = buildRunOfShowSegments(eventStart, [
        { offsetMinutes: 0, durationMinutes: 30 },
      ]);
      // One instant, described two ways — the answer must be identical.
      const thirtyMinutesBefore = eventStart - 30 * MINUTE_MS;
      expect(isRunOfShowLive(zoned, thirtyMinutesBefore)).toBe(true);
      expect(
        isRunOfShowLive(
          zoned,
          zonedTimeToUtc(
            { year: 2026, month: 7, day: 27, hour: 14, minute: 30 },
            "America/Los_Angeles",
          ),
        ),
      ).toBe(true);
    });

    test("the lead-in is its own constant, not the final-window cap", () => {
      // Same value today, different jobs — retuning one must not silently move
      // the other. This asserts they are separately named, not that they differ.
      expect(RUN_OF_SHOW_LEAD_IN_MS).toBe(2 * 60 * 60 * 1000);
      expect(RUN_OF_SHOW_FINAL_WINDOW_MS).toBe(2 * 60 * 60 * 1000);
    });
  });

  /**
   * The zone every event clock resolves against. These tests use fixed
   * timestamps and explicit zones so they assert the same thing wherever they
   * run — including a UTC CI box, where a device-local formatter would have
   * quietly agreed with Eastern only by accident half the year.
   */
  describe("eventTimeZone — whose clock an event is read in", () => {
    const evening = zonedTimeToUtc(
      { year: 2026, month: 7, day: 27, hour: 18, minute: 0 },
      EASTERN_TIME_ZONE,
    );

    test("falls back to the org's home zone while no event carries one", () => {
      expect(eventTimeZone()).toBe(EASTERN_TIME_ZONE);
      expect(eventTimeZone(null)).toBe(EASTERN_TIME_ZONE);
      expect(eventTimeZone({ eventDate: evening })).toBe(EASTERN_TIME_ZONE);
    });

    test("an event's own zone wins the day one exists — the whole point", () => {
      // Nothing WRITES `timeZone` yet; this proves the seam is real, so adding
      // the column is a schema change and not a hunt through every screen.
      expect(
        eventTimeZone({ eventDate: evening, timeZone: "America/Los_Angeles" }),
      ).toBe("America/Los_Angeles");
      // An empty/absent value is not a zone — fall back rather than format
      // against "".
      expect(eventTimeZone({ eventDate: evening, timeZone: "" })).toBe(
        EASTERN_TIME_ZONE,
      );
      expect(eventTimeZone({ eventDate: evening, timeZone: null })).toBe(
        EASTERN_TIME_ZONE,
      );
    });

    test("the resolved zone survives DST — same wall clock either side", () => {
      // 7 PM local on both sides of the US spring-forward. If anything in this
      // chain hard-coded an offset instead of a zone, one of these would slip
      // an hour.
      const beforeDst = zonedTimeToUtc(
        { year: 2026, month: 3, day: 7, hour: 19, minute: 0 },
        EASTERN_TIME_ZONE,
      );
      const afterDst = zonedTimeToUtc(
        { year: 2026, month: 3, day: 9, hour: 19, minute: 0 },
        EASTERN_TIME_ZONE,
      );
      const zone = eventTimeZone({ eventDate: beforeDst });
      const hourIn = (ts: number, tz: string) =>
        new Intl.DateTimeFormat("en-US", {
          timeZone: tz,
          hour: "numeric",
          hour12: false,
        }).format(ts);
      expect(hourIn(beforeDst, zone)).toBe("19");
      expect(hourIn(afterDst, zone)).toBe("19");
      // …and the underlying UTC offset really did move, so the test isn't
      // passing because nothing happened.
      expect(hourIn(beforeDst, "UTC")).not.toBe(hourIn(afterDst, "UTC"));
    });
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
    expect(isMidnightInZone(event!.eventDate, eventTimeZone(event))).toBe(
      false,
    );
  });

  test("reschedule re-anchors: day offsets re-derive, minute segments self-correct", async () => {
    const t = newT();
    const { as, chapterId } = await setupChapter(t);
    const eventTypeId = (await as.mutation(api.eventTypes.create, {
      name: "Night",
    })) as Id<"eventTypes">;
    // Simulate an OLD event created before start-times: anchored at midnight in
    // the event's own zone (which is what the Day-of nudge asks about).
    const midnight = zonedTimeToUtc(
      { year: 2026, month: 8, day: 1, hour: 0, minute: 0 },
      EASTERN_TIME_ZONE,
    );
    const eventId = (await as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "N",
      eventDate: midnight,
    })) as Id<"events">;
    expect(isMidnightInZone(midnight, EASTERN_TIME_ZONE)).toBe(true);

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
    expect(isMidnightInZone(event!.eventDate, eventTimeZone(event))).toBe(
      false,
    );
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

// ── Volunteer briefing payload ───────────────────────────────────────────────
describe("crew briefing run of show", () => {
  test("publicCrew carries a sanitized, offset-sorted run of show", async () => {
    const t = newT();
    const { as, chapterId } = await setupChapter(t);
    const eventTypeId = (await as.mutation(api.eventTypes.create, {
      name: "Worship Night",
    })) as Id<"eventTypes">;
    const eventId = (await as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "Worship Night — August",
      eventDate: new Date(2026, 7, 1, 18, 0).getTime(),
    })) as Id<"events">;

    await run(t, async (ctx) => {
      // Deliberately out of order, with internal-ish columns (owner/role) that
      // must NOT leak into the public payload.
      await ctx.db.insert("eventItems", {
        eventId,
        chapterId,
        module: "run_of_show",
        title: "Set",
        order: 0,
        offsetMinutes: 30,
        fields: { duration: 45, notes: "Full band", role: "Worship Lead" },
      });
      await ctx.db.insert("eventItems", {
        eventId,
        chapterId,
        module: "run_of_show",
        title: "Doors",
        order: 1,
        offsetMinutes: -15,
        fields: { duration: 0 },
      });
    });

    const crew = await t.query(api.events.publicCrew, { eventId });
    expect(crew?.runOfShow).toEqual([
      // Zero duration reads as "no duration"; missing notes come back null.
      { title: "Doors", offsetMinutes: -15, durationMinutes: null, notes: null },
      { title: "Set", offsetMinutes: 30, durationMinutes: 45, notes: "Full band" },
    ]);
  });
});

// ── Public run-of-show share link ────────────────────────────────────────────
describe("public run of show share link", () => {
  test("publicRunOfShow returns the sanitized, offset-sorted timeline with no auth", async () => {
    const t = newT();
    const { as, chapterId } = await setupChapter(t);
    const eventTypeId = (await as.mutation(api.eventTypes.create, {
      name: "Worship Night",
    })) as Id<"eventTypes">;
    const eventId = (await as.mutation(api.events.createFromTemplate, {
      eventTypeId,
      name: "Worship Night — August",
      eventDate: new Date(2026, 7, 1, 18, 0).getTime(),
    })) as Id<"events">;

    await run(t, async (ctx) => {
      // Deliberately out of order, with an internal-only `role` field that
      // must NOT leak into the public payload.
      await ctx.db.insert("eventItems", {
        eventId,
        chapterId,
        module: "run_of_show",
        title: "Set",
        order: 0,
        offsetMinutes: 30,
        fields: { duration: 45, notes: "Full band", role: "Worship Lead" },
      });
      await ctx.db.insert("eventItems", {
        eventId,
        chapterId,
        module: "run_of_show",
        title: "Doors",
        order: 1,
        offsetMinutes: -15,
        fields: { duration: 0 },
      });
    });

    // Called on the UNAUTHENTICATED `t`, not `as` — this must work with zero
    // auth, the entire point of a share link.
    const result = await t.query(api.events.publicRunOfShow, { eventId });
    expect(result?.name).toBe("Worship Night — August");
    expect(result?.eventDate).toBe(new Date(2026, 7, 1, 18, 0).getTime());
    expect(result?.runOfShow).toEqual([
      { title: "Doors", offsetMinutes: -15, durationMinutes: null, notes: null },
      { title: "Set", offsetMinutes: 30, durationMinutes: 45, notes: "Full band" },
    ]);
  });

  test("publicRunOfShow returns null once the event is gone", async () => {
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

    await run(t, (ctx) => ctx.db.delete(eventId));

    expect(await t.query(api.events.publicRunOfShow, { eventId })).toBeNull();
  });
});
