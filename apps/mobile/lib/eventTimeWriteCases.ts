/**
 * The WRITE half of event time, asserted from one device at a time.
 *
 * The display fix (#610) stopped two phones in the same room reading the same
 * run sheet differently. This is the more damaging half, because it corrupts
 * rather than confuses: `new Date(y, m, d, h, mi)` reads typed wall clock in the
 * DEVICE's zone, so a leader on a Pacific phone setting a New York event to
 * "7:00 PM" stored **10:00 PM Eastern**. The event moved. Nobody in the org's
 * own timezone could see it happen, and the whole run of show — every row an
 * offset from that anchor — moved with it.
 *
 * The invariant is one sentence: **same typed wall clock + same event ⇒ same
 * stored instant ⇒ same rendered time, from any device timezone.** It is
 * asserted directly rather than inferred, by running these cases three times
 * with the device really moved (see `jest/tzEnvironment.js`) — from New York,
 * from Los Angeles, and from Tokyo, where it is already tomorrow. Every
 * expectation below is the SAME literal in all three runs; that identity across
 * files IS the proof, so no expected value may be derived from the device.
 *
 * Each caller asserts its own resolved zone first, so a typo'd `@tz` pragma
 * fails loudly instead of quietly re-running the same device three times.
 *
 * No `Date.now()` anywhere: every instant is built with `zonedTimeToUtc`.
 */
import {
  EASTERN_TIME_ZONE,
  eventTimeZone,
  zonedParts,
  zonedTimeToUtc,
} from "@events-os/shared";
import {
  calendarMsToZonedTs,
  formatTimeInZone,
  parseDateTimeInput,
  withZonedTime,
  zonedDayToCalendarMs,
} from "./format";

// `@types/jest` isn't installed in this workspace, so every colocated
// `*.test.ts` here already contributes "Cannot find name 'describe'" noise to
// `tsc --noEmit`. Declared locally rather than adding more to that pile — a
// workspace-wide `jest/globals.d.ts` is the real fix and doesn't belong here.
declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void) => void;
declare const expect: (actual: unknown) => {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  not: { toBe(expected: unknown): void };
};

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * Exactly what `DateTimePanel` does when someone taps a day and then a time:
 * the `Calendar` hands back a DEVICE-local midnight, which is translated at the
 * boundary into the event's zone. Driving the real exported helpers is the
 * point — a re-implementation here would only test the test.
 */
function pickInPanel(
  current: number,
  pick: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): number {
  const dayMs = new Date(pick.year, pick.month - 1, pick.day).getTime();
  const held = zonedParts(current, timeZone);
  const afterDay = calendarMsToZonedTs(dayMs, held.hour, held.minute, timeZone);
  return withZonedTime(afterDay, pick.hour, pick.minute, timeZone);
}

/** Register the whole write-path suite for a device sitting in `deviceZone`. */
export function describeEventTimeWrite(deviceZone: string) {
  describe(`event time, written from a device in ${deviceZone}`, () => {
    it("really is running on that device — otherwise nothing below means anything", () => {
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(deviceZone);
    });

    it("picking 7:00 PM stores 7:00 PM AT THE EVENT", () => {
      const eventZone = eventTimeZone({
        eventDate: zonedTimeToUtc(
          { year: 2026, month: 8, day: 29, hour: 12, minute: 0 },
          EASTERN_TIME_ZONE,
        ),
      });
      const current = zonedTimeToUtc(
        { year: 2026, month: 8, day: 29, hour: 12, minute: 0 },
        eventZone,
      );

      const stored = pickInPanel(
        current,
        { year: 2026, month: 8, day: 29, hour: 19, minute: 0 },
        eventZone,
      );

      // The literal is the invariant: all three device files assert it.
      expect(new Date(stored).toISOString()).toBe("2026-08-29T23:00:00.000Z");
      expect(formatTimeInZone(stored, eventZone)).toBe("7:00 PM");
    });

    it("is what the old code got WRONG — the device-local write moved the event", () => {
      // Verbatim the line this change removed.
      const deviceLocal = new Date(2026, 7, 29, 19, 0).getTime();
      const readBack = formatTimeInZone(deviceLocal, EASTERN_TIME_ZONE);
      // Only a device already in the event's zone survived it, which is exactly
      // why the bug was invisible to everyone who could have caught it.
      if (deviceZone === EASTERN_TIME_ZONE) {
        expect(readBack).toBe("7:00 PM");
      } else {
        expect(readBack).not.toBe("7:00 PM");
      }
    });

    it("the new-event form stores the same start anchor", () => {
      const zone = eventTimeZone();
      const ts = parseDateTimeInput("2026-08-29", "19:00", zone);
      expect(ts).toBe(
        Date.parse("2026-08-29T23:00:00.000Z"),
      );
      expect(formatTimeInZone(ts as number, zone)).toBe("7:00 PM");
    });

    it("a run-of-show cell commits the same minute offset", () => {
      const eventDate = zonedTimeToUtc(
        { year: 2026, month: 8, day: 29, hour: 17, minute: 0 },
        EASTERN_TIME_ZONE,
      );
      // The cell commits `round((typed − eventStart) / MINUTE_MS)`.
      const typed = withZonedTime(eventDate, 18, 30, EASTERN_TIME_ZONE);
      expect(Math.round((typed - eventDate) / MINUTE)).toBe(90);
      expect(formatTimeInZone(typed, EASTERN_TIME_ZONE)).toBe("6:30 PM");
    });

    it("the calendar bridge survives a device that disagrees about the DAY", () => {
      // 11:00 PM Eastern is already tomorrow in Tokyo. The month grid must still
      // highlight Aug 29, and re-picking it must be a no-op, not a 24h jump.
      const lateNight = zonedTimeToUtc(
        { year: 2026, month: 8, day: 29, hour: 23, minute: 0 },
        EASTERN_TIME_ZONE,
      );
      const dayMs = zonedDayToCalendarMs(lateNight, EASTERN_TIME_ZONE);
      const d = new Date(dayMs);
      expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 8, 29]);
      expect(calendarMsToZonedTs(dayMs, 23, 0, EASTERN_TIME_ZONE)).toBe(lateNight);
    });

    it("the calendar bridge is an identity for every day of a year", () => {
      // The one device-dependent step in the picker. If it drifted by a day for
      // any date, an event would silently move by 24 hours.
      const start = zonedTimeToUtc(
        { year: 2026, month: 1, day: 1, hour: 14, minute: 0 },
        EASTERN_TIME_ZONE,
      );
      for (let i = 0; i < 365; i++) {
        const ts = start + i * 24 * HOUR;
        const p = zonedParts(ts, EASTERN_TIME_ZONE);
        const back = calendarMsToZonedTs(
          zonedDayToCalendarMs(ts, EASTERN_TIME_ZONE),
          p.hour,
          p.minute,
          EASTERN_TIME_ZONE,
        );
        expect(new Date(back).toISOString()).toBe(new Date(ts).toISOString());
      }
    });

    it("reads the same date string as a different instant per zone — the whole point", () => {
      const ny = parseDateTimeInput("2026-08-29", "19:00", "America/New_York") as number;
      const la = parseDateTimeInput(
        "2026-08-29",
        "19:00",
        "America/Los_Angeles",
      ) as number;
      const tokyo = parseDateTimeInput("2026-08-29", "19:00", "Asia/Tokyo") as number;
      expect(la - ny).toBe(3 * HOUR);
      expect(ny - tokyo).toBe(13 * HOUR);
    });

    it("rejects malformed input rather than guessing", () => {
      const z = EASTERN_TIME_ZONE;
      expect(parseDateTimeInput("07/24/2026", "10:40", z)).toBe(null);
      expect(parseDateTimeInput("2026-07-24", "25:99", z)).toBe(null);
      expect(parseDateTimeInput("2026-07-24", "", z)).toBe(null);
      expect(parseDateTimeInput("", "10:40", z)).toBe(null);
      expect(parseDateTimeInput("2026-13-01", "10:40", z)).toBe(null);
    });

    describe("DST — the two hours a wall clock is not a function", () => {
      // US DST in 2026: forward Sun 8 March, back Sun 1 November.
      it("spring forward: a nonexistent 2:30 AM moves FORWARD to 3:30 AM, never back", () => {
        const ts = zonedTimeToUtc(
          { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
          EASTERN_TIME_ZONE,
        );
        expect(formatTimeInZone(ts, EASTERN_TIME_ZONE)).toBe("3:30 AM");
        // The previous two-pass implementation landed on 1:30 AM here — an hour
        // EARLIER than typed, a picker that silently moved the event backwards.
        expect(formatTimeInZone(ts, EASTERN_TIME_ZONE)).not.toBe("1:30 AM");
        // 1:30 AM that morning is a real time and is untouched.
        expect(
          formatTimeInZone(
            zonedTimeToUtc(
              { year: 2026, month: 3, day: 8, hour: 1, minute: 30 },
              EASTERN_TIME_ZONE,
            ),
            EASTERN_TIME_ZONE,
          ),
        ).toBe("1:30 AM");
      });

      it("spring forward: the gap has no width to store, and the day is 23 hours", () => {
        const at = (hour: number, minute: number) =>
          zonedTimeToUtc(
            { year: 2026, month: 3, day: 8, hour, minute },
            EASTERN_TIME_ZONE,
          );
        expect(at(2, 0)).toBe(at(3, 0));
        expect(at(4, 0) - at(0, 0)).toBe(3 * HOUR);
      });

      it("fall back: an ambiguous 1:30 AM takes the FIRST occurrence, and the day is 25 hours", () => {
        const ts = zonedTimeToUtc(
          { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
          EASTERN_TIME_ZONE,
        );
        expect(new Date(ts).toISOString()).toBe("2026-11-01T05:30:00.000Z");
        expect(formatTimeInZone(ts, EASTERN_TIME_ZONE)).toBe("1:30 AM");
        const midnight = zonedTimeToUtc(
          { year: 2026, month: 11, day: 1, hour: 0, minute: 0 },
          EASTERN_TIME_ZONE,
        );
        const nextMidnight = zonedTimeToUtc(
          { year: 2026, month: 11, day: 2, hour: 0, minute: 0 },
          EASTERN_TIME_ZONE,
        );
        expect(nextMidnight - midnight).toBe(25 * HOUR);
      });

      it("a 7:00 PM event is 7:00 PM on both sides of both transitions", () => {
        for (const [month, day] of [
          [3, 7],
          [3, 8],
          [3, 9],
          [10, 31],
          [11, 1],
          [11, 2],
        ]) {
          const iso = `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const ts = parseDateTimeInput(iso, "19:00", EASTERN_TIME_ZONE) as number;
          expect(formatTimeInZone(ts, EASTERN_TIME_ZONE)).toBe("7:00 PM");
        }
        // And the two sides are a real 47 hours apart in March (23-hour day) and
        // 49 in November (25-hour day) — the test can't pass by nothing moving.
        const marBefore = parseDateTimeInput(
          "2026-03-07",
          "19:00",
          EASTERN_TIME_ZONE,
        ) as number;
        const marAfter = parseDateTimeInput(
          "2026-03-09",
          "19:00",
          EASTERN_TIME_ZONE,
        ) as number;
        expect(marAfter - marBefore).toBe(47 * HOUR);
        const novBefore = parseDateTimeInput(
          "2026-10-31",
          "19:00",
          EASTERN_TIME_ZONE,
        ) as number;
        const novAfter = parseDateTimeInput(
          "2026-11-02",
          "19:00",
          EASTERN_TIME_ZONE,
        ) as number;
        expect(novAfter - novBefore).toBe(49 * HOUR);
      });

      it("a run of show crossing the spring-forward hour keeps its wall clock and never goes backwards", () => {
        const rows = [
          { day: 7, hour: 23 },
          { day: 8, hour: 0 },
          { day: 8, hour: 1 },
          { day: 8, hour: 3 },
          { day: 8, hour: 4 },
        ].map(({ day, hour }) =>
          zonedTimeToUtc(
            { year: 2026, month: 3, day, hour, minute: 0 },
            EASTERN_TIME_ZONE,
          ),
        );
        expect(rows.map((t) => formatTimeInZone(t, EASTERN_TIME_ZONE))).toEqual([
          "11:00 PM",
          "12:00 AM",
          "1:00 AM",
          "3:00 AM",
          "4:00 AM",
        ]);
        for (let i = 1; i < rows.length; i++) {
          expect(rows[i] > rows[i - 1]).toBe(true);
        }
        // 1:00 AM → 3:00 AM is ONE real hour, not two.
        expect(rows[3] - rows[2]).toBe(HOUR);
      });

      it("a 30-minute DST shift is handled too — the offset is probed, never assumed", () => {
        // Lord Howe Island moves the clock by 30 minutes, which any hard-coded
        // "shift by an hour" fallback gets wrong.
        const zone = "Australia/Lord_Howe";
        const ts = zonedTimeToUtc(
          { year: 2026, month: 10, day: 4, hour: 3, minute: 0 },
          zone,
        );
        expect(formatTimeInZone(ts, zone)).toBe("3:00 AM");
      });
    });
  });
}
