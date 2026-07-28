import { describe, expect, test } from "@jest/globals";
import {
  describeCondition,
  describeGroupSentence,
  summarizeTargeting,
  targetingSentences,
  type Targeting,
  type TargetingCondition,
} from "./targetingText";

/** The founder's benchmark segment: "came to an event in the last 90 days,
 *  except staff" — one rule group, one exclusion. */
const BENCHMARK: Targeting = {
  groups: [{ conditions: [{ field: "attended_any", op: "has", withinDays: 90 }] }],
  excludeGroups: [{ conditions: [{ field: "kind", op: "is", kind: "team" }] }],
};

describe("describeCondition", () => {
  test("reads as the sentence the row's controls spell", () => {
    expect(describeCondition({ field: "attended_any", op: "has", withinDays: 90 })).toBe(
      "has been to any event in the last 90 days",
    );
    expect(describeCondition({ field: "kind", op: "is", kind: "team" })).toBe("is a team member");
    expect(describeCondition({ field: "last_gift", op: "not_within_days", days: 365 })).toBe(
      "hasn't given in the last 365 days",
    );
  });

  test("names the chosen event/role/chapter when a lookup can resolve it", () => {
    const cond: TargetingCondition = {
      field: "seat",
      op: "not_holds",
      seatId: "seat_1" as TargetingCondition extends { seatId: infer S } ? S : never,
    };
    expect(describeCondition(cond, { seatTitle: () => "Worship Leader" })).toBe(
      "is not Worship Leader",
    );
    // Nothing resolved yet (options still loading) still reads as a sentence.
    expect(describeCondition(cond)).toBe("is not the chosen role");
  });
});

describe("describeGroupSentence", () => {
  test("AND-joins the lines inside one rule group", () => {
    expect(
      describeGroupSentence([
        { field: "attended_any", op: "has", withinDays: 90 },
        { field: "donor_status", op: "is", status: "active" },
      ]),
    ).toBe("anyone who has been to any event in the last 90 days and is an active donor");
  });

  test("an empty rule group says 'everyone' rather than a dangling 'anyone who'", () => {
    expect(describeGroupSentence([])).toBe("everyone");
  });
});

describe("targetingSentences — the plain-English recap", () => {
  test("reads the benchmark segment back as what it actually means", () => {
    expect(targetingSentences(BENCHMARK)).toEqual({
      send: ["anyone who has been to any event in the last 90 days"],
      skip: ["anyone who is a team member"],
    });
  });

  test("one phrase per rule group, so the caller can draw the OR between them", () => {
    // Rule groups OR with each other — the relationship the UI now shows as a
    // divider rather than only stating in a hint.
    const twoGroups: Targeting = {
      groups: [
        { conditions: [{ field: "donor_status", op: "is", status: "active" }] },
        { conditions: [{ field: "backer", op: "is", status: "active" }] },
      ],
    };
    expect(targetingSentences(twoGroups).send).toEqual([
      "anyone who is an active donor",
      "anyone who is an active backer",
    ]);
  });

  test("exclusions are listed separately too — they OR with each other", () => {
    // "Skip anyone who is a Worship Leader OR a Tech Lead" is TWO exclusions;
    // the recap has to show them as two phrases, not one AND-ed sentence.
    const twoExclusions: Targeting = {
      groups: [{ conditions: [] }],
      excludeGroups: [
        { conditions: [{ field: "seat", op: "holds", seatId: "s1" as never }] },
        { conditions: [{ field: "seat", op: "holds", seatId: "s2" as never }] },
      ],
    };
    const lookups = {
      seatTitle: (id: string) => (id === "s1" ? "Worship Leader" : "Tech Lead"),
    };
    expect(targetingSentences(twoExclusions, lookups)).toEqual({
      send: ["everyone"],
      skip: ["anyone who is Worship Leader", "anyone who is Tech Lead"],
    });
  });

  test("a brand-new, empty segment reads as 'everyone' rather than blank", () => {
    expect(targetingSentences({ groups: [] })).toEqual({ send: ["everyone"], skip: [] });
  });
});

describe("summarizeTargeting — the segment list line", () => {
  test("uses the segment vocabulary, not the old skip-list/group words", () => {
    const summary = summarizeTargeting(BENCHMARK, { includeCount: 2 });
    expect(summary).toBe(
      "Anyone who has been to any event in the last 90 days · 1 exclusion · +2 hand-picked",
    );
    expect(summary).not.toMatch(/skip list/i);
  });

  test("counts extra rule groups by that name", () => {
    const many: Targeting = {
      groups: [
        { conditions: [{ field: "donor_status", op: "is", status: "active" }] },
        { conditions: [] },
        { conditions: [] },
      ],
    };
    expect(summarizeTargeting(many)).toBe("Anyone who is an active donor · or 2 more rule groups");
  });

  test("an empty definition is described as everyone", () => {
    expect(summarizeTargeting({ groups: [{ conditions: [] }] })).toBe("Everyone");
  });
});
