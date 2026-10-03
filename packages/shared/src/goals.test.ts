import { describe, expect, it } from "vitest";
import {
  ONE_PAGER_2027,
  SEAT_IDS,
  deriveKeyResultProgress,
  formatGoalValue,
  keyResultCode,
  seedDueToMs,
} from "./index";

/**
 * The One Pager is starting data the Goals screen imports once. These pin
 * that the seed still matches the document it came from (5 objectives, 47
 * key results), that every name it uses resolves on import, and that its
 * numbers add up, so a hand edit to the seed can't silently break the import.
 */
describe("ONE_PAGER_2027 seed", () => {
  const seed = ONE_PAGER_2027;
  const krs = seed.objectives.flatMap((o) => o.keyResults);
  const teamNames = new Set(seed.teams.map((t) => t.name));
  const seats = new Set<string>(SEAT_IDS as readonly string[]);

  it("has the One Pager's 5 objectives and 47 key results", () => {
    expect(seed.objectives).toHaveLength(5);
    expect(krs).toHaveLength(47);
  });

  it("names only teams it defines", () => {
    for (const o of seed.objectives) expect(teamNames).toContain(o.owner);
    for (const k of krs) {
      if (k.owner) expect(teamNames).toContain(k.owner);
      for (const c of k.contributors ?? []) expect(teamNames).toContain(c);
      // One accountable owner at most; shared chapter results have none.
      expect(Boolean(k.owner && k.ownerSeat)).toBe(false);
    }
    for (const t of seed.teams) if (t.parent) expect(teamNames).toContain(t.parent);
  });

  it("names only real seats", () => {
    for (const t of seed.teams) {
      if (t.leadSeat) expect(seats).toContain(t.leadSeat);
      for (const s of t.seats ?? []) expect(seats).toContain(s);
    }
    for (const k of krs) {
      if (k.ownerSeat) expect(seats).toContain(k.ownerSeat);
    }
  });

  it("has valid due dates", () => {
    for (const k of krs) {
      if (!k.due) continue;
      expect(k.due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(seedDueToMs(k.due)).toISOString().slice(0, 10)).toBe(k.due);
    }
  });

  it("breaks targets down into parts that add up", () => {
    for (const t of seed.targets) {
      if (!t.children) continue;
      expect(t.children.reduce((s, c) => s + c.target, 0)).toBe(t.target);
    }
  });

  it("uses the funding split agreed on 2026-10-01", () => {
    const funding = seed.targets.find((t) => t.unit === "usd");
    expect(funding?.children?.map((c) => c.target)).toEqual([12000, 9000, 5000, 4000]);
  });
});

describe("goal helpers", () => {
  it("formats values in their unit", () => {
    expect(formatGoalValue(12000, "usd")).toBe("$12,000");
    expect(formatGoalValue(35, "percent")).toBe("35%");
    expect(formatGoalValue(5000, "people")).toBe("5,000");
  });

  it("derives progress only when there is a target", () => {
    expect(deriveKeyResultProgress(undefined, 4)).toEqual({ fraction: null, met: false });
    expect(deriveKeyResultProgress(2, undefined)).toEqual({ fraction: null, met: false });
    expect(deriveKeyResultProgress(2, 4)).toEqual({ fraction: 0.5, met: false });
    expect(deriveKeyResultProgress(5, 4)).toEqual({ fraction: 1, met: true });
  });

  it("numbers key results from their order", () => {
    expect(keyResultCode(1, 3)).toBe("2.4");
  });
});
