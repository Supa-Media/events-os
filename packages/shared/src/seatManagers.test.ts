import { describe, expect, test } from "vitest";
import {
  buildSeatManagerIndex,
  deriveSeatManagerIds,
  effectiveManagerIds,
  type SeatManagerAssignment,
  type SeatManagerSeatDef,
} from "./seatManagers";

// A trimmed slice of the real taxonomy, enough to exercise chapter→central
// rollup, multi-holder parents, and self-held ancestors without dragging in
// the full SEAT_DEFS template.
const SEAT_DEFS: SeatManagerSeatDef<string>[] = [
  // Central chart
  { seatDefId: "executive_director", chart: "central", slug: "executive_director", parentSlug: "root" },
  { seatDefId: "expansion_director", chart: "central", slug: "expansion_director", parentSlug: "executive_director" },
  { seatDefId: "development_director", chart: "central", slug: "development_director", parentSlug: "executive_director" },
  // Chapter chart (shared shape, stamped per chapter via `scope`)
  { seatDefId: "chapter_director", chart: "chapter", slug: "chapter_director", parentSlug: "root" },
  { seatDefId: "music_lead", chart: "chapter", slug: "music_lead", parentSlug: "chapter_director" },
  { seatDefId: "vocal_lead", chart: "chapter", slug: "vocal_lead", parentSlug: "music_lead" },
  { seatDefId: "event_lead", chart: "chapter", slug: "event_lead", parentSlug: "chapter_director" },
  { seatDefId: "event_organizers", chart: "chapter", slug: "event_organizers", parentSlug: "event_lead" },
];

const CENTRAL = "central";
const CHAPTER_ROLLUP_PARENT = "expansion_director";

function makeIndex(assignments: SeatManagerAssignment<string, string, string>[]) {
  return buildSeatManagerIndex(SEAT_DEFS, assignments);
}

describe("deriveSeatManagerIds", () => {
  test("chapter music_lead reports to the chapter_director", () => {
    const index = makeIndex([
      { seatDefId: "music_lead", scope: "chapterA", personId: "mia" },
      { seatDefId: "chapter_director", scope: "chapterA", personId: "dana" },
    ]);
    expect(deriveSeatManagerIds(index, "mia", CENTRAL, CHAPTER_ROLLUP_PARENT)).toEqual(["dana"]);
  });

  test("vacant chapter_director rolls up to the central expansion_director's holders", () => {
    const index = makeIndex([
      { seatDefId: "music_lead", scope: "chapterA", personId: "mia" },
      // chapter_director is vacant — no assignment for it.
      { seatDefId: "expansion_director", scope: CENTRAL, personId: "erin" },
    ]);
    expect(deriveSeatManagerIds(index, "mia", CENTRAL, CHAPTER_ROLLUP_PARENT)).toEqual(["erin"]);
  });

  test("the executive director (top of the org) has no managers — a real answer, not a fallback signal", () => {
    const index = makeIndex([{ seatDefId: "executive_director", scope: CENTRAL, personId: "eli" }]);
    expect(deriveSeatManagerIds(index, "eli", CENTRAL, CHAPTER_ROLLUP_PARENT)).toEqual([]);
  });

  test("a multi-holder parent seat returns ALL of its holders as managers", () => {
    const index = makeIndex([
      { seatDefId: "vocal_lead", scope: "chapterA", personId: "val" },
      { seatDefId: "music_lead", scope: "chapterA", personId: "mia" },
      { seatDefId: "music_lead", scope: "chapterA", personId: "mo" },
    ]);
    expect(
      deriveSeatManagerIds(index, "val", CENTRAL, CHAPTER_ROLLUP_PARENT)?.sort(),
    ).toEqual(["mia", "mo"]);
  });

  test("an ancestor held by exactly the same person is skipped — you don't report to yourself", () => {
    // Dana holds both music_lead and its ancestor chapter_director — the walk
    // must skip chapter_director (fully identical holder set) and keep going
    // up to the vacant... in this case nothing further, so no managers.
    const index = makeIndex([
      { seatDefId: "music_lead", scope: "chapterA", personId: "dana" },
      { seatDefId: "chapter_director", scope: "chapterA", personId: "dana" },
    ]);
    expect(deriveSeatManagerIds(index, "dana", CENTRAL, CHAPTER_ROLLUP_PARENT)).toEqual([]);
  });

  test("self-held ancestor is skipped but the walk continues past it to a real manager", () => {
    // Dana holds both music_lead and chapter_director (self-held, skipped),
    // but expansion_director is held by someone else — Dana's manager.
    const index = makeIndex([
      { seatDefId: "music_lead", scope: "chapterA", personId: "dana" },
      { seatDefId: "chapter_director", scope: "chapterA", personId: "dana" },
      { seatDefId: "expansion_director", scope: CENTRAL, personId: "erin" },
    ]);
    expect(deriveSeatManagerIds(index, "dana", CENTRAL, CHAPTER_ROLLUP_PARENT)).toEqual(["erin"]);
  });

  test("a person who holds no seat at all returns null — distinct from a real empty answer", () => {
    const index = makeIndex([{ seatDefId: "chapter_director", scope: "chapterA", personId: "dana" }]);
    expect(deriveSeatManagerIds(index, "someone-else", CENTRAL, CHAPTER_ROLLUP_PARENT)).toBeNull();
  });

  describe("multi-seat mutual pair (PR #205 regression — prod-shaped)", () => {
    // Eli (ED) also holds chapter_director in chapterA; Jess (expansion
    // director) also holds event_lead in that SAME chapter. Per-seat walks
    // independently derive each as a candidate manager of the other: Eli's
    // chapter_director seat rolls up to expansion_director (Jess); Jess's
    // expansion_director seat's parent is executive_director (Eli). Without
    // the seniority tie-break this is a genuine mutual edge — Eli must win as
    // the parent (their `executive_director` seat is strictly closer to the
    // central root than Jess's best seat, `expansion_director`).
    function mutualPairIndex() {
      return makeIndex([
        { seatDefId: "executive_director", scope: CENTRAL, personId: "eli" },
        { seatDefId: "chapter_director", scope: "chapterA", personId: "eli" },
        { seatDefId: "expansion_director", scope: CENTRAL, personId: "jess" },
        { seatDefId: "event_lead", scope: "chapterA", personId: "jess" },
      ]);
    }

    test("the ED has no manager despite also holding a chapter_director seat that rolls up to the expansion director", () => {
      const index = mutualPairIndex();
      expect(deriveSeatManagerIds(index, "eli", CENTRAL, CHAPTER_ROLLUP_PARENT)).toEqual([]);
    });

    test("the expansion director reports to the ED, never the reverse", () => {
      const index = mutualPairIndex();
      expect(deriveSeatManagerIds(index, "jess", CENTRAL, CHAPTER_ROLLUP_PARENT)).toEqual(["eli"]);
    });

    test("a third, single-seat report under the expansion director's chapter still resolves normally (no orphaned subtree)", () => {
      const index = makeIndex([
        { seatDefId: "executive_director", scope: CENTRAL, personId: "eli" },
        { seatDefId: "chapter_director", scope: "chapterA", personId: "eli" },
        { seatDefId: "expansion_director", scope: CENTRAL, personId: "jess" },
        { seatDefId: "event_lead", scope: "chapterA", personId: "jess" },
        // A plain single-seat report: vocal_lead's parent (music_lead) is
        // vacant, so the walk continues up to chapter_director — held by Eli.
        { seatDefId: "vocal_lead", scope: "chapterA", personId: "vic" },
      ]);
      // Proves the fix doesn't disturb ordinary reports elsewhere in the same
      // chapter — vic still resolves normally to Eli, not swallowed by the
      // mutual-pair filtering happening for eli/jess above.
      expect(deriveSeatManagerIds(index, "vic", CENTRAL, CHAPTER_ROLLUP_PARENT)).toEqual(["eli"]);
    });
  });

  describe("cycle-scoped tie-break (adversarial review fix — 2026-07-17)", () => {
    // Reviewer repro: X is a central Development Director (senior, depth 1)
    // who ALSO volunteers on a chapter's `event_organizers` seat (junior,
    // under Y's `event_lead`). X and Y never point back at each other — X's
    // managers are {ed, y}, Y's manager is {ed}, ed has none — so there is NO
    // cycle here at all. An earlier version of this fix used a BLANKET
    // "candidate must be senior to my single most-senior seat" filter, which
    // wrongly dropped Y (X's real, non-cyclic event_organizers manager)
    // because X's unrelated development_director seat outranked Y overall.
    // The cycle-scoped fix must leave this untouched: X keeps BOTH managers.
    test("a person's unrelated senior seat does NOT strip a real, non-cyclic manager from an unrelated junior seat", () => {
      const index = makeIndex([
        { seatDefId: "executive_director", scope: CENTRAL, personId: "ed" },
        { seatDefId: "development_director", scope: CENTRAL, personId: "x" },
        { seatDefId: "event_organizers", scope: "chapterA", personId: "x" },
        { seatDefId: "event_lead", scope: "chapterA", personId: "y" },
      ]);
      expect(deriveSeatManagerIds(index, "x", CENTRAL, CHAPTER_ROLLUP_PARENT)?.sort()).toEqual(
        ["ed", "y"].sort(),
      );
      // y's own manager (via event_lead's rollup to chapter_director, vacant,
      // then to the central expansion_director, vacant, then to the ED) is
      // unaffected — not part of any cycle either.
      expect(deriveSeatManagerIds(index, "y", CENTRAL, CHAPTER_ROLLUP_PARENT)).toEqual(["ed"]);
      expect(deriveSeatManagerIds(index, "ed", CENTRAL, CHAPTER_ROLLUP_PARENT)).toEqual([]);
    });

    // A genuine 3-node cycle: Vee holds vocal_lead (reports up to Emm's
    // music_lead) AND expansion_director@central (Cee's chapter_director
    // rolls up to it) — closing a ring Vee -> Emm -> Cee -> Vee. Seniority
    // (min depth across every seat held): Vee=1 (expansion_director),
    // Cee=2 (chapter_director), Emm=3 (music_lead) — a strict order, so the
    // cycle must resolve into the linear chain Vee (root) <- Cee <- Emm.
    test("a 3-node cycle resolves into a linear chain ordered by seniority", () => {
      const index = makeIndex([
        { seatDefId: "vocal_lead", scope: "chapterA", personId: "vee" },
        { seatDefId: "expansion_director", scope: CENTRAL, personId: "vee" },
        { seatDefId: "music_lead", scope: "chapterA", personId: "emm" },
        { seatDefId: "chapter_director", scope: "chapterA", personId: "cee" },
      ]);
      expect(deriveSeatManagerIds(index, "vee", CENTRAL, CHAPTER_ROLLUP_PARENT)).toEqual([]);
      expect(deriveSeatManagerIds(index, "cee", CENTRAL, CHAPTER_ROLLUP_PARENT)).toEqual(["vee"]);
      expect(deriveSeatManagerIds(index, "emm", CENTRAL, CHAPTER_ROLLUP_PARENT)).toEqual(["cee"]);
    });
  });

  test("union across every seat the person holds is deduped by person id", () => {
    // Mia holds both music_lead AND vocal_lead in the same chapter, both
    // reporting to the same chapter_director — the result has one entry, not two.
    const index = makeIndex([
      { seatDefId: "music_lead", scope: "chapterA", personId: "mia" },
      { seatDefId: "vocal_lead", scope: "chapterA", personId: "mia" },
      { seatDefId: "chapter_director", scope: "chapterA", personId: "dana" },
    ]);
    expect(deriveSeatManagerIds(index, "mia", CENTRAL, CHAPTER_ROLLUP_PARENT)).toEqual(["dana"]);
  });
});

describe("effectiveManagerIds", () => {
  test("seatless person falls back to the stored managerId", () => {
    const index = makeIndex([{ seatDefId: "chapter_director", scope: "chapterA", personId: "dana" }]);
    expect(effectiveManagerIds(index, "volunteer-vic", "dana", CENTRAL, CHAPTER_ROLLUP_PARENT)).toEqual(["dana"]);
  });

  test("seatless person with no stored manager either has none", () => {
    const index = makeIndex([]);
    expect(effectiveManagerIds(index, "vic", null, CENTRAL, CHAPTER_ROLLUP_PARENT)).toEqual([]);
  });

  test("a seat-holder's stored managerId is ignored once seat-derived truth applies", () => {
    const index = makeIndex([
      { seatDefId: "music_lead", scope: "chapterA", personId: "mia" },
      { seatDefId: "chapter_director", scope: "chapterA", personId: "dana" },
    ]);
    // Mia's legacy stored manager ("legacy-boss") is a stale flag; seat truth wins.
    expect(effectiveManagerIds(index, "mia", "legacy-boss", CENTRAL, CHAPTER_ROLLUP_PARENT)).toEqual(["dana"]);
  });

  test("the executive director's seat-derived empty answer is NOT overridden by a stale stored managerId", () => {
    const index = makeIndex([{ seatDefId: "executive_director", scope: CENTRAL, personId: "eli" }]);
    expect(effectiveManagerIds(index, "eli", "stale-boss", CENTRAL, CHAPTER_ROLLUP_PARENT)).toEqual([]);
  });
});
