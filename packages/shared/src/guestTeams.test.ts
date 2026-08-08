import { describe, expect, test } from "vitest";
import {
  TEAM_COLORS,
  MAX_GUEST_TEAMS,
  clampTeamCount,
  defaultTeamNameAt,
  hashCode,
  pickTeamIndex,
  teamColor,
  teamColorKeyAt,
} from "./guestTeams";

describe("team palette", () => {
  test("keys, labels and solid fills are all distinct", () => {
    const keys = new Set(TEAM_COLORS.map((c) => c.key));
    const labels = new Set(TEAM_COLORS.map((c) => c.label));
    const solids = new Set(TEAM_COLORS.map((c) => c.solid.toUpperCase()));
    expect(keys.size).toBe(TEAM_COLORS.length);
    expect(labels.size).toBe(TEAM_COLORS.length);
    // Two teams sharing a fill would be two teams sharing a wristband.
    expect(solids.size).toBe(TEAM_COLORS.length);
  });

  test("every entry carries both render pairs as hex", () => {
    for (const c of TEAM_COLORS) {
      for (const hex of [c.solid, c.onSolid, c.chipBg, c.chipText]) {
        expect(hex).toMatch(/^#[0-9A-F]{6}$/i);
      }
    }
  });

  test("unknown and missing color keys fall back instead of throwing", () => {
    expect(teamColor("nope").key).toBe("unknown");
    expect(teamColor(null).key).toBe("unknown");
    expect(teamColor(undefined).key).toBe("unknown");
    expect(teamColor("red").solid).toBe("#DC2626");
  });

  test("positional helpers wrap past the end of the palette", () => {
    expect(teamColorKeyAt(0)).toBe(TEAM_COLORS[0].key);
    expect(defaultTeamNameAt(0)).toBe(TEAM_COLORS[0].label);
    expect(teamColorKeyAt(MAX_GUEST_TEAMS)).toBe(TEAM_COLORS[0].key);
  });

  test("clampTeamCount pins to 0..MAX and rejects junk", () => {
    expect(clampTeamCount(-3)).toBe(0);
    expect(clampTeamCount(0)).toBe(0);
    expect(clampTeamCount(10)).toBe(10);
    expect(clampTeamCount(999)).toBe(MAX_GUEST_TEAMS);
    expect(clampTeamCount(7.8)).toBe(7);
    expect(clampTeamCount(Number.NaN)).toBe(0);
  });
});

describe("pickTeamIndex — the balancing rule", () => {
  /** Run `arrivals` guests through the rule and return the final sizes. */
  function simulate(teamCount: number, arrivals: number): number[] {
    const teams = Array.from({ length: teamCount }, () => ({ assignedCount: 0 }));
    for (let i = 0; i < arrivals; i++) {
      const idx = pickTeamIndex(teams, `PW-TEST-${i}`);
      teams[idx].assignedCount += 1;
    }
    return teams.map((t) => t.assignedCount);
  }

  test("no teams to pick from returns -1", () => {
    expect(pickTeamIndex([], "PW-1234-5678")).toBe(-1);
  });

  test("always picks a least-loaded team", () => {
    const teams = [
      { assignedCount: 4 },
      { assignedCount: 2 },
      { assignedCount: 7 },
    ];
    expect(pickTeamIndex(teams, "PW-AAAA-BBBB")).toBe(1);
  });

  test("teams stay within one of each other at EVERY step, not just the end", () => {
    const teams = Array.from({ length: 10 }, () => ({ assignedCount: 0 }));
    for (let i = 0; i < 105; i++) {
      teams[pickTeamIndex(teams, `PW-CODE-${i}`)].assignedCount += 1;
      const counts = teams.map((t) => t.assignedCount);
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    }
  });

  test("a full sweep of arrivals divides exactly evenly", () => {
    expect(simulate(10, 100)).toEqual(Array(10).fill(10));
    expect(simulate(4, 20)).toEqual(Array(4).fill(5));
  });

  test("an uneven headcount spreads the remainder one per team", () => {
    const sizes = simulate(10, 105);
    expect(sizes.filter((n) => n === 11)).toHaveLength(5);
    expect(sizes.filter((n) => n === 10)).toHaveLength(5);
  });

  test("consecutive arrivals never land on the same team — same-order tickets split", () => {
    const teams = Array.from({ length: 10 }, () => ({ assignedCount: 0 }));
    let previous = -1;
    for (let i = 0; i < 60; i++) {
      const idx = pickTeamIndex(teams, `PW-PAIR-${i}`);
      expect(idx).not.toBe(previous);
      teams[idx].assignedCount += 1;
      previous = idx;
    }
  });

  test("self-heals after a manual move leaves a team short", () => {
    const teams = Array.from({ length: 4 }, () => ({ assignedCount: 5 }));
    teams[0].assignedCount = 3; // someone was moved off team 0 by hand
    teams[1].assignedCount = 7;
    // The next two arrivals both go to the short team before anyone else.
    teams[pickTeamIndex(teams, "PW-HEAL-1")].assignedCount += 1;
    teams[pickTeamIndex(teams, "PW-HEAL-2")].assignedCount += 1;
    expect(teams[0].assignedCount).toBe(5);
  });

  test("ties don't always resolve to the first team", () => {
    const empty = Array.from({ length: 10 }, () => ({ assignedCount: 0 }));
    const firstPicks = new Set(
      Array.from({ length: 40 }, (_, i) => pickTeamIndex(empty, `PW-SEED-${i}`)),
    );
    expect(firstPicks.size).toBeGreaterThan(1);
  });

  test("the same seed always resolves the same way", () => {
    const teams = Array.from({ length: 6 }, () => ({ assignedCount: 2 }));
    const once = pickTeamIndex(teams, "PW-8FK2-QW9T");
    expect(pickTeamIndex(teams, "PW-8FK2-QW9T")).toBe(once);
    expect(hashCode("PW-8FK2-QW9T")).toBe(hashCode("PW-8FK2-QW9T"));
  });
});
