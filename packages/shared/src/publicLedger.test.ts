import { describe, expect, test } from "vitest";
import {
  COMPENSATION_DISCLOSURE,
  COMPENSATION_GROUP_HEADINGS,
  compensationTable,
  contactMailto,
  everyPositionIsVolunteer,
  formatAffiliationMix,
  PAY_KIND_ICONS,
  positionPayLabel,
  parsePeriodKey,
  periodKey,
  periodLabel,
  previousPeriodKey,
  publicGiftMethodLabel,
  PUBLIC_CONTACT_EMAIL,
  PUBLIC_GIFT_COLUMNS,
  PUBLIC_LEDGER_COLUMNS,
  REBUILDABLE_STATUSES,
  SUBMITTABLE_STATUSES,
  hasLiveRevision,
} from "./publicLedger";
import { ATTENDEE_AFFILIATION_LABELS } from "./finance";
import { SEAT_DEFS, SEAT_IDS, SEAT_ROOT } from "./seats";

/**
 * The public ledger's shared vocabulary.
 *
 * Small surface, but two things here are load-bearing enough to pin:
 *
 *  - `parsePeriodKey` parses UNTRUSTED input. It sits behind `/finances/<key>`
 *    on the public internet and in front of an index range read, so it has to
 *    be strict rather than forgiving — `2026-8` and `2026-13` are rejected,
 *    not coerced into something plausible.
 *  - `formatAffiliationMix` is the sentence that publishes INSTEAD of a
 *    person's name. If it ever renders empty for a meal that had attendees,
 *    the page silently loses the only answer it has to "who was this for?".
 */

describe("period keys", () => {
  test("round-trips, zero-padded", () => {
    expect(periodKey(2026, 8)).toBe("2026-08");
    expect(periodKey(2026, 12)).toBe("2026-12");
    expect(parsePeriodKey("2026-08")).toEqual({ year: 2026, month: 8 });
  });

  test("rejects anything that isn't exactly YYYY-MM", () => {
    // Each of these is a real thing somebody types into a URL bar.
    for (const bad of [
      "2026-8", // unpadded
      "2026-13", // no such month
      "2026-00",
      "26-08",
      "2026-08-01", // a day, not a month
      "2026/08",
      "august",
      "",
      " 2026-08",
    ]) {
      expect(parsePeriodKey(bad)).toBeNull();
    }
  });

  test("labels a month in words, and never throws on junk", () => {
    expect(periodLabel("2026-08")).toBe("August 2026");
    expect(periodLabel("2026-01")).toBe("January 2026");
    // A display path must degrade rather than crash — it can be reached with
    // whatever a stored row happens to hold.
    expect(periodLabel("nonsense")).toBe("nonsense");
  });

  test("steps back across a year boundary", () => {
    expect(previousPeriodKey("2026-08")).toBe("2026-07");
    expect(previousPeriodKey("2026-01")).toBe("2025-12");
    expect(previousPeriodKey("bad")).toBeNull();
  });
});

describe("lifecycle vocabulary", () => {
  test("a published month is not rebuildable or submittable", () => {
    // Publishing freezes it. The only way back into the working state is an
    // explicit, logged amendment — never an implicit rebuild.
    expect(REBUILDABLE_STATUSES).not.toContain("published");
    expect(SUBMITTABLE_STATUSES).not.toContain("published");
    expect(SUBMITTABLE_STATUSES).not.toContain("in_review");
  });

  test("an amending month is still publicly live", () => {
    // The whole point of `amending`: revision N stays visible while N+1 is
    // prepared, so there is never a window where a month reads as blank.
    expect(hasLiveRevision({ liveRevision: 1 })).toBe(true);
    expect(hasLiveRevision({ liveRevision: null })).toBe(false);
    expect(hasLiveRevision({})).toBe(false);
    expect(REBUILDABLE_STATUSES).toContain("amending");
  });
});

describe("affiliation mix — what publishes instead of a name", () => {
  test("reads as a sentence, biggest group first", () => {
    expect(
      formatAffiliationMix(
        { community_member: 7, team: 5 },
        ATTENDEE_AFFILIATION_LABELS,
      ),
    ).toBe("7 community members, 5 team members");
  });

  test("singular stays singular", () => {
    expect(formatAffiliationMix({ team: 1 }, ATTENDEE_AFFILIATION_LABELS)).toBe(
      "1 team member",
    );
  });

  test("null when there is nothing to say — distinguishable from zero", () => {
    expect(formatAffiliationMix(null, ATTENDEE_AFFILIATION_LABELS)).toBeNull();
    expect(formatAffiliationMix({}, ATTENDEE_AFFILIATION_LABELS)).toBeNull();
    expect(formatAffiliationMix({ team: 0 }, ATTENDEE_AFFILIATION_LABELS)).toBeNull();
  });

  test("an unknown affiliation renders its raw key rather than vanishing", () => {
    // A frozen row can outlive the tuple it was written against. Losing the
    // count would be worse than an ugly label.
    expect(formatAffiliationMix({ alumni: 3 }, ATTENDEE_AFFILIATION_LABELS)).toBe(
      "3 alumnis",
    );
  });
});

describe("gift methods in public words", () => {
  test("names the rail the way a giver would", () => {
    expect(publicGiftMethodLabel("stripe")).toBe("Card");
    expect(publicGiftMethodLabel("givebutter")).toBe("Card");
    expect(publicGiftMethodLabel("in_kind")).toBe("In-kind");
  });

  test("an unmapped method degrades readably instead of blank", () => {
    expect(publicGiftMethodLabel("apple_pay")).toBe("Apple pay");
  });
});

describe("published columns", () => {
  test("no column can carry a person's name", () => {
    // The one invariant worth asserting about the header list itself: the
    // ledger publishes a headcount and an affiliation mix, never a name
    // (owner decision 2026-08-08 — some attendees are minors).
    const columns = [...PUBLIC_LEDGER_COLUMNS, ...PUBLIC_GIFT_COLUMNS].map((c) =>
      c.toLowerCase(),
    );
    for (const forbidden of ["name", "donor", "attendee", "email", "giver"]) {
      expect(columns.some((c) => c.includes(forbidden))).toBe(false);
    }
  });
});

describe("compensation — the table, and the flag that must agree with it", () => {
  test("every position resolves to a pay value; today all of them are Volunteer", () => {
    const rows = compensationTable().flatMap((g) => g.rows);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(positionPayLabel(row.pay)).toBe("Volunteer");
      expect(row.icon).toBe(PAY_KIND_ICONS.volunteer);
    }
  });

  test("the authored `allVolunteer` flag agrees with what the table would print", () => {
    // The flag governs one SENTENCE ("Everyone here is a volunteer") and the
    // table governs the figures. If a paid position were ever added without
    // clearing the flag, the page would print a claim its own table disproves
    // two inches below — the exact failure this disclosure exists to prevent.
    expect(COMPENSATION_DISCLOSURE.allVolunteer).toBe(everyPositionIsVolunteer());
  });

  test("a stated figure needs no renderer change — it is a value of the same shape", () => {
    // Pinned as the future editor's one-line edit (see
    // `COMPENSATION_DISCLOSURE`'s doc): an override on `byPosition` formats
    // itself, and `everyPositionIsVolunteer` immediately stops agreeing with a
    // still-true `allVolunteer` flag.
    const paid = positionPayLabel({
      kind: "paid",
      amountCents: 4_800_000,
      period: "year",
    });
    expect(paid).toBe("$48,000.00 per year");
    expect(positionPayLabel({ kind: "paid", amountCents: 6500, period: "hour" })).toBe(
      "$65.00 per hour",
    );
  });

  test("rows are positions from the seat chart — never holders, never a derived rollup", () => {
    const rows = compensationTable().flatMap((g) => g.rows);
    const ids = rows.map((r) => r.seatId);
    // Exactly the non-derived seats, each once.
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(
      new Set(SEAT_IDS.filter((id) => SEAT_DEFS[id].derived !== true)),
    );
    // `chapter_directors` is a rollup of every chapter's chapter_director
    // holder, not a position anybody is appointed to.
    expect(ids).not.toContain("chapter_directors");
    // Every printed title is the seat def's own title.
    for (const row of rows) expect(row.title).toBe(SEAT_DEFS[row.seatId].title);
  });

  test("both charts are groups, and each row sits in its own chart's group", () => {
    const groups = compensationTable();
    expect(groups.map((g) => g.chart)).toEqual(["central", "chapter"]);
    for (const group of groups) {
      expect(group.rows.length).toBeGreaterThan(0);
      expect(group.heading).toBe(COMPENSATION_GROUP_HEADINGS[group.chart]);
      for (const row of group.rows) {
        expect(SEAT_DEFS[row.seatId].chart).toBe(group.chart);
      }
    }
  });

  test("leadership reads first — a position never appears above the one it reports to", () => {
    for (const group of compensationTable()) {
      const order = group.rows.map((r) => r.seatId);
      expect(SEAT_DEFS[order[0]].parentId).toBe(SEAT_ROOT);
      for (const [i, id] of order.entries()) {
        const parentId = SEAT_DEFS[id].parentId;
        if (parentId === SEAT_ROOT) continue;
        // A derived parent is skipped from the table, so its children (none
        // today) would legitimately have no ancestor row above them.
        if (SEAT_DEFS[parentId].derived) continue;
        expect(order.indexOf(parentId)).toBeGreaterThan(-1);
        expect(order.indexOf(parentId)).toBeLessThan(i);
      }
    }
  });
});

describe("the way a reader reports a problem", () => {
  test("points at the org's real, already-monitored address", () => {
    // Not a `giving@` or `finance@` alias invented for this one page: an
    // unmonitored address on a "tell us if this is wrong" prompt converts a
    // person willing to help into a person who was ignored.
    expect(PUBLIC_CONTACT_EMAIL).toBe("hello@publicworship.life");
  });

  test("pre-fills a subject so a report arrives already triaged", () => {
    expect(contactMailto("Gift missing from the August 2026 finances page")).toBe(
      "mailto:hello@publicworship.life?subject=Gift%20missing%20from%20the%20August%202026%20finances%20page",
    );
  });

  test("escapes a subject that would otherwise break the URL", () => {
    // Period labels are interpolated into these, and a label is not a
    // guaranteed-safe string.
    const link = contactMailto("Q&A: what's this? #2");
    expect(link).not.toContain("&subject");
    expect(link).not.toContain("#2");
    expect(decodeURIComponent(link.split("subject=")[1])).toBe("Q&A: what's this? #2");
  });
});
