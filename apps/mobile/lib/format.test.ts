/**
 * The zoned time formatters — the ones event surfaces must use.
 *
 * These exist because Day-of rendered its run sheet with the DEVICE's clock
 * while the volunteer briefing pinned the event's zone, so the same run of show
 * read 5:00 PM in New York, 2:00 PM in Los Angeles and 6:00 AM in Tokyo. The
 * point of every assertion below is the same: the answer must not depend on
 * where the machine running it happens to be.
 *
 * No `Date.now()`. Every input is a fixed instant built with `zonedTimeToUtc`,
 * which is a real inverse of the formatters rather than a hand-computed offset —
 * so these read the same on a UTC CI box and on a laptop in Denver, in July and
 * in December.
 */
import {
  EASTERN_TIME_ZONE,
  eventTimeZone,
  zonedTimeToUtc,
} from "@events-os/shared";
import {
  canFormatZone,
  formatDateTimeInZone,
  formatTimeInZone,
  zoneAbbreviation,
} from "./format";

// `@types/jest` isn't installed in this workspace, so every colocated
// `*.test.ts` here already contributes "Cannot find name 'describe'" noise to
// `tsc --noEmit`. Declared locally rather than adding two dozen more lines of it
// to that pile — a workspace-wide `jest/globals.d.ts` would be the real fix, and
// that cleanup doesn't belong in a bug fix.
declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void) => void;
declare const expect: (actual: unknown) => {
  toBe(expected: unknown): void;
  not: { toBe(expected: unknown): void };
};

/** 5:00 PM Eastern on 2026-08-29 — the load-in of a real upcoming event. */
const LOAD_IN = zonedTimeToUtc(
  { year: 2026, month: 8, day: 29, hour: 17, minute: 0 },
  EASTERN_TIME_ZONE,
);

describe("formatTimeInZone", () => {
  it("renders the event's clock, not the device's", () => {
    // One instant. Three zones. Three different wall clocks — which is exactly
    // why the zone has to be chosen deliberately instead of inherited.
    expect(formatTimeInZone(LOAD_IN, EASTERN_TIME_ZONE)).toBe("5:00 PM");
    expect(formatTimeInZone(LOAD_IN, "America/Los_Angeles")).toBe("2:00 PM");
    expect(formatTimeInZone(LOAD_IN, "Asia/Tokyo")).toBe("6:00 AM");
  });

  it("is stable across a DST boundary — a zone, never a fixed offset", () => {
    // 7:00 PM Eastern either side of the 2026 US spring-forward. A hard-coded
    // −05:00 or −04:00 anywhere in the chain slips one of these by an hour.
    const beforeDst = zonedTimeToUtc(
      { year: 2026, month: 3, day: 7, hour: 19, minute: 0 },
      EASTERN_TIME_ZONE,
    );
    const afterDst = zonedTimeToUtc(
      { year: 2026, month: 3, day: 9, hour: 19, minute: 0 },
      EASTERN_TIME_ZONE,
    );
    expect(formatTimeInZone(beforeDst, EASTERN_TIME_ZONE)).toBe("7:00 PM");
    expect(formatTimeInZone(afterDst, EASTERN_TIME_ZONE)).toBe("7:00 PM");
    // The two instants really are 47h apart, not 48 — the clock moved.
    expect(afterDst - beforeDst).toBe(47 * 60 * 60 * 1000);
  });

  it("agrees with the zone the shared resolver hands out", () => {
    // The screens never name a zone; they format with `eventTimeZone(event)`.
    // This is that composition, asserted end to end.
    expect(formatTimeInZone(LOAD_IN, eventTimeZone({ eventDate: LOAD_IN }))).toBe(
      "5:00 PM",
    );
    expect(
      formatTimeInZone(
        LOAD_IN,
        eventTimeZone({ eventDate: LOAD_IN, timeZone: "Asia/Tokyo" }),
      ),
    ).toBe("6:00 AM");
  });
});

describe("formatDateTimeInZone", () => {
  it("carries the date across a zone that flips the calendar day", () => {
    // 5 PM Eastern on the 29th is already the 30th in Tokyo. A date rendered
    // device-locally beside a time rendered in the event's zone would show a
    // day that never existed.
    expect(formatDateTimeInZone(LOAD_IN, EASTERN_TIME_ZONE)).toBe(
      "Aug 29, 2026 · 5:00 PM",
    );
    expect(formatDateTimeInZone(LOAD_IN, "Asia/Tokyo")).toBe(
      "Aug 30, 2026 · 6:00 AM",
    );
  });
});

describe("zoneAbbreviation", () => {
  it("names the clock the reader is looking at, and tracks DST", () => {
    expect(zoneAbbreviation(LOAD_IN, EASTERN_TIME_ZONE)).toBe("EDT");
    const january = zonedTimeToUtc(
      { year: 2026, month: 1, day: 15, hour: 12, minute: 0 },
      EASTERN_TIME_ZONE,
    );
    expect(zoneAbbreviation(january, EASTERN_TIME_ZONE)).toBe("EST");
  });

  it("returns empty rather than a wrong label when the zone is unusable", () => {
    // Nothing truthful to claim → the screens fall back to "your local time".
    expect(zoneAbbreviation(LOAD_IN, "Not/AZone")).toBe("");
    expect(canFormatZone("Not/AZone")).toBe(false);
    expect(canFormatZone(EASTERN_TIME_ZONE)).toBe(true);
  });
});
