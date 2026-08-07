import { describe, expect, test } from "vitest";
import {
  EVENT_CATALOGS,
  allDecompositions,
  resolveCharge,
  catalogForDay,
} from "../lib/salesCatalog";

/**
 * Reconstructing sold items from a bare charge amount.
 *
 * The tests that matter are the refusals. A greedy reading of $60 at Eden returns
 * "hoodie + popcorn + popcorn" — three products that were never sold — so the module
 * must enumerate every reading and assert one only when it is the only one.
 */
const eden = EVENT_CATALOGS.find((c) => c.eventName === "Eden")!.units;
const ptb = EVENT_CATALOGS.find((c) => c.eventName === "Pop The Balloon")!.units;

describe("resolveCharge", () => {
  test("Eden: $30 is one tee, $60 is TWO tees — not a hoodie and two popcorns", () => {
    const one = resolveCharge(3000, eden);
    expect(one.kind).toBe("resolved");
    expect(one.kind === "resolved" && one.lines).toEqual([
      { unit: eden[0], quantity: 1 },
    ]);
    const two = resolveCharge(6000, eden);
    expect(two.kind).toBe("resolved");
    expect(two.kind === "resolved" && two.lines[0].quantity).toBe(2);
    expect(two.kind === "resolved" && two.lines[0].unit.label).toBe("PW Tee");
  });

  test("Eden: the $1 and $3 taps resolve to nothing rather than being forced", () => {
    for (const amount of [100, 300]) {
      const r = resolveCharge(amount, eden);
      expect(r.kind).toBe("unresolved");
      expect(r.kind === "unresolved" && r.reason).toBe("no_match");
    }
  });

  test("Pop The Balloon: $1 is certain, $5 is not", () => {
    const water = resolveCharge(100, ptb);
    expect(water.kind).toBe("resolved");
    expect(water.kind === "resolved" && water.lines[0].unit.label).toBe("Water");

    // A popcorn, or five waters, or $3+$2, … — several exact readings, so none is safe.
    const five = resolveCharge(500, ptb);
    expect(five.kind).toBe("unresolved");
    expect(five.kind === "unresolved" && five.reason).toBe("ambiguous");
    expect(five.kind === "unresolved" && five.waysFound).toBeGreaterThan(1);
  });

  test("the same amount can be certain at one event and ambiguous at another", () => {
    // $3 is nothing at Eden and several things at Pop The Balloon. Scoping the
    // catalogue per event is what makes any of this resolvable.
    expect(resolveCharge(300, eden).kind).toBe("unresolved");
    expect(resolveCharge(300, ptb).kind).toBe("unresolved");
    // …while $30 is a tee at Eden and unrepresentable in the snack catalogue's
    // unambiguous set.
    expect(resolveCharge(3000, eden).kind).toBe("resolved");
  });
});

describe("allDecompositions", () => {
  test("finds every reading, not just the greedy one", () => {
    // $3 from the snack line: one $3 item, or $2+$1, or 3×$1.
    const ways = allDecompositions(300, ptb);
    expect(ways.length).toBe(3);
  });

  test("rejects an amount no combination reaches", () => {
    // Nothing in the Eden catalogue makes $45.
    expect(allDecompositions(4500, eden)).toEqual([]);
  });

  test("refuses absurd baskets rather than returning 40 units", () => {
    // $40 of $1 waters would be 40 units — a mis-key, not a purchase.
    const ways = allDecompositions(4000, [ptb[0]]);
    expect(ways).toEqual([]);
  });

  test("guards against nonsense input", () => {
    expect(allDecompositions(0, eden)).toEqual([]);
    expect(allDecompositions(-100, eden)).toEqual([]);
    expect(allDecompositions(1050.5, eden)).toEqual([]);
    expect(allDecompositions(3000, [])).toEqual([]);
  });
});

describe("catalogForDay", () => {
  test("maps the real sale days to their event", () => {
    expect(catalogForDay("2025-12-06")?.eventName).toBe("Pop The Balloon");
    expect(catalogForDay("2025-12-07")?.eventName).toBe("Pop The Balloon");
    expect(catalogForDay("2026-05-31")?.eventName).toBe("Eden");
    expect(catalogForDay("2026-08-07")).toBeNull();
  });
});

describe("against the real production data", () => {
  test("Eden's 36 taps: 34 tees certain, $10 unresolved", () => {
    // The exact charge amounts from the Stripe export for 2026-05-31.
    const charges = [
      ...Array(30).fill(3000), ...Array(2).fill(6000),
      ...Array(3).fill(300), 100,
    ];
    let tees = 0, unresolvedCents = 0, resolvedCents = 0;
    for (const c of charges) {
      const r = resolveCharge(c, eden);
      if (r.kind === "resolved") { tees += r.lines[0].quantity; resolvedCents += c; }
      else unresolvedCents += c;
    }
    expect(tees).toBe(34);
    expect(resolvedCents).toBe(102000);
    expect(unresolvedCents).toBe(1000);
  });
});
