import { describe, expect, test } from "@jest/globals";
import { deriveFleetAttention, type FleetScopeSignal } from "./fleetAttention";

function scope(partial: Partial<FleetScopeSignal>): FleetScopeSignal {
  return {
    scope: "c1",
    name: "Chapter",
    lapsedCount: 0,
    hasLapsed: false,
    backerCount: null,
    targetBackers: null,
    backersBelowTarget: false,
    ...partial,
  };
}

describe("deriveFleetAttention", () => {
  test("a clean fleet yields no attention items", () => {
    expect(
      deriveFleetAttention([
        scope({ scope: "central", name: "Central" }),
        scope({ scope: "c1", name: "NY", backerCount: 20, targetBackers: 20 }),
      ]),
    ).toEqual([]);
  });

  test("lapsed items come first, then backer gaps", () => {
    const items = deriveFleetAttention([
      scope({
        scope: "c1",
        name: "NY",
        backerCount: 12,
        targetBackers: 20,
        backersBelowTarget: true,
      }),
      scope({ scope: "central", name: "Central", lapsedCount: 3, hasLapsed: true }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["lapsed", "backer_gap"]);
    expect(items[0].scope).toBe("central");
    expect(items[1].scope).toBe("c1");
  });

  test("lapsed items sort by count desc; backer gaps by gap desc", () => {
    const items = deriveFleetAttention([
      scope({ scope: "a", name: "A", lapsedCount: 1, hasLapsed: true }),
      scope({ scope: "b", name: "B", lapsedCount: 9, hasLapsed: true }),
      scope({
        scope: "c",
        name: "C",
        backerCount: 18,
        targetBackers: 20,
        backersBelowTarget: true,
      }),
      scope({
        scope: "d",
        name: "D",
        backerCount: 2,
        targetBackers: 20,
        backersBelowTarget: true,
      }),
    ]);
    // Lapsed first (9 before 1), then gaps (18 before 2).
    expect(items.map((i) => i.scope)).toEqual(["b", "a", "d", "c"]);
    expect(items[2].count).toBe(18); // D: 20 - 2
    expect(items[3].count).toBe(2); // C: 20 - 18
  });

  test("a backer gap needs both counts present (not just the flag)", () => {
    // Defensive: the flag is server-derived, but null counts never produce a gap.
    const items = deriveFleetAttention([
      scope({
        scope: "c1",
        name: "NY",
        backerCount: null,
        targetBackers: null,
        backersBelowTarget: true,
      }),
    ]);
    expect(items).toEqual([]);
  });

  test("lapsed with a zero count is ignored (flag/count disagree)", () => {
    expect(
      deriveFleetAttention([
        scope({ scope: "c1", name: "NY", lapsedCount: 0, hasLapsed: true }),
      ]),
    ).toEqual([]);
  });
});
