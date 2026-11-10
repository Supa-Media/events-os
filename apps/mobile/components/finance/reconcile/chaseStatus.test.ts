import { describe, expect, test } from "@jest/globals";
import { chaseStatusLine } from "./chaseStatus";

// Sun 2026-11-08 10:05am EST.
const now = Date.UTC(2026, 10, 8, 15, 5);

describe("chaseStatusLine", () => {
  test("chased, no reminder yet", () => {
    expect(
      chaseStatusLine(
        { chasedAt: Date.UTC(2026, 10, 8, 15, 2), reminderCount: 0, chaserTold: false },
        now,
      ),
    ).toBe("Chased today 10:02am · daily reminders start tomorrow evening");
  });

  test("reminded, with the last time", () => {
    expect(
      chaseStatusLine(
        {
          chasedAt: Date.UTC(2026, 10, 6, 21, 28),
          lastRemindedAt: Date.UTC(2026, 10, 8, 0, 0),
          reminderCount: 1,
          chaserTold: false,
        },
        now,
      ),
    ).toBe("Chased Fri, Nov 6 4:28pm · 1 reminder, last yesterday 7:00pm");
  });

  test("says when the chaser was told", () => {
    expect(
      chaseStatusLine(
        {
          chasedAt: Date.UTC(2026, 10, 2, 15, 0),
          lastRemindedAt: Date.UTC(2026, 10, 7, 0, 0),
          reminderCount: 5,
          chaserTold: true,
        },
        now,
      ),
    ).toBe("Chased Mon, Nov 2 10:00am · 5 reminders, last Fri, Nov 6 7:00pm · chaser emailed");
  });
});
