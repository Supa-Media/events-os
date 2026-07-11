import { afterEach, describe, expect, test } from "vitest";
import { vi } from "vitest";
import {
  PLANNING_TIME_ZONE,
  dayKeyInTz,
  daysBetweenInTz,
  zonedParts,
  zonedTimeToUtc,
} from "@events-os/shared";
import { parseRescheduleDate } from "../aiActions";
import { internal } from "../_generated/api";
import { newT, run, setupChapter } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import type { TestConvex } from "./setup.helpers";

/**
 * Planning-timezone day math. The server runs UTC while events are planned in
 * Eastern wall-clock time: a Saturday-11-PM-ET event is STORED as 03:00Z
 * Sunday. Calendar-day logic (days-to-event, T-window, overdue, bare-date
 * reschedules) must therefore count days in PLANNING_TIME_ZONE, not UTC —
 * otherwise every evening event is off by one.
 */

// 11 PM America/New_York on Jul 25 2026 (EDT, UTC-4) = Jul 26 03:00Z.
const EVENT_TS = Date.UTC(2026, 6, 26, 3, 0);

describe("shared timezone helpers", () => {
  test("dayKeyInTz reads the LOCAL calendar day, not the UTC one", () => {
    expect(dayKeyInTz(EVENT_TS)).toBe("2026-07-25");
    expect(dayKeyInTz(EVENT_TS, "UTC")).toBe("2026-07-26");
  });

  test("zonedParts/zonedTimeToUtc round-trip across a wall-clock time", () => {
    const parts = zonedParts(EVENT_TS, PLANNING_TIME_ZONE);
    expect(parts).toMatchObject({
      year: 2026,
      month: 7,
      day: 25,
      hour: 23,
      minute: 0,
    });
    expect(zonedTimeToUtc(parts, PLANNING_TIME_ZONE)).toBe(EVENT_TS);
  });

  test("daysBetweenInTz counts local calendar days (evening event ≠ +1)", () => {
    const now = Date.UTC(2026, 6, 23, 14, 0); // Jul 23 10:00 ET
    // UTC math would say 3 (Jul 26 - Jul 23); local days say 2 (Jul 25 - Jul 23).
    expect(daysBetweenInTz(now, EVENT_TS)).toBe(2);
    expect(daysBetweenInTz(EVENT_TS, now)).toBe(-2);
    expect(daysBetweenInTz(now, now)).toBe(0);
  });
});

describe("parseRescheduleDate keeps local wall-clock time", () => {
  test("a bare date lands on 11 PM ET of the requested LOCAL day", () => {
    const ts = parseRescheduleDate("2026-08-08", EVENT_TS);
    // 11 PM ET Aug 8 (EDT) = Aug 9 03:00Z.
    expect(ts).toBe(Date.UTC(2026, 7, 9, 3, 0));
    expect(dayKeyInTz(ts!)).toBe("2026-08-08");
    const wall = zonedParts(ts!, PLANNING_TIME_ZONE);
    expect(wall.hour).toBe(23);
    expect(wall.minute).toBe(0);
  });

  test("crossing a DST boundary keeps the same wall-clock hour", () => {
    // Reschedule the (EDT) event into January (EST, UTC-5).
    const ts = parseRescheduleDate("2027-01-09", EVENT_TS);
    const wall = zonedParts(ts!, PLANNING_TIME_ZONE);
    expect(dayKeyInTz(ts!)).toBe("2027-01-09");
    expect(wall.hour).toBe(23);
  });
});

// ── readinessSummary day-granularity (fake "now") ────────────────────────────

async function seedEvent(
  t: TestConvex,
  chapterId: Id<"chapters">,
  userId: Id<"users">,
  eventDate: number,
) {
  return await run(t, async (ctx) => {
    const now = Date.now();
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId,
      name: "T",
      slug: "t",
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
      name: "TZ Event",
      eventDate,
      status: "planning",
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    return { eventId };
  });
}

describe("readinessSummary planning-timezone day math", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("daysToEvent for an evening event counts LOCAL days (2, not 3)", async () => {
    const t = newT();
    const { chapterId, userId } = await setupChapter(t);
    const { eventId } = await seedEvent(t, chapterId, userId, EVENT_TS);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 23, 14, 0))); // Jul 23 10:00 ET

    const summary = await t.query(internal.ai.readinessSummary, {
      eventId,
      chapterId,
    });
    expect(summary).not.toBeNull();
    expect(summary!.daysToEvent).toBe(2);
    expect(summary!.tWindow).toMatch(/^T-2 /);
  });

  test("an item due earlier TODAY is due-soon, not overdue", async () => {
    const t = newT();
    const { chapterId, userId } = await setupChapter(t);
    const { eventId } = await seedEvent(t, chapterId, userId, EVENT_TS);

    // Now = Jul 23 2026 14:00 ET; the item was due 08:00 ET the same day.
    const now = Date.UTC(2026, 6, 23, 18, 0);
    const dueEarlierToday = Date.UTC(2026, 6, 23, 12, 0);
    // And one genuinely overdue item, due the local day before.
    const dueYesterday = Date.UTC(2026, 6, 22, 12, 0);
    await run(t, async (ctx) => {
      await ctx.db.insert("eventItems", {
        eventId,
        chapterId,
        module: "planning_doc",
        title: "Due earlier today",
        order: 0,
        dueDate: dueEarlierToday,
      });
      await ctx.db.insert("eventItems", {
        eventId,
        chapterId,
        module: "planning_doc",
        title: "Due yesterday",
        order: 1,
        dueDate: dueYesterday,
      });
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));

    const summary = await t.query(internal.ai.readinessSummary, {
      eventId,
      chapterId,
    });
    expect(summary).not.toBeNull();
    expect(summary!.items.overdue.count).toBe(1);
    expect(summary!.items.overdue.titles).toEqual([
      "Tasks: Due yesterday",
    ]);
    expect(summary!.items.dueInNext3Days.count).toBe(1);
    expect(summary!.items.dueInNext3Days.titles).toEqual([
      "Tasks: Due earlier today",
    ]);
  });
});
