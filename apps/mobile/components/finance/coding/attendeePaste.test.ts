import { describe, expect, test } from "@jest/globals";
import { capBulkAdditions, parseAttendeePaste } from "./attendeePaste";

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

describe("capBulkAdditions", () => {
  test("accepts everything when there's room for it all", () => {
    const result = capBulkAdditions(["a", "b", "c"], 2, 15);
    expect(result).toEqual({ accepted: ["a", "b", "c"], overflow: 0 });
  });

  test("FINDING 1 repro: 3 existing + 20 pasted, threshold 15 — caps at 12 and reports the other 8 as overflow", () => {
    const pasted = Array.from({ length: 20 }, (_, i) => ({
      name: `Person ${i + 1}`,
      affiliation: "team" as const,
    }));
    const result = capBulkAdditions(pasted, 3, 15);
    expect(result.accepted).toHaveLength(12);
    expect(result.accepted[0]).toEqual({ name: "Person 1", affiliation: "team" });
    expect(result.accepted[11]).toEqual({ name: "Person 12", affiliation: "team" });
    expect(result.overflow).toBe(8);
  });

  test("no room left at all — every candidate overflows, nothing accepted", () => {
    const result = capBulkAdditions(["a", "b"], 15, 15);
    expect(result).toEqual({ accepted: [], overflow: 2 });
  });

  test("existingCount already over the max — still no negative room, nothing accepted", () => {
    const result = capBulkAdditions(["a"], 20, 15);
    expect(result).toEqual({ accepted: [], overflow: 1 });
  });

  test("empty candidates list — accepted empty, no overflow", () => {
    expect(capBulkAdditions([], 5, 15)).toEqual({ accepted: [], overflow: 0 });
  });
});
