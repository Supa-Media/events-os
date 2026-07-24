import { describe, expect, test } from "vitest";
import { requiredModuleSlugsForCourse } from "./academy";
import {
  ROLE_PATHS,
  type RolePath,
  assertRolePathIntegrity,
  getRolePath,
  nextIncompleteModuleForPath,
  requiredModuleSlugsForPath,
  rolePathProgress,
} from "./academyPaths";

/**
 * `academyPaths.ts` maps each org-chart seat / event hat to the ordered
 * Academy course playlist a person in that role is expected to complete,
 * and derives progress against it. The Roles view (and any "what should
 * this person learn next" prompt) reads straight off these lookups, so a
 * broken (kind, seatSlug) identity, a stale progress fraction, or a wrong
 * "next module" pick would silently mis-route someone's training.
 */

// Every real path now carries the Foundations trio, so none has an empty
// `courseSlugs`. This hand-built path exercises the "no written courses yet"
// behavior (empty required set → fraction 0, no next module) that a
// coming-soon-only path used to represent.
const EMPTY_PATH: RolePath = {
  seatSlug: "__empty_fixture__",
  kind: "event_hat",
  title: "Empty fixture",
  icon: "circle",
  courseSlugs: [],
};

describe("ROLE_PATHS integrity", () => {
  test("module loads without throwing (assertions passed at import)", () => {
    // The module ran assertRolePathIntegrity() at load; calling it again must
    // also be a no-op that doesn't throw.
    expect(() => assertRolePathIntegrity()).not.toThrow();
  });

  test("has all 30 paths", () => {
    expect(ROLE_PATHS).toHaveLength(30);
  });

  test("no derived-only seat has a path", () => {
    expect(
      ROLE_PATHS.some((p) => p.kind === "seat" && p.seatSlug === "chapter_directors"),
    ).toBe(false);
  });

  test("(kind, seatSlug) tuples are unique", () => {
    const tuples = ROLE_PATHS.map((p) => `${p.kind}:${p.seatSlug}`);
    expect(new Set(tuples).size).toBe(tuples.length);
  });

  test('"event_lead" exists under BOTH kinds as separate entries', () => {
    expect(getRolePath("event_hat", "event_lead")).toBeDefined();
    expect(getRolePath("seat", "event_lead")).toBeDefined();
    // ...and they are distinct objects with different course playlists.
    expect(getRolePath("event_hat", "event_lead")).not.toBe(
      getRolePath("seat", "event_lead"),
    );
  });
});

describe("getRolePath", () => {
  test("looks up by (kind, seatSlug) identity", () => {
    const p = getRolePath("event_hat", "everyone");
    expect(p?.title).toBe("New member");
    expect(p?.courseSlugs).toEqual([
      "welcome-to-public-worship",
      "how-we-work",
      "finances-for-everyone",
    ]);
  });

  test("returns undefined for a wrong-kind lookup", () => {
    // "everyone" only exists as an event_hat, never a seat.
    expect(getRolePath("seat", "everyone")).toBeUndefined();
  });
});

describe("requiredModuleSlugsForPath", () => {
  test("empty for a path with no (written) courses", () => {
    expect(EMPTY_PATH.courseSlugs).toEqual([]);
    expect(requiredModuleSlugsForPath(EMPTY_PATH)).toEqual([]);
  });

  test("unions required modules across the path's courses", () => {
    const treasurer = getRolePath("seat", "treasurer")!;
    const required = requiredModuleSlugsForPath(treasurer);
    // Derive the expected count from the catalog itself so this test can't go
    // stale when a course in the path gains a lesson (bit us when Foundations
    // grew mid-flight): sum of each course's required modules, deduped.
    const expected = new Set(
      treasurer.courseSlugs.flatMap((slug) => requiredModuleSlugsForCourse(slug)),
    );
    expect(required.length).toBe(expected.size);
    expect(required.length).toBeGreaterThanOrEqual(16);
    expect(new Set(required).size).toBe(required.length); // deduped
    expect(required).toContain("finance-stewardship"); // finances-for-everyone
    expect(required).toContain("finance-monthly-close"); // treasurer
  });
});

describe("rolePathProgress", () => {
  // A hand-built fixture path with a known 2-course playlist.
  const fixture: RolePath = {
    seatSlug: "__fixture__",
    kind: "event_hat",
    title: "Fixture",
    icon: "circle",
    courseSlugs: ["comms-lead"], // modules: tab-crew-duties, tab-comms, capstone-comms-lead
  };

  test("0/total when nothing passed", () => {
    const result = rolePathProgress(fixture, new Set());
    expect(result.total).toBe(3);
    expect(result.completed).toBe(0);
    expect(result.fraction).toBe(0);
  });

  test("partial progress computes the right fraction", () => {
    const passed = new Set(["tab-crew-duties", "tab-comms"]);
    const result = rolePathProgress(fixture, passed);
    expect(result.total).toBe(3);
    expect(result.completed).toBe(2);
    expect(result.fraction).toBeCloseTo(2 / 3);
  });

  test("full completion is fraction 1", () => {
    const passed = new Set([
      "tab-crew-duties",
      "tab-comms",
      "capstone-comms-lead",
    ]);
    const result = rolePathProgress(fixture, passed);
    expect(result.completed).toBe(3);
    expect(result.fraction).toBe(1);
  });

  test("passed slugs outside the path are ignored", () => {
    const passed = new Set(["tab-crew-duties", "some-unrelated-slug"]);
    const result = rolePathProgress(fixture, passed);
    expect(result.completed).toBe(1);
  });

  test("path with no courses is fraction 0, not a full bar", () => {
    const result = rolePathProgress(EMPTY_PATH, new Set());
    expect(result).toEqual({ completed: 0, total: 0, fraction: 0 });
  });
});

describe("nextIncompleteModuleForPath", () => {
  const commsHat = getRolePath("event_hat", "comms_lead")!;
  // courses: chapter-os-fundamentals (first module: what-is-events-os), comms-lead

  test("returns the first not-yet-passed module in course order", () => {
    const next = nextIncompleteModuleForPath(commsHat, new Set());
    expect(next?.slug).toBe("what-is-events-os");
  });

  test("skips passed modules and advances into the next course", () => {
    const fundamentals = requiredModuleSlugsForPath({
      ...commsHat,
      courseSlugs: ["chapter-os-fundamentals"],
    });
    // Pass everything in the first course → next is the first comms-lead module.
    const next = nextIncompleteModuleForPath(commsHat, new Set(fundamentals));
    expect(next?.slug).toBe("tab-crew-duties");
  });

  test("returns null when every required module is passed", () => {
    const all = requiredModuleSlugsForPath(commsHat);
    const next = nextIncompleteModuleForPath(commsHat, new Set(all));
    expect(next).toBeNull();
  });

  test("returns null for a path with no courses (nothing to do yet)", () => {
    expect(nextIncompleteModuleForPath(EMPTY_PATH, new Set())).toBeNull();
  });
});
