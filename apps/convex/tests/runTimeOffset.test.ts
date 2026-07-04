import { describe, expect, test } from "vitest";
import { computeRunTime, offsetForClockTime } from "@events-os/shared";

/**
 * Unit tests for the wall-clock ↔ minute-offset math behind the run-of-show
 * TIME picker. A segment's time is stored as a signed offset from the event
 * start, and a run of show can cross midnight, so a bare typed time is
 * day-ambiguous. `offsetForClockTime` resolves that by placing the time on the
 * occurrence nearest the segment's current time. These pin that contract:
 *   - correct sign (before start < 0, at start = 0, after > 0),
 *   - a small nudge stays on the same night,
 *   - crossing midnight resolves to the nearest day,
 *   - it round-trips with `computeRunTime`.
 */

// Event starts exactly at midnight so offsets read as clean minute counts.
const eventStart = new Date(2026, 7, 8, 0, 0).getTime(); // Aug 8 2026, 00:00 local
const at = (offset: number) => ({ eventStart, currentOffset: offset });

describe("offsetForClockTime", () => {
  test("a setup time before the event resolves to a negative offset", () => {
    // 9:00 PM is nearest to midnight on the previous evening → 180 min before.
    expect(offsetForClockTime({ ...at(0), hour24: 21, minute: 0 })).toBe(-180);
  });

  test("the event-start time itself is offset 0", () => {
    expect(offsetForClockTime({ ...at(0), hour24: 0, minute: 0 })).toBe(0);
  });

  test("a time after the event resolves to a positive offset", () => {
    expect(offsetForClockTime({ ...at(0), hour24: 1, minute: 0 })).toBe(60);
  });

  test("nudging the minutes stays on the same night", () => {
    // Current segment is 11:30 PM (−30); bumping to 11:45 PM is −15, not +1425.
    expect(offsetForClockTime({ ...at(-30), hour24: 23, minute: 45 })).toBe(-15);
  });

  test("crossing midnight resolves to the nearest day", () => {
    // From 11:30 PM (−30), 12:15 AM is the *next* day → +15, not −1425.
    expect(offsetForClockTime({ ...at(-30), hour24: 0, minute: 15 })).toBe(15);
  });

  test("round-trips with computeRunTime", () => {
    const offset = offsetForClockTime({ ...at(0), hour24: 21, minute: 30 });
    const ts = computeRunTime(eventStart, offset);
    const d = new Date(ts);
    expect([d.getHours(), d.getMinutes()]).toEqual([21, 30]);
  });
});
