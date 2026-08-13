import { describe, expect, test } from "@jest/globals";
import {
  HARD_BULK_ATTENDEE_CAP,
  mergeBulkAttendees,
  parseAttendeePaste,
} from "./attendeePaste";

describe("parseAttendeePaste — newline-broken lists", () => {
  test("a plain list of names, one per line, defaults to team", () => {
    expect(parseAttendeePaste("Alice\nBob\nCharlie")).toEqual([
      { name: "Alice", affiliation: "team" },
      { name: "Bob", affiliation: "team" },
      { name: "Charlie", affiliation: "team" },
    ]);
  });

  test("blank lines and surrounding whitespace are ignored", () => {
    expect(parseAttendeePaste("  Alice  \n\n\nBob\n   \n")).toEqual([
      { name: "Alice", affiliation: "team" },
      { name: "Bob", affiliation: "team" },
    ]);
  });

  test("handles CRLF line endings", () => {
    expect(parseAttendeePaste("Alice\r\nBob\r\n")).toEqual([
      { name: "Alice", affiliation: "team" },
      { name: "Bob", affiliation: "team" },
    ]);
  });

  test("handles BARE CR line endings (classic-Mac / some spreadsheet exports) without folding the next line into the previous one's cells", () => {
    // FINDING 2 repro (adversarial review, 2026-08-13): a bare "\r" with no
    // following "\n" used to fail to split at all, so "Bob\tguest" got
    // folded into the cell after "team" instead of starting a new line —
    // Bob vanished and Alice mis-read as affiliated with the unrecognized
    // cell "team\rBob".
    expect(parseAttendeePaste("Alice\tteam\rBob\tguest\r")).toEqual([
      { name: "Alice", affiliation: "team" },
      { name: "Bob", affiliation: "guest" },
    ]);
  });
});

describe("parseAttendeePaste — CSV-ish NAME, AFFILIATION lines", () => {
  test("comma-separated, affiliation label matched case-insensitively", () => {
    expect(parseAttendeePaste("Alice, Volunteer\nBob, GUEST")).toEqual([
      { name: "Alice", affiliation: "volunteer" },
      { name: "Bob", affiliation: "guest" },
    ]);
  });

  test("tab-separated, affiliation KEY matched case-insensitively", () => {
    expect(parseAttendeePaste("Alice\tteam\nBob\tCONTRACTOR")).toEqual([
      { name: "Alice", affiliation: "team" },
      { name: "Bob", affiliation: "contractor" },
    ]);
  });

  test("semicolon-separated", () => {
    expect(parseAttendeePaste("Alice;volunteer\nBob;guest")).toEqual([
      { name: "Alice", affiliation: "volunteer" },
      { name: "Bob", affiliation: "guest" },
    ]);
  });

  test("underscored key matches its spaced display label and vice versa", () => {
    expect(
      parseAttendeePaste("Alice, community_member\nBob, Community member"),
    ).toEqual([
      { name: "Alice", affiliation: "community_member" },
      { name: "Bob", affiliation: "community_member" },
    ]);
  });
});

describe("parseAttendeePaste — affiliation carries forward", () => {
  test("a line with no recognizable affiliation uses the MOST RECENTLY USED one from earlier in the paste", () => {
    expect(
      parseAttendeePaste("Alice, volunteer\nBob\nCharlie, guest\nDana"),
    ).toEqual([
      { name: "Alice", affiliation: "volunteer" },
      { name: "Bob", affiliation: "volunteer" },
      { name: "Charlie", affiliation: "guest" },
      { name: "Dana", affiliation: "guest" },
    ]);
  });

  test("falls back to team when nothing has set an affiliation yet, and honors an explicit starting affiliation from the form's existing rows", () => {
    expect(parseAttendeePaste("Alice\nBob")).toEqual([
      { name: "Alice", affiliation: "team" },
      { name: "Bob", affiliation: "team" },
    ]);
    expect(
      parseAttendeePaste("Alice\nBob", { lastAffiliation: "volunteer" }),
    ).toEqual([
      { name: "Alice", affiliation: "volunteer" },
      { name: "Bob", affiliation: "volunteer" },
    ]);
  });
});

describe("parseAttendeePaste — dedupe", () => {
  test("skips a pasted name that already exists on the form, case-insensitively", () => {
    expect(
      parseAttendeePaste("alice\nBob", { existingNames: ["Alice"] }),
    ).toEqual([{ name: "Bob", affiliation: "team" }]);
  });

  test("skips a duplicate that appears twice within the SAME paste", () => {
    expect(parseAttendeePaste("Alice\nalice\nALICE\nBob")).toEqual([
      { name: "Alice", affiliation: "team" },
      { name: "Bob", affiliation: "team" },
    ]);
  });
});

describe("parseAttendeePaste — multi-name lines with no affiliation token", () => {
  test("a single line with >2 comma cells and no affiliation match reads as multiple names", () => {
    expect(parseAttendeePaste("Alice, Bob, Charlie")).toEqual([
      { name: "Alice", affiliation: "team" },
      { name: "Bob", affiliation: "team" },
      { name: "Charlie", affiliation: "team" },
    ]);
  });

  test("the multi-name heuristic still applies the carried-forward affiliation", () => {
    expect(
      parseAttendeePaste("Erin, volunteer\nAlice, Bob, Charlie"),
    ).toEqual([
      { name: "Erin", affiliation: "volunteer" },
      { name: "Alice", affiliation: "volunteer" },
      { name: "Bob", affiliation: "volunteer" },
      { name: "Charlie", affiliation: "volunteer" },
    ]);
  });

  test(">2 cells with a SHARED TRAILING affiliation match every other cell as a name carrying it (FINDING 3 fix, adversarial review 2026-08-13 — previously kept only the first name and silently dropped the rest)", () => {
    expect(parseAttendeePaste("Alice, Bob, volunteer")).toEqual([
      { name: "Alice", affiliation: "volunteer" },
      { name: "Bob", affiliation: "volunteer" },
    ]);
  });

  test(">2 cells with a shared trailing match still applies to every OTHER cell, not just two", () => {
    expect(parseAttendeePaste("Alice, Bob, Charlie, guest")).toEqual([
      { name: "Alice", affiliation: "guest" },
      { name: "Bob", affiliation: "guest" },
      { name: "Charlie", affiliation: "guest" },
    ]);
  });

  test(">2 cells where the affiliation match is NOT in the last position keeps the old name+affiliation reading (only the first cell is the name)", () => {
    // Deliberately narrower than the trailing case: "Alice, volunteer, Bob"
    // doesn't read as unambiguously "two names sharing one affiliation
    // column" the way a TRAILING match does, so this keeps the original
    // NAME, AFFILIATION reading rather than guessing "Bob" is a second name.
    expect(parseAttendeePaste("Alice, volunteer, Bob")).toEqual([
      { name: "Alice", affiliation: "volunteer" },
    ]);
  });

  test("exactly two cells with no affiliation match keeps only the first cell as the name", () => {
    expect(parseAttendeePaste("Alice, Someplace")).toEqual([
      { name: "Alice", affiliation: "team" },
    ]);
  });
});

describe("parseAttendeePaste — empty input", () => {
  test("empty string parses to no attendees", () => {
    expect(parseAttendeePaste("")).toEqual([]);
  });

  test("whitespace-only string parses to no attendees", () => {
    expect(parseAttendeePaste("   \n\n  ")).toEqual([]);
  });
});

describe("mergeBulkAttendees — the prune-down merge", () => {
  const person = (name: string) => ({ name, affiliation: "team" as const });

  test("FOUNDER SCENARIO (2026-08-13 report): headcount typed 12, empty rows, 18-person team — the WHOLE team lands, headcount follows", () => {
    // The shipped version mapped over the raw (empty) attendees state and
    // wrote nothing while reporting "Added 12 of 18". The merge writes the
    // roster outright: all 18 in, prune from there.
    const team = Array.from({ length: 18 }, (_, i) => person(`Member ${i + 1}`));
    const result = mergeBulkAttendees([], team);
    expect(result.merged).toHaveLength(18);
    expect(result.added).toBe(18);
    expect(result.capped).toBe(0);
    expect(result.deduped).toBe(0);
    expect(result.merged[0].name).toBe("Member 1");
    expect(result.merged[17].name).toBe("Member 18");
  });

  test("already-filled rows are kept first; duplicates (case-insensitive) are dropped and counted", () => {
    const existing = [person("Alice"), { name: "", affiliation: "team" as const }, person("Bob")];
    const result = mergeBulkAttendees(existing, [person("alice"), person("Cara")]);
    expect(result.merged.map((r) => r.name)).toEqual(["Alice", "Bob", "Cara"]);
    expect(result.added).toBe(1);
    expect(result.deduped).toBe(1);
  });

  test("blank-named additions are ignored entirely", () => {
    const result = mergeBulkAttendees([person("Alice")], [person("  "), person("Bea")]);
    expect(result.merged.map((r) => r.name)).toEqual(["Alice", "Bea"]);
    expect(result.deduped).toBe(0);
  });

  test("only the HARD cap drops anyone — never the names threshold", () => {
    const crowd = Array.from({ length: HARD_BULK_ATTENDEE_CAP + 10 }, (_, i) =>
      person(`P${i + 1}`),
    );
    const result = mergeBulkAttendees([], crowd);
    expect(result.merged).toHaveLength(HARD_BULK_ATTENDEE_CAP);
    expect(result.capped).toBe(10);
    // Well past the 15-name threshold and everything still landed — the
    // threshold is where names stop being REQUIRED, not where the roster
    // stops being editable.
    expect(result.merged.length).toBeGreaterThan(15);
  });

  test("empty additions — a clean no-op", () => {
    expect(mergeBulkAttendees([person("Alice")], [])).toEqual({
      merged: [person("Alice")],
      added: 0,
      deduped: 0,
      capped: 0,
    });
  });
});
