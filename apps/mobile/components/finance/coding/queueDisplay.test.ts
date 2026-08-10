import { describe, expect, test } from "@jest/globals";
import {
  booksInRows,
  breakdownLine,
  daysWaiting,
  substantiationLine,
} from "./queueDisplay";

/**
 * The Coding tab's queue promises a reviewer they can decide without opening
 * each row. That promise is only as good as the one line summarising WHO WAS
 * INVOLVED — the §274(d) business-relationship element — so it is pinned here
 * for every branch it has.
 */

const NO_TRAVEL = { travelFrom: null, travelTo: null };
const NO_MEAL = {
  headcount: null,
  attendees: null,
  groupDescription: null,
  affiliationBreakdown: {},
};

describe("substantiationLine", () => {
  test("a general charge owes nothing beyond its purpose", () => {
    expect(substantiationLine({ ...NO_TRAVEL, ...NO_MEAL })).toBeNull();
  });

  test("travel renders the route", () => {
    expect(
      substantiationLine({
        ...NO_MEAL,
        travelFrom: "Boston",
        travelTo: "New York",
      }),
    ).toBe("Boston → New York");
  });

  test("a HALF-known route still renders — a missing leg is what a reviewer should send back, not something to hide", () => {
    expect(
      substantiationLine({ ...NO_MEAL, travelFrom: "Boston", travelTo: null }),
    ).toBe("Boston → ?");
    expect(
      substantiationLine({ ...NO_MEAL, travelFrom: null, travelTo: "New York" }),
    ).toBe("? → New York");
  });

  test("a meal at or below the threshold names everyone", () => {
    expect(
      substantiationLine({
        ...NO_TRAVEL,
        headcount: 3,
        attendees: [{ name: "Ada" }, { name: "Grace" }, { name: "Katherine" }],
        groupDescription: null,
        affiliationBreakdown: { team: 3 },
      }),
    ).toBe("3 people — Ada, Grace, Katherine");
  });

  test("a meal over the threshold uses the group description", () => {
    expect(
      substantiationLine({
        ...NO_TRAVEL,
        headcount: 22,
        attendees: null,
        groupDescription: "volunteers writing and producing the album",
        affiliationBreakdown: { volunteer: 22 },
      }),
    ).toBe("22 people — volunteers writing and producing the album");
  });

  test("with names redacted and no group description, it falls back to the breakdown the ledger would print", () => {
    expect(
      substantiationLine({
        ...NO_TRAVEL,
        headcount: 5,
        attendees: null,
        groupDescription: null,
        affiliationBreakdown: { volunteer: 5 },
      }),
    ).toBe("5 people — 5 volunteers");
  });

  test("a headcount with nothing else still says the headcount", () => {
    expect(
      substantiationLine({
        ...NO_TRAVEL,
        headcount: 4,
        attendees: [],
        groupDescription: null,
        affiliationBreakdown: {},
      }),
    ).toBe("4 people");
  });

  test("travel wins over meal fields — an expense type owes one set of elements", () => {
    expect(
      substantiationLine({
        travelFrom: "Boston",
        travelTo: "New York",
        headcount: 9,
        attendees: [{ name: "Ada" }],
        groupDescription: null,
        affiliationBreakdown: {},
      }),
    ).toBe("Boston → New York");
  });
});

describe("breakdownLine", () => {
  test("pluralises per affiliation and uses the supplied labels", () => {
    expect(
      breakdownLine(
        { volunteer: 5, community_member: 3, contractor: 1 },
        {
          volunteer: "Volunteer",
          community_member: "Community member",
          contractor: "Contractor",
        },
      ),
    ).toBe("5 volunteers, 3 community members, 1 contractor");
  });

  test("an unknown affiliation degrades to its raw key rather than vanishing", () => {
    expect(breakdownLine({ mystery: 2 })).toBe("2 mysterys");
  });

  test("no attendees is an empty string, not a stray separator", () => {
    expect(breakdownLine({})).toBe("");
  });
});

describe("daysWaiting", () => {
  const now = 1_700_000_000_000;

  test("counts whole days", () => {
    expect(daysWaiting(now - 3 * 86_400_000, now)).toBe(3);
    expect(daysWaiting(now - 86_399_000, now)).toBe(0);
  });

  test("never goes negative — a clock skew must not render 'waiting -1 days'", () => {
    expect(daysWaiting(now + 86_400_000, now)).toBe(0);
  });
});

describe("booksInRows", () => {
  test("dedupes, keeps first-seen order, and keeps central alongside chapters", () => {
    expect(
      booksInRows([
        { book: { id: "central", name: "Central" } },
        { book: { id: "ny", name: "New York" } },
        { book: { id: "central", name: "Central" } },
        { book: { id: "chi", name: "Chicago" } },
      ]),
    ).toEqual([
      { id: "central", name: "Central" },
      { id: "ny", name: "New York" },
      { id: "chi", name: "Chicago" },
    ]);
  });

  test("an empty page has no book filter options", () => {
    expect(booksInRows([])).toEqual([]);
  });
});
