/**
 * @jest-environment ./jest/tzEnvironment.js
 * @tz Asia/Tokyo
 *
 * Which DAY an event is on, read from a device that disagrees.
 *
 * The zoned *time* formatters landed in #610 and the write path in #615, but
 * several event lists still asked the device what day an instant belongs to.
 * That is not a smaller version of the hour bug — it is a bigger one. A 7:00 PM
 * Eastern event is already tomorrow in Tokyo, so a device-local answer files it
 * under a day its own crew doesn't call it: the wrong cell in the month grid,
 * the wrong date on a roster, and the wrong night offered at a venue door.
 *
 * This file deliberately runs on a TOKYO device (see `jest/tzEnvironment.js`),
 * because on any device west of Eastern the bug simply doesn't reproduce — the
 * whole reason it survived. The first assertion pins that, so the file can't
 * quietly become a New York run and keep passing.
 */
import { EASTERN_TIME_ZONE, eventTimeZone, zonedTimeToUtc } from "@events-os/shared";
import {
  formatDate,
  formatDateInZone,
  formatWeekdayDateInZone,
  zonedDayToCalendarMs,
} from "./format";

// `@types/jest` isn't installed in this workspace, so every colocated
// `*.test.ts` here already contributes "Cannot find name 'describe'" noise to
// `tsc --noEmit`. Declared locally rather than adding more to that pile.
declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void) => void;
declare const expect: (actual: unknown) => {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  not: { toBe(expected: unknown): void };
};

/** 7:00 PM Eastern, Saturday 29 August 2026 — an ordinary evening event. */
const EVENING = zonedTimeToUtc(
  { year: 2026, month: 8, day: 29, hour: 19, minute: 0 },
  EASTERN_TIME_ZONE,
);

describe("an evening event, read from a device that is already tomorrow", () => {
  it("is running in Tokyo — otherwise this file proves nothing", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("Asia/Tokyo");
    // The bug, stated: the device really does think it is the 30th.
    expect(formatDate(EVENING)).toBe("Aug 30, 2026");
  });

  it("renders the event's own date, not the device's", () => {
    expect(formatDateInZone(EVENING, eventTimeZone({ eventDate: EVENING }))).toBe(
      "Aug 29, 2026",
    );
  });

  it("names the right weekday too — a door list says Sat, not Sun", () => {
    expect(formatWeekdayDateInZone(EVENING, EASTERN_TIME_ZONE)).toBe("Sat, Aug 29");
    expect(formatWeekdayDateInZone(EVENING, "Asia/Tokyo")).toBe("Sun, Aug 30");
  });

  it("buckets into the event's calendar day", () => {
    const d = new Date(zonedDayToCalendarMs(EVENING, EASTERN_TIME_ZONE));
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 8, 29]);
  });

  it("keeps two events on the same event-day in one bucket, whatever their clocks", () => {
    const morning = zonedTimeToUtc(
      { year: 2026, month: 8, day: 29, hour: 9, minute: 0 },
      EASTERN_TIME_ZONE,
    );
    // Device-locally these fall on the 29th and the 30th — two buckets, and a
    // calendar that shows one event where there are two.
    expect(formatDate(morning)).toBe("Aug 29, 2026");
    expect(formatDate(EVENING)).toBe("Aug 30, 2026");
    expect(zonedDayToCalendarMs(morning, EASTERN_TIME_ZONE)).toBe(
      zonedDayToCalendarMs(EVENING, EASTERN_TIME_ZONE),
    );
  });

  it("still separates events that really are on different days", () => {
    const nextDay = zonedTimeToUtc(
      { year: 2026, month: 8, day: 30, hour: 19, minute: 0 },
      EASTERN_TIME_ZONE,
    );
    expect(zonedDayToCalendarMs(nextDay, EASTERN_TIME_ZONE)).not.toBe(
      zonedDayToCalendarMs(EVENING, EASTERN_TIME_ZONE),
    );
  });

  it("falls back to the device rather than throwing on an unusable zone", () => {
    expect(formatDateInZone(EVENING, "Not/AZone")).toBe(formatDate(EVENING));
    expect(formatWeekdayDateInZone(EVENING, "Not/AZone")).toBe(formatDate(EVENING));
  });
});
