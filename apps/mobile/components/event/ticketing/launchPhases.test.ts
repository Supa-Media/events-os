// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors the sibling colocated tests).
import { describe, expect, test } from "@jest/globals";
import { launchPhaseState, defaultOpenPhase } from "./launchPhases";
import type { LaunchPageStats, LaunchPhaseKey } from "./launchPhases";

/** A blank page: nothing filled in, not published, no RSVPs. */
const blank: LaunchPageStats = {
  tagline: "",
  venueName: "",
  published: false,
  goingCount: 0,
  maybeCount: 0,
};

describe("launchPhaseState", () => {
  test("marks nothing done on a blank page", () => {
    const { doneKeys, status } = launchPhaseState(blank);
    expect([...doneKeys]).toEqual([]);
    expect(status.design).toEqual({ label: "In progress", tone: "phase" });
    expect(status.publish).toEqual({ label: "Draft · not live", tone: "neutral" });
    expect(status.grow).toEqual({ label: "0 guests", tone: "neutral" });
    expect(status.run).toEqual({ label: "Door tools", tone: "neutral" });
  });

  test("needs BOTH a tagline and a venue for Design to be done", () => {
    expect(launchPhaseState({ ...blank, tagline: "Big night" }).doneKeys.has("design")).toBe(false);
    expect(launchPhaseState({ ...blank, venueName: "The Chapel" }).doneKeys.has("design")).toBe(false);
    const both = launchPhaseState({ ...blank, tagline: "Big night", venueName: "The Chapel" });
    expect(both.doneKeys.has("design")).toBe(true);
    expect(both.status.design).toEqual({ label: "Ready", tone: "good" });
  });

  test("treats whitespace-only copy as empty", () => {
    const state = launchPhaseState({ ...blank, tagline: "   ", venueName: "  " });
    expect(state.doneKeys.has("design")).toBe(false);
  });

  test("marks Publish done and live once published", () => {
    const state = launchPhaseState({ ...blank, published: true });
    expect(state.doneKeys.has("publish")).toBe(true);
    expect(state.status.publish).toEqual({ label: "Live now", tone: "good" });
  });

  test("counts going + maybe as the guest total, with singular/plural", () => {
    const one = launchPhaseState({ ...blank, goingCount: 1, maybeCount: 0 });
    expect(one.doneKeys.has("grow")).toBe(true);
    expect(one.status.grow.label).toBe("1 guest");

    const many = launchPhaseState({ ...blank, goingCount: 2, maybeCount: 3 });
    expect(many.status.grow.label).toBe("5 guests");
  });

  test("shows a going count on Run only when someone is going", () => {
    expect(launchPhaseState({ ...blank, maybeCount: 4 }).status.run.label).toBe("Door tools");
    expect(launchPhaseState({ ...blank, goingCount: 7 }).status.run.label).toBe("7 going");
  });
});

describe("defaultOpenPhase", () => {
  const keys = (...ks: LaunchPhaseKey[]) => new Set<LaunchPhaseKey>(ks);

  test("opens the first phase that isn't done", () => {
    expect(defaultOpenPhase(keys())).toBe("design");
    expect(defaultOpenPhase(keys("design"))).toBe("publish");
    expect(defaultOpenPhase(keys("design", "publish"))).toBe("grow");
  });

  test("falls back to Design once design, publish and grow are all done", () => {
    expect(defaultOpenPhase(keys("design", "publish", "grow"))).toBe("design");
  });
});
