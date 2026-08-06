// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors the sibling colocated tests).
import { describe, expect, test } from "@jest/globals";
import { checkInProgress, filterAttendees } from "./attendeeList";

const roster = [
  { attendeeName: "Ada Okafor", status: "valid" as const },
  { attendeeName: "Ben Buyer", status: "checked_in" as const },
  { attendeeName: "Chidi Eze", status: "void" as const },
];

describe("filterAttendees", () => {
  test("empty query returns everyone", () => {
    expect(filterAttendees(roster, "   ")).toHaveLength(3);
  });

  test("matches name substrings case-insensitively", () => {
    expect(filterAttendees(roster, "ben").map((a) => a.attendeeName)).toEqual(["Ben Buyer"]);
    expect(filterAttendees(roster, "OKAFOR").map((a) => a.attendeeName)).toEqual(["Ada Okafor"]);
  });

  test("no match returns empty", () => {
    expect(filterAttendees(roster, "zed")).toEqual([]);
  });
});

describe("checkInProgress", () => {
  test("void tickets count toward neither side of the tally", () => {
    expect(checkInProgress(roster)).toEqual({ checkedIn: 1, total: 2 });
  });
});
