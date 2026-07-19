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
  seatChildren,
  seatsForChart,
} from "./seats";

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
  // Pins the exact set of seats + which ones carry capabilities, so a future
  // edit to SEAT_DEFS trips a loud, specific failure here instead of silently
  // drifting from the approved org-chart flowchart. The finance trio + the
  // F-6 P1 giving trio (giving.manage/giving.view/nav.giving) are the
  // capability-carrying seats. 2026-07-19 (owner decision, Seyi): giving became
  // an assignable per-role POWER (apps/convex/seats.ts#setSeatGivingPower) —
  // `financial_manager` and `expansion_director` gained the default
  // `giving.view` + `nav.giving` (central-lens READ) as part of the owner's
  // default-access list. These are TEMPLATE defaults; the ED retunes them at
  // runtime, so this pin tracks what a fresh org is STAMPED with, not the live
  // per-org state.
  const EXPECTED_CAPABILITIES_BY_SEAT: Record<SeatId, readonly string[]> = {
    executive_director: [
      "finance.central",
      "finance.accounts",
      "finance.approve",
      "nav.finances",
      "org.editChart",
      "giving.manage",
      "giving.view",
      "nav.giving",
    ],
    // 2026-07-19: added giving.view + nav.giving (owner decision — FM gets
    // central-lens donor READ as an assignable power default).
    financial_manager: [
      "finance.manager",
      "finance.central",
      "finance.accounts",
      "finance.record",
      "nav.finances",
      "giving.view",
      "nav.giving",
    ],
    development_director: ["giving.manage", "giving.view", "nav.giving"],
    partnership_associate: ["giving.view", "nav.giving"],
    fundraising_associate: ["giving.view", "nav.giving"],
    music_director: [],
    a_and_r: [],
    artists: [],
    musicians: [],
    songwriters: [],
    marketing_director: [],
    social_media_manager: [],
    graphic_designer: [],
    marketing_associate: [],
    // 2026-07-19: added giving.view + nav.giving (owner decision — Expansion
    // Director stewards the launch pipeline giving funds; central-lens READ as
    // an assignable power default).
    expansion_director: ["giving.view", "nav.giving"],
    chapter_directors: [],
    recruiting_associate: [],
    training_associate: [],
    // 2026-07-17: added finance.viewer (owner decision — CD sees chapter
    // spending, but reconcile/record stays the Treasurer's job).
    // F-6 P1: chapter-lens giving.view + nav.giving (development desk read).
    chapter_director: [
      "finance.approve",
      "finance.viewer",
      "nav.finances",
      "giving.view",
      "nav.giving",
    ],
    treasurer: [
      "finance.manager",
      "finance.record",
      "nav.finances",
      "giving.view",
      "nav.giving",
    ],
    music_lead: [],
    vocal_lead: [],
    band_lead: [],
    event_lead: [],
    event_organizers: [],
    production_coordinator: [],
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
