import { describe, expect, test } from "vitest";
import {
  CHAPTER_ROLLUP_PARENT,
  MULTI_HOLDER_CAP,
  SEAT_CAPABILITIES,
  SEAT_CHARTS,
  SEAT_DEFS,
  SEAT_IDS,
  SEAT_ROOT,
  type SeatId,
  isMultiHolder,
  seatAncestors,
  seatChartOrder,
  seatChildren,
  seatsForChart,
} from "./seats";

/**
 * `seats.ts` is the owner-approved seed template for the org-chart seat
 * taxonomy (central + per-chapter), including the parent/child tree shape
 * and which seats carry which capability strings. This suite pins that
 * taxonomy — both its structural invariants (acyclic, single root per
 * chart, child chart matches parent chart) and an exact snapshot of the
 * capabilities per seat — so an edit to SEAT_DEFS trips a loud, specific
 * failure here instead of silently drifting from the approved flowchart.
 */

describe("SEAT_IDS / SEAT_DEFS", () => {
  test("SEAT_IDS has no duplicates", () => {
    expect(new Set(SEAT_IDS).size).toBe(SEAT_IDS.length);
  });

  test("SEAT_IDS matches the SEAT_DEFS keys exactly", () => {
    const defKeys = Object.keys(SEAT_DEFS).sort();
    const ids = [...SEAT_IDS].sort();
    expect(defKeys).toEqual(ids);
  });

  test("every def's own id matches its key", () => {
    for (const id of SEAT_IDS) {
      expect(SEAT_DEFS[id].id).toBe(id);
    }
  });
});

describe("parent/child tree shape", () => {
  test("every parentId is SEAT_ROOT or a real seat id", () => {
    for (const id of SEAT_IDS) {
      const { parentId } = SEAT_DEFS[id];
      if (parentId === SEAT_ROOT) continue;
      expect(SEAT_IDS as readonly string[]).toContain(parentId);
    }
  });

  test("a child's chart always matches its parent's chart", () => {
    for (const id of SEAT_IDS) {
      const def = SEAT_DEFS[id];
      if (def.parentId === SEAT_ROOT) continue;
      expect(SEAT_DEFS[def.parentId].chart).toBe(def.chart);
    }
  });

  test("exactly one root seat per chart", () => {
    for (const chart of SEAT_CHARTS) {
      const roots = seatsForChart(chart).filter(
        (def) => def.parentId === SEAT_ROOT,
      );
      expect(roots).toHaveLength(1);
    }
  });

  test("the tree is acyclic — every seat's ancestor walk terminates at its chart root", () => {
    for (const id of SEAT_IDS) {
      const chart = SEAT_DEFS[id].chart;
      const visited = new Set<SeatId>();
      let current: SeatId | typeof SEAT_ROOT = SEAT_DEFS[id].parentId;
      while (current !== SEAT_ROOT) {
        expect(visited.has(current)).toBe(false); // would indicate a cycle
        visited.add(current);
        expect(SEAT_DEFS[current].chart).toBe(chart);
        current = SEAT_DEFS[current].parentId;
      }
    }
  });

  test("seatAncestors walks parentId up to (not including) SEAT_ROOT", () => {
    expect(seatAncestors("financial_manager")).toEqual(["executive_director"]);
    expect(seatAncestors("executive_director")).toEqual([]);
    expect(seatAncestors("vocal_lead")).toEqual(["music_lead", "chapter_director"]);
  });

  test("seatChildren is the inverse of parentId", () => {
    for (const id of SEAT_IDS) {
      for (const child of seatChildren(id)) {
        expect(SEAT_DEFS[child].parentId).toBe(id);
      }
    }
    expect(seatChildren("executive_director")).toEqual(
      expect.arrayContaining([
        "financial_manager",
        "development_director",
        "music_director",
        "marketing_director",
        "expansion_director",
      ]),
    );
  });

  test("seatChartOrder covers a chart completely, root first, parents before their children", () => {
    // The reading order the org-chart panel and the public compensation table
    // both use. Two properties, and the first is why the walk is safe: a seat
    // unreachable from SEAT_ROOT (only possible if the defs ever grew a cycle)
    // would go MISSING here rather than looping forever, so completeness is
    // the assertion that catches it.
    for (const chart of SEAT_CHARTS) {
      const ordered = seatChartOrder(chart);
      expect(new Set(ordered.map((d) => d.id))).toEqual(
        new Set(seatsForChart(chart).map((d) => d.id)),
      );
      expect(ordered).toHaveLength(seatsForChart(chart).length);

      const ids = ordered.map((d) => d.id);
      expect(SEAT_DEFS[ids[0]].parentId).toBe(SEAT_ROOT);
      for (const [i, id] of ids.entries()) {
        const { parentId } = SEAT_DEFS[id];
        if (parentId === SEAT_ROOT) continue;
        expect(ids.indexOf(parentId)).toBeLessThan(i);
      }
    }
  });

  test("seatChartOrder puts a subtree together — a director is followed by their own associates", () => {
    const ids = seatChartOrder("central").map((d) => d.id);
    expect(ids.slice(0, 2)).toEqual(["executive_director", "financial_manager"]);
    const dd = ids.indexOf("development_director");
    expect(ids.slice(dd, dd + 3)).toEqual([
      "development_director",
      "partnership_associate",
      "fundraising_associate",
    ]);
    expect(seatChartOrder("chapter")[0].id).toBe("chapter_director");
  });

  test("seatsForChart only returns defs for the requested chart", () => {
    for (const chart of SEAT_CHARTS) {
      for (const def of seatsForChart(chart)) {
        expect(def.chart).toBe(chart);
      }
    }
    const total = SEAT_CHARTS.reduce(
      (sum, chart) => sum + seatsForChart(chart).length,
      0,
    );
    expect(total).toBe(SEAT_IDS.length);
  });
});

describe("seat constraints", () => {
  test("derived seats carry no legacyTitle", () => {
    for (const id of SEAT_IDS) {
      const def = SEAT_DEFS[id];
      if (def.derived) {
        expect(def.legacyTitle).toBeUndefined();
      }
    }
  });

  test("maxHolders is always 1 or MULTI_HOLDER_CAP", () => {
    for (const id of SEAT_IDS) {
      const { maxHolders } = SEAT_DEFS[id];
      expect([1, MULTI_HOLDER_CAP]).toContain(maxHolders);
    }
  });

  test("isMultiHolder agrees with maxHolders === MULTI_HOLDER_CAP", () => {
    for (const id of SEAT_IDS) {
      const def = SEAT_DEFS[id];
      expect(isMultiHolder(def)).toBe(def.maxHolders === MULTI_HOLDER_CAP);
    }
  });

  test("every capability string is a known SEAT_CAPABILITIES entry", () => {
    for (const id of SEAT_IDS) {
      for (const capability of SEAT_DEFS[id].capabilities) {
        expect(SEAT_CAPABILITIES as readonly string[]).toContain(capability);
      }
    }
  });
});

describe("chapter ↔ central rollup", () => {
  test("CHAPTER_ROLLUP_PARENT is a real, central-chart seat", () => {
    expect(SEAT_IDS as readonly string[]).toContain(CHAPTER_ROLLUP_PARENT);
    expect(SEAT_DEFS[CHAPTER_ROLLUP_PARENT].chart).toBe("central");
  });
});

describe("spec snapshot (owner-approved taxonomy, 2026-07-16; chapter_director finance.viewer added 2026-07-17 per owner decision — see seats.ts's chapter_director doc comment)", () => {
  // Pins the exact set of seats + which ones carry powers, so a future edit to
  // SEAT_DEFS trips a loud, specific failure here instead of silently drifting
  // from the approved org-chart flowchart. These are TEMPLATE defaults; the ED
  // retunes them at runtime, so this pin tracks what a fresh org is STAMPED
  // with, not the live per-org state.
  //
  // 2026-08-12 — REPINNED for the standardized power vocabulary
  // (`powers.ts`). Two things changed about how to read this list:
  //
  //  1. Every entry is now the MINIMAL set. A seat lists only what it is
  //     GRANTED, never what those grants imply — the ED carries
  //     `email.campaigns.approve` alone, where it used to also spell out the
  //     compose and design rungs beneath it. `expandPowers` derives the rest,
  //     and `powers.test.ts` pins the expansions.
  //  2. Three strings vanished org-wide, and none of them cost anyone access:
  //     `finance.central` was a SCOPE (central-held powers reach every chapter
  //     by rule now), `finance.record` was read by nothing, and `nav.*` is
  //     derived from holding any power in the domain.
  const EXPECTED_CAPABILITIES_BY_SEAT: Record<SeatId, readonly string[]> = {
    // The ED approves and publishes; they deliberately do NOT keep the books
    // (no `finance.edit` — that is the Financial Manager's desk). Being a
    // CENTRAL seat, each of these reaches every chapter as well as central.
    executive_director: [
      "finance.accounts.view",
      "finance.budgets.approve",
      "finance.ledger.publish",
      "org.chart.edit",
      "giving.edit",
      "email.campaigns.approve",
      "data.export",
    ],
    // `finance.edit` at central replaces what took four strings before
    // (`finance.manager` + `finance.central` + `finance.accounts` +
    // `finance.record`). `finance.ledger.publish` stays separate: the FM
    // closes the books monthly, and publishing them is its own leaf that no
    // finance rung implies.
    financial_manager: [
      "finance.edit",
      "finance.ledger.publish",
      "giving.view",
      "email.campaigns.approve",
      "data.export",
    ],
    // 2026-07-31: data.export on the six seats the founder granted bulk
    // extraction to (ED, FM, Development Director, Expansion Director,
    // Marketing Director, Chapter Director).
    development_director: ["giving.edit", "data.export"],
    // Partner portal (2026-08-20): the partnership team gained
    // `giving.partners.edit` — compose an agreement and issue its link, without
    // the rest of the giving desk. See seats.ts.
    partnership_associate: ["giving.view", "giving.partners.edit"],
    fundraising_associate: ["giving.view", "giving.partners.edit"],
    music_director: [],
    a_and_r: [],
    artists: [],
    musicians: [],
    songwriters: [],
    // 2026-07-24 (founder, verbatim: "ED approved by Marketing Director") —
    // a valid second party for two-party campaign approval.
    marketing_director: ["email.campaigns.approve", "data.export"],
    // The two seats that actually build the newsletter own themes, templates
    // and the image library, but a mass send stays a two-party decision above
    // them. The ED can promote either to Compose/Approve at runtime
    // (`seats.ts#setSeatCampaignPower`).
    social_media_manager: ["email.assets.edit"],
    graphic_designer: ["email.assets.edit"],
    marketing_associate: [],
    expansion_director: ["giving.view", "data.export"],
    chapter_directors: [],
    recruiting_associate: [],
    training_associate: [],
    // A CHAPTER seat: `finance.view` is read of the whole finance domain at
    // THIS chapter. It needs no carve-out for the org's bank accounts because
    // those live at central, which a chapter grant never reaches.
    // `finance.ledger.publish` publishes their own chapter's month — paired
    // with the Treasurer PREPARING it, which is exactly why the Treasurer
    // below does not carry it.
    chapter_director: [
      "finance.view",
      "finance.budgets.approve",
      "finance.ledger.publish",
      "giving.view",
      "data.export",
      "events.checkin",
    ],
    // `finance.edit` at CHAPTER scope — the whole finance domain for this
    // chapter and nothing beyond it.
    treasurer: ["finance.edit", "giving.view"],
    music_lead: [],
    vocal_lead: [],
    band_lead: [],
    // 2026-08-06: the door check-in gate for the QR scanner.
    event_lead: ["events.checkin"],
    event_organizers: ["events.checkin"],
    production_coordinator: ["events.checkin"],
    marketing_lead: [],
  };

  test("SEAT_IDS has exactly 27 seats", () => {
    expect(SEAT_IDS).toHaveLength(27);
  });

  test("EXPECTED_CAPABILITIES_BY_SEAT covers every seat id (snapshot itself hasn't drifted)", () => {
    expect(Object.keys(EXPECTED_CAPABILITIES_BY_SEAT).sort()).toEqual(
      [...SEAT_IDS].sort(),
    );
  });

  test("every seat's capabilities array matches the pinned spec exactly", () => {
    for (const id of SEAT_IDS) {
      expect(SEAT_DEFS[id].capabilities).toEqual(
        EXPECTED_CAPABILITIES_BY_SEAT[id],
      );
    }
  });
});
