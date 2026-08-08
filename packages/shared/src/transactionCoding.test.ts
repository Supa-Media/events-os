import { describe, expect, test } from "vitest";
import {
  ATTENDEE_AFFILIATIONS,
  ATTENDEE_AFFILIATION_LABELS,
  DEFAULT_CODING_REQUIRED_SINCE_MS,
  DEFAULT_MEAL_ATTENDEE_NAMES_MAX_HEADCOUNT,
  EXPENSE_TYPES,
  EXPENSE_TYPE_LABELS,
  MIN_PURPOSE_LENGTH,
  TRANSACTION_CODING_STATUSES,
  TRANSACTION_CODING_STATUS_LABELS,
  attendeeAffiliationBreakdown,
  codingFieldProblems,
  mealNamesRequired,
  type CodingAttendee,
  type TransactionCodingFields,
} from "./finance";

const GOOD_PURPOSE = "Travel to NY to film the Eden event with the team";

function attendees(n: number): CodingAttendee[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `Person ${i + 1}`,
    affiliation: "volunteer" as const,
  }));
}

function problems(fields: TransactionCodingFields, threshold?: number) {
  return codingFieldProblems(fields, threshold).map((p) => p.code);
}

describe("enum integrity", () => {
  test("every enum value has a label", () => {
    for (const t of EXPENSE_TYPES) expect(EXPENSE_TYPE_LABELS[t]).toBeTruthy();
    for (const a of ATTENDEE_AFFILIATIONS) {
      expect(ATTENDEE_AFFILIATION_LABELS[a]).toBeTruthy();
    }
    for (const s of TRANSACTION_CODING_STATUSES) {
      expect(TRANSACTION_CODING_STATUS_LABELS[s]).toBeTruthy();
    }
  });

  test("the policy date is September 1, 2026 UTC (owner decision, 2026-08-08)", () => {
    expect(new Date(DEFAULT_CODING_REQUIRED_SINCE_MS).toISOString()).toBe(
      "2026-09-01T00:00:00.000Z",
    );
  });

  test("the meal-names threshold is 15 (owner decision, 2026-08-08)", () => {
    expect(DEFAULT_MEAL_ATTENDEE_NAMES_MAX_HEADCOUNT).toBe(15);
    expect(mealNamesRequired(15)).toBe(true);
    expect(mealNamesRequired(16)).toBe(false);
  });
});

describe("codingFieldProblems — business purpose", () => {
  test("a vague stub is refused; a real purpose passes", () => {
    expect(
      problems({ expenseType: "general", businessPurpose: "bus to NY" }),
    ).toContain("PURPOSE_REQUIRED");
    expect(
      problems({ expenseType: "general", businessPurpose: GOOD_PURPOSE }),
    ).toEqual([]);
  });

  test("whitespace padding can't beat the floor", () => {
    const padded = "short".padEnd(MIN_PURPOSE_LENGTH + 5, " ");
    expect(
      problems({ expenseType: "general", businessPurpose: padded }),
    ).toContain("PURPOSE_REQUIRED");
  });
});

describe("codingFieldProblems — travel", () => {
  test("travel and lodging need a route; general doesn't", () => {
    expect(
      problems({ expenseType: "travel", businessPurpose: GOOD_PURPOSE }),
    ).toContain("TRAVEL_ROUTE_REQUIRED");
    expect(
      problems({ expenseType: "lodging", businessPurpose: GOOD_PURPOSE }),
    ).toContain("TRAVEL_ROUTE_REQUIRED");
    expect(
      problems({ expenseType: "general", businessPurpose: GOOD_PURPOSE }),
    ).toEqual([]);
  });

  test("a complete route passes; a half route doesn't", () => {
    expect(
      problems({
        expenseType: "travel",
        businessPurpose: GOOD_PURPOSE,
        travelFrom: "Boston",
        travelTo: "New York",
      }),
    ).toEqual([]);
    expect(
      problems({
        expenseType: "travel",
        businessPurpose: GOOD_PURPOSE,
        travelFrom: "Boston",
        travelTo: "  ",
      }),
    ).toContain("TRAVEL_ROUTE_REQUIRED");
  });
});

describe("codingFieldProblems — meals (names ≤ 15, headcount + group above)", () => {
  test("a meal needs a headcount", () => {
    expect(
      problems({ expenseType: "meal", businessPurpose: GOOD_PURPOSE }),
    ).toContain("HEADCOUNT_REQUIRED");
    expect(
      problems({
        expenseType: "meal",
        businessPurpose: GOOD_PURPOSE,
        headcount: 0,
      }),
    ).toContain("HEADCOUNT_REQUIRED");
  });

  test("at or under the threshold: every attendee named, count matching", () => {
    expect(
      problems({
        expenseType: "meal",
        businessPurpose: GOOD_PURPOSE,
        headcount: 4,
      }),
    ).toContain("ATTENDEES_REQUIRED");
    expect(
      problems({
        expenseType: "meal",
        businessPurpose: GOOD_PURPOSE,
        headcount: 4,
        attendees: attendees(3),
      }),
    ).toContain("ATTENDEE_COUNT_MISMATCH");
    expect(
      problems({
        expenseType: "meal",
        businessPurpose: GOOD_PURPOSE,
        headcount: 4,
        attendees: attendees(4),
      }),
    ).toEqual([]);
    // 15 exactly is still a names meal.
    expect(
      problems({
        expenseType: "meal",
        businessPurpose: GOOD_PURPOSE,
        headcount: 15,
        attendees: attendees(15),
      }),
    ).toEqual([]);
  });

  test("a blank attendee name is refused", () => {
    expect(
      problems({
        expenseType: "meal",
        businessPurpose: GOOD_PURPOSE,
        headcount: 2,
        attendees: [
          { name: "A. Person", affiliation: "team" },
          { name: "   ", affiliation: "guest" },
        ],
      }),
    ).toContain("ATTENDEE_NAME_REQUIRED");
  });

  test("over the threshold: group description instead of names", () => {
    expect(
      problems({
        expenseType: "meal",
        businessPurpose: GOOD_PURPOSE,
        headcount: 16,
      }),
    ).toContain("GROUP_DESCRIPTION_REQUIRED");
    expect(
      problems({
        expenseType: "meal",
        businessPurpose: GOOD_PURPOSE,
        headcount: 16,
        attendees: attendees(16),
      }),
    ).toContain("ATTENDEES_OVER_THRESHOLD");
    expect(
      problems({
        expenseType: "meal",
        businessPurpose: GOOD_PURPOSE,
        headcount: 16,
        groupDescription: "Volunteers writing and producing the album",
      }),
    ).toEqual([]);
  });

  test("the threshold is configurable (org setting)", () => {
    // With a threshold of 5, a 6-person meal is a group meal.
    expect(
      problems(
        {
          expenseType: "meal",
          businessPurpose: GOOD_PURPOSE,
          headcount: 6,
          groupDescription: "The whole production crew on shoot day",
        },
        5,
      ),
    ).toEqual([]);
  });
});

describe("attendeeAffiliationBreakdown — what publishes instead of names", () => {
  test("counts by affiliation", () => {
    const mix: CodingAttendee[] = [
      ...attendees(5),
      { name: "N1", affiliation: "community_member" },
      { name: "N2", affiliation: "community_member" },
      { name: "N3", affiliation: "contractor" },
    ];
    expect(attendeeAffiliationBreakdown(mix)).toEqual({
      volunteer: 5,
      community_member: 2,
      contractor: 1,
    });
    expect(attendeeAffiliationBreakdown([])).toEqual({});
  });
});
