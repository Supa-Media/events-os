import { describe, expect, test } from "vitest";
import {
  computeDueDate,
  offsetDaysBetween,
  startOfDay,
  DAY_MS,
} from "@events-os/shared";

/**
 * Unit tests for the day-offset ↔ due-date math that backs the calendar DUE
 * picker and the TIMING column. The picker lets users choose a calendar DAY and
 * writes back a signed `offsetDays`; `offsetDaysBetween` is that conversion and
 * is the easiest place to introduce an off-by-one (the event carries a
 * time-of-day, but timing is whole days). These pin the contract:
 *   - day-granular and time-of-day independent (no off-by-one),
 *   - correct sign (before < 0, day-of = 0, after > 0),
 *   - exact inverse of `computeDueDate` for any day a due date lands on.
 */

// A deliberately awkward event time (5:05 PM) so any time-of-day leakage shows.
const eventDate = new Date(2026, 6, 27, 17, 5).getTime(); // Jul 27 2026, 17:05 local

describe("startOfDay", () => {
  test("strips the time-of-day to local midnight", () => {
    const noon = new Date(2026, 6, 27, 12, 30, 45).getTime();
    const d = new Date(startOfDay(noon));
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getDate()).toBe(27);
  });

  test("is idempotent", () => {
    expect(startOfDay(startOfDay(eventDate))).toBe(startOfDay(eventDate));
  });
});

describe("offsetDaysBetween", () => {
  test("is 0 for the event day regardless of either time-of-day", () => {
    const midnightSameDay = new Date(2026, 6, 27, 0, 0).getTime();
    const lateSameDay = new Date(2026, 6, 27, 23, 59).getTime();
    expect(offsetDaysBetween(eventDate, midnightSameDay)).toBe(0);
    expect(offsetDaysBetween(eventDate, lateSameDay)).toBe(0);
  });

  test("does not drift off-by-one across the event's time-of-day", () => {
    // Event is at 17:05; a midnight pick on the SAME day must be 0 (not -1),
    // the day before -1, the day after +1.
    expect(offsetDaysBetween(eventDate, new Date(2026, 6, 26, 0, 0).getTime())).toBe(-1);
    expect(offsetDaysBetween(eventDate, new Date(2026, 6, 28, 0, 0).getTime())).toBe(1);
  });

  test("signs: before is negative, after is positive", () => {
    expect(offsetDaysBetween(eventDate, new Date(2026, 6, 6).getTime())).toBe(-21);
    expect(offsetDaysBetween(eventDate, new Date(2026, 6, 20).getTime())).toBe(-7);
    expect(offsetDaysBetween(eventDate, new Date(2026, 6, 29).getTime())).toBe(2);
  });

  test("matches the seed timeline (Jul 27 event → T-21 lands on Jul 6)", () => {
    const due = computeDueDate(eventDate, -21);
    expect(new Date(due).getDate()).toBe(6);
    expect(offsetDaysBetween(eventDate, due)).toBe(-21);
  });
});

describe("computeDueDate ↔ offsetDaysBetween round-trip", () => {
  test("offsetDaysBetween inverts computeDueDate for every offset in range", () => {
    for (let offset = -45; offset <= 45; offset++) {
      const due = computeDueDate(eventDate, offset);
      expect(offsetDaysBetween(eventDate, due)).toBe(offset);
    }
  });

  test("computeDueDate moves the due date by exactly N days", () => {
    expect(computeDueDate(eventDate, -7) - eventDate).toBe(-7 * DAY_MS);
    expect(computeDueDate(eventDate, 3) - eventDate).toBe(3 * DAY_MS);
  });
});
