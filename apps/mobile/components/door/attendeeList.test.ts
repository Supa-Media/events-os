// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors the sibling colocated tests).
import { describe, expect, test } from "@jest/globals";
import { checkInProgress, filterAttendees } from "./attendeeList";

const roster = [
  { attendeeName: "Ada Okafor", code: "PW-AGSZ-Q7AT", status: "valid" as const },
  { attendeeName: "Ben Buyer", code: "PW-78BK-ZVEB", status: "checked_in" as const },
  { attendeeName: "Chidi Eze", code: "PW-EKM8-ENAF", status: "void" as const },
];

describe("filterAttendees", () => {
  test("empty query returns everyone", () => {
    expect(filterAttendees(roster, "   ")).toHaveLength(3);
  });

  test("matches name substrings case-insensitively", () => {
    expect(filterAttendees(roster, "ben").map((a) => a.attendeeName)).toEqual(["Ben Buyer"]);
  });

  test("matches ticket codes with dashes and spaces ignored", () => {
    expect(filterAttendees(roster, "agsz q7").map((a) => a.code)).toEqual(["PW-AGSZ-Q7AT"]);
    expect(filterAttendees(roster, "pw-78bk").map((a) => a.code)).toEqual(["PW-78BK-ZVEB"]);
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
