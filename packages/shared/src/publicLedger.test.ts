import { describe, expect, test } from "vitest";
import {
  COMPENSATION_DISCLOSURE,
  COMPENSATION_GROUP_HEADINGS,
  compensationGroupSummary,
  compensationTable,
  contactMailto,
  everyPositionIsVolunteer,
  formatAffiliationMix,
  positionPayLabel,
  type PositionHeadcount,
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
import { SEAT_DEFS, SEAT_IDS, SEAT_ROOT, type SeatId } from "./seats";

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

/**
 * Run `fn` with one position temporarily paid, then put the constant back.
 *
 * `COMPENSATION_DISCLOSURE` is a `readonly` authored constant on purpose —
 * there is no setter and there must never be one, because the whole design is
 * that a figure is a reviewed edit to this file. A test still has to be able
 * to see what the paid path prints, so it writes through the type for the
 * duration of one assertion and restores in a `finally`. The alternative — a
 * fake disclosure object threaded through `compensationTable()` — would test a
 * parallel table rather than the one that publishes.
 */
function withPaidPosition(seatId: SeatId, cents: number, fn: () => void): void {
  const byPosition = COMPENSATION_DISCLOSURE.byPosition as Record<string, number>;
  try {
    byPosition[seatId] = cents;
    fn();
  } finally {
    delete byPosition[seatId];
  }
}

/** Nobody assigned anywhere — the shape a fresh install has, and the baseline
 *  for every assertion that isn't about counting. */
const NOBODY: PositionHeadcount = { byPosition: {}, chapterCount: 0 };

describe("compensation — the grid, and the flag that must agree with it", () => {
  test("every position resolves to a pay value; today all of them are Volunteer", () => {
    const rows = compensationTable(NOBODY).flatMap((g) => g.rows);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.payCents).toBe(0);
      expect(positionPayLabel(row.payCents)).toBe("Volunteer");
    }
  });

  test("the authored `allVolunteer` flag agrees with what the table would print", () => {
    // The flag governs one SENTENCE ("Everyone here is a volunteer") and the
    // table governs the figures. If a paid position were ever added without
    // clearing the flag, the page would print a claim its own table disproves
    // two inches below — the exact failure this disclosure exists to prevent.
    expect(COMPENSATION_DISCLOSURE.allVolunteer).toBe(everyPositionIsVolunteer());
  });

  test("a stated figure needs no renderer change — it is the same field, non-zero", () => {
    // Pinned as the future editor's one-line edit (see
    // `COMPENSATION_DISCLOSURE`'s doc): a number on `byPosition` formats
    // itself, and `everyPositionIsVolunteer` immediately stops agreeing with a
    // still-true `allVolunteer` flag.
    //
    // The unit is ANNUAL cents and the label says so — abbreviated, because it
    // sits under an 80px tile, but never bare: "$48,000" alone in a grid of
    // salaries is the kind of number a reader silently assumes is monthly.
    expect(positionPayLabel(4_800_000)).toBe("$48,000/yr");
    expect(positionPayLabel(0)).toBe("Volunteer");
    // Cents are dropped only when there are none to drop. A salary that isn't
    // a whole number of dollars prints in full rather than being rounded into
    // a figure a reader can't check.
    expect(positionPayLabel(4_812_550)).toBe("$48,125.50/yr");
  });

  test("a paid position prints its figure — and drags the flag out of agreement", () => {
    // The guard above is only worth anything if it actually fires. Pay one
    // position and re-run it: the tile formats itself, and
    // `everyPositionIsVolunteer()` stops agreeing with the authored
    // `allVolunteer: true` — which is exactly the failure a future editor
    // needs to be stopped by when they add a salary and forget the flag.
    withPaidPosition("music_director", 4_800_000, () => {
      const row = compensationTable(NOBODY)
        .flatMap((g) => g.rows)
        .find((r) => r.seatId === "music_director");
      expect(row?.payCents).toBe(4_800_000);
      expect(positionPayLabel(row?.payCents ?? 0)).toBe("$48,000/yr");

      expect(everyPositionIsVolunteer()).toBe(false);
      // The flag is still what a human authored — so the agreement test above
      // would now fail, loudly, in this exact situation.
      expect(COMPENSATION_DISCLOSURE.allVolunteer).toBe(true);
      expect(COMPENSATION_DISCLOSURE.allVolunteer).not.toBe(
        everyPositionIsVolunteer(),
      );
    });

    // …and the constant is back to the authored truth afterwards.
    expect(everyPositionIsVolunteer()).toBe(true);
  });

  test("rows are positions from the seat chart — never holders, never a derived rollup", () => {
    const rows = compensationTable(NOBODY).flatMap((g) => g.rows);
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
    const groups = compensationTable(NOBODY);
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
    for (const group of compensationTable(NOBODY)) {
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

describe("compensation — the headcount badge", () => {
  /** Three cities, a full central bench and a chapter one — the shape the
   *  band headers are written for. */
  const STAFFED: PositionHeadcount = {
    byPosition: {
      executive_director: 1,
      event_organizers: 7,
      // Summed across chapters already: one director in each of three cities.
      chapter_director: 3,
    },
    chapterCount: 3,
  };

  test("a count lands on its own position, and a position with none reads zero", () => {
    const rows = compensationTable(STAFFED).flatMap((g) => g.rows);
    const count = (seatId: string) =>
      rows.find((r) => r.seatId === seatId)?.peopleCount;

    expect(count("executive_director")).toBe(1);
    expect(count("event_organizers")).toBe(7);
    expect(count("chapter_director")).toBe(3);
    // A position nobody holds is a real answer, not a missing one — it keeps
    // its tile and reads `0`. The pay line under it is what the position pays
    // whether or not anybody is in it.
    expect(count("music_director")).toBe(0);
    expect(positionPayLabel(0)).toBe("Volunteer");
  });

  test("a missing key is zero, so an unstaffed org still publishes every position", () => {
    const rows = compensationTable(NOBODY).flatMap((g) => g.rows);
    expect(rows.every((r) => r.peopleCount === 0)).toBe(true);
    expect(rows.length).toBe(
      SEAT_IDS.filter((id) => SEAT_DEFS[id].derived !== true).length,
    );
  });

  test("a band totals its own tiles, and only the chapter band counts cities", () => {
    const [central, chapter] = compensationTable(STAFFED);

    expect(central.positionCount).toBe(central.rows.length);
    expect(central.peopleCount).toBe(1);
    // The org-wide band has no cities to span — the question doesn't arise.
    expect(central.chapterCount).toBeNull();

    expect(chapter.peopleCount).toBe(10); // 3 directors + 7 organizers
    expect(chapter.chapterCount).toBe(3);
  });

  test("the band header states the scale, and agrees with itself", () => {
    const [central, chapter] = compensationTable(STAFFED);
    expect(compensationGroupSummary(central)).toBe(
      `${central.positionCount} positions · 1 person`,
    );
    expect(compensationGroupSummary(chapter)).toBe(
      `${chapter.positionCount} positions · 10 people across 3 cities`,
    );
    expect(COMPENSATION_GROUP_HEADINGS.central).toBe("Org-wide");
    expect(COMPENSATION_GROUP_HEADINGS.chapter).toBe("Chapter");
  });

  test("singulars stay singular, and a fleet of none drops the cities clause", () => {
    // "1 positions · 1 people across 1 cities" in a disclosure about care is
    // the kind of detail that costs more than it saves…
    const [, oneCity] = compensationTable({
      byPosition: { chapter_director: 1 },
      chapterCount: 1,
    });
    expect(compensationGroupSummary(oneCity)).toContain("1 person across 1 city");

    // …and a fresh install with no chapters says nothing about cities rather
    // than "across 0 cities".
    const [, noCities] = compensationTable(NOBODY);
    expect(compensationGroupSummary(noCities)).not.toContain("across");
    expect(compensationGroupSummary(noCities)).toContain("0 people");
  });

  test("a count is a number and nothing else — the type cannot carry a person", () => {
    // The privacy containment, asserted at the boundary it is enforced on: a
    // row exposes a title, a pay figure and an integer. Anything else on it
    // would be a route from a holder record to a public page (see
    // `apps/convex/lib/positionHeadcount.ts`).
    for (const row of compensationTable(STAFFED).flatMap((g) => g.rows)) {
      expect(Object.keys(row).sort()).toEqual([
        "payCents",
        "peopleCount",
        "seatId",
        "title",
      ]);
      expect(Number.isInteger(row.peopleCount)).toBe(true);
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
