import { describe, expect, test } from "@jest/globals";
import {
  describeCondition,
  describeGroupSentence,
  summarizeTargeting,
  targetingSentences,
  toWireTargeting,
  type Targeting,
  type TargetingCondition,
  type UiGroup,
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

  // REGRESSION — `attended_any` was the only condition whose unresolved-id
  // fallback ERASED its qualifier instead of naming it: a chapter-scoped
  // "been to an event" read as "an event", one article away from the
  // unscoped "any event". `summarizeTargeting` passes no lookups AT ALL by
  // design, so every row of the segments list hit this fallback permanently,
  // and migration 0042 emits exactly this shape for wrapped legacy guests
  // audiences that carried a chapter filter.
  test("a chapter-scoped 'been to an event' still says so with no lookups", () => {
    const scoped: TargetingCondition = {
      field: "attended_any",
      op: "has",
      chapterId: "ch_1" as never,
      withinDays: 90,
    };
    const unscoped: TargetingCondition = { field: "attended_any", op: "has", withinDays: 90 };

    expect(describeCondition(scoped)).toBe(
      "has been to an event in the chosen chapter in the last 90 days",
    );
    expect(describeCondition(scoped, { chapterName: () => "Nairobi" })).toBe(
      "has been to an event in Nairobi in the last 90 days",
    );
    // The whole point: one chapter's attendees must never read like everyone
    // who ever attended anything.
    expect(describeCondition(scoped)).not.toBe(describeCondition(unscoped));
    expect(summarizeTargeting({ groups: [{ conditions: [scoped] }] })).not.toBe(
      summarizeTargeting({ groups: [{ conditions: [unscoped] }] }),
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

  // REGRESSION — a group that is empty ONLY because its rows are unfinished is
  // not "everyone", and a group with one finished row plus one unfinished one
  // is narrower than that finished row alone.
  test("an unfinished row reads as unfinished, never as no restriction", () => {
    expect(describeGroupSentence([], {}, 1)).toBe("anyone who matches a line you haven't finished yet");
    expect(describeGroupSentence([], {}, 2)).toBe("anyone who matches 2 lines you haven't finished yet");
    expect(describeGroupSentence([], {}, 1)).not.toBe("everyone");
    expect(
      describeGroupSentence([{ field: "donor_status", op: "is", status: "active" }], {}, 1),
    ).toBe("anyone who is an active donor and matches a line you haven't finished yet");
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
