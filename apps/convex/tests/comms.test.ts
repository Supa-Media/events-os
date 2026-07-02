import { describe, expect, test } from "vitest";
import {
  commsTimingLabel,
  eventCountdownLabel,
  offsetDaysBetween,
  startOfDay,
  DAY_MS,
} from "@events-os/shared";

/**
 * Unit tests for the pure logic behind the Comms Schedule calendar view. These
 * live in `@events-os/shared` precisely so they're testable without rendering a
 * React Native screen. The risk they pin down:
 *   - how a send's day-offset reads relative to its event (before/after/day-of),
 *   - the "not yet scheduled" case (a send with no offset),
 *   - singular vs plural day wording,
 *   - the event-day countdown ("Today" / "in N days" / "N days ago"),
 *   - that the countdown pairs correctly with `offsetDaysBetween(today, event)`
 *     even when the event carries a time-of-day.
 */

describe("commsTimingLabel", () => {
  test("labels sends before the event", () => {
    expect(commsTimingLabel(-7)).toBe("7 days before");
    expect(commsTimingLabel(-14)).toBe("14 days before");
  });

  test("labels sends after the event", () => {
    expect(commsTimingLabel(3)).toBe("3 days after");
  });

  test("labels the event day itself", () => {
    expect(commsTimingLabel(0)).toBe("On event day");
  });

  test("treats a missing offset as unscheduled", () => {
    expect(commsTimingLabel(null)).toBe("Unscheduled");
    expect(commsTimingLabel(undefined)).toBe("Unscheduled");
  });

  test("uses the singular for one day either side", () => {
    expect(commsTimingLabel(-1)).toBe("1 day before");
    expect(commsTimingLabel(1)).toBe("1 day after");
  });
});

describe("eventCountdownLabel", () => {
  test("says Today at zero days out", () => {
    expect(eventCountdownLabel(0)).toBe("Today");
  });

  test("counts forward to a future event", () => {
    expect(eventCountdownLabel(12)).toBe("in 12 days");
    expect(eventCountdownLabel(1)).toBe("in 1 day");
  });

  test("counts back for a past event", () => {
    expect(eventCountdownLabel(-3)).toBe("3 days ago");
    expect(eventCountdownLabel(-1)).toBe("1 day ago");
  });
});

describe("countdown pairs with offsetDaysBetween(today, eventDate)", () => {
  test("an event two days out, even at 6pm, reads 'in 2 days'", () => {
    const today = startOfDay(1_700_000_000_000);
    // Event two calendar days later, at 18:00 — the time must not push it off.
    const eventDate = today + 2 * DAY_MS + 18 * 60 * 60 * 1000;
    const daysAway = offsetDaysBetween(today, eventDate);
    expect(daysAway).toBe(2);
    expect(eventCountdownLabel(daysAway)).toBe("in 2 days");
  });

  test("an event earlier today still reads 'Today'", () => {
    const today = startOfDay(1_700_000_000_000);
    const eventDate = today + 9 * 60 * 60 * 1000; // 9am today
    expect(eventCountdownLabel(offsetDaysBetween(today, eventDate))).toBe("Today");
  });
});
