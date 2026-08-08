// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors the sibling colocated tests).
import { describe, expect, test } from "@jest/globals";
import { checkInProgress, filterAttendees, teamStandings } from "./attendeeList";

const roster = [
  { attendeeName: "Ada Okafor", status: "valid" as const },
  { attendeeName: "Ben Buyer", status: "checked_in" as const },
  { attendeeName: "Chidi Eze", status: "void" as const },
];

/** A roster once the event assigns teams at the door. */
const teamed = [
  { attendeeName: "Ada Okafor", teamId: "t_blue", teamName: "Blue", teamColor: "blue" },
  { attendeeName: "Ben Buyer", teamId: "t_red", teamName: "Red", teamColor: "red" },
  { attendeeName: "Chidi Eze", teamId: "t_blue", teamName: "Blue", teamColor: "blue" },
  { attendeeName: "Dami Ade", teamId: null, teamName: null, teamColor: null },
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

  test("matches team names too, so the box doubles as 'show me Blue'", () => {
    expect(filterAttendees(teamed, "blue").map((a) => a.attendeeName)).toEqual([
      "Ada Okafor",
      "Chidi Eze",
    ]);
  });

  test("guests without a team are unaffected by team search", () => {
    expect(filterAttendees(teamed, "red").map((a) => a.attendeeName)).toEqual([
      "Ben Buyer",
    ]);
  });
});

describe("checkInProgress", () => {
  test("void tickets count toward neither side of the tally", () => {
    expect(checkInProgress(roster)).toEqual({ checkedIn: 1, total: 2 });
  });
});

describe("teamStandings", () => {
  test("counts per team, biggest first, ignoring the unplaced", () => {
    expect(teamStandings(teamed)).toEqual([
      { teamId: "t_blue", name: "Blue", color: "blue", count: 2 },
      { teamId: "t_red", name: "Red", color: "red", count: 1 },
    ]);
  });

  test("ties fall back to alphabetical so the strip doesn't reshuffle", () => {
    expect(
      teamStandings([
        { teamId: "t_red", teamName: "Red", teamColor: "red" },
        { teamId: "t_blue", teamName: "Blue", teamColor: "blue" },
      ]).map((s) => s.name),
    ).toEqual(["Blue", "Red"]);
  });

  test("nobody placed yet means no strip at all", () => {
    expect(
      teamStandings([{ teamId: null, teamName: null, teamColor: null }]),
    ).toEqual([]);
  });

  test("same-named teams stay separate — grouping is by id, not label", () => {
    expect(
      teamStandings([
        { teamId: "t_red", teamName: "Red", teamColor: "red" },
        { teamId: "t_crimson", teamName: "Red", teamColor: "crimson" },
      ]),
    ).toHaveLength(2);
  });
});
