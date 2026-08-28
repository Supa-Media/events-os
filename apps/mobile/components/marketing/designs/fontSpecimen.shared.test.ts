// No @types/jest / ambient globals configured for this package — import test
// globals explicitly from @jest/globals (mirrors the sibling colocated tests).
import { describe, expect, test } from "@jest/globals";
import {
  baseFaceName,
  normalizeFaceName,
  resolveSpecimen,
  specimenCaveat,
} from "./fontSpecimen.shared";

/** A stand-in for a device: the exact set of families it has. */
const device = (...families: string[]) => {
  const has = new Set(families.map((f) => f.toLowerCase()));
  return (family: string) => has.has(family.toLowerCase());
};

describe("normalizeFaceName", () => {
  test("trims and collapses the whitespace a human types", () => {
    expect(normalizeFaceName("  Times New   Roman ")).toBe("Times New Roman");
  });
});

describe("baseFaceName", () => {
  test("strips a width modifier", () => {
    expect(baseFaceName("Times New Roman Condensed")).toBe("Times New Roman");
    expect(baseFaceName("Avenir Next Narrow")).toBe("Avenir Next");
  });

  test("is case-insensitive about the modifier", () => {
    expect(baseFaceName("Barbra CONDENSED")).toBe("Barbra");
  });

  test("strips a run of them", () => {
    expect(baseFaceName("Helvetica Extended Wide")).toBe("Helvetica");
  });

  test("a plain face has no base cut", () => {
    expect(baseFaceName("Inter")).toBeNull();
    expect(baseFaceName("SF Pro Display")).toBeNull();
  });

  test("a face CALLED Condensed is a face, not a modifier", () => {
    expect(baseFaceName("Condensed")).toBeNull();
  });

  test("weight is not width — a bold cut is not a substitute story", () => {
    expect(baseFaceName("Inter Bold")).toBeNull();
  });
});

describe("resolveSpecimen", () => {
  test("draws the face when the device genuinely has it", () => {
    expect(resolveSpecimen("Inter", device("Inter"))).toEqual({
      status: "exact",
      fontFamily: "Inter",
    });
  });

  test("prefers the exact cut over the base one", () => {
    expect(
      resolveSpecimen(
        "Times New Roman Condensed",
        device("Times New Roman", "Times New Roman Condensed"),
      ),
    ).toEqual({ status: "exact", fontFamily: "Times New Roman Condensed" });
  });

  test("falls back to the base cut and names it", () => {
    expect(
      resolveSpecimen("Times New Roman Condensed", device("Times New Roman")),
    ).toEqual({
      status: "substitute",
      fontFamily: "Times New Roman",
      actualName: "Times New Roman",
    });
  });

  test("a face that is not a webfont has nothing to draw", () => {
    // Barbra Condensed: no base "Barbra" either, so there is no honest sample.
    expect(
      resolveSpecimen("Barbra Condensed", device("Inter", "Times New Roman")),
    ).toEqual({ status: "unavailable" });
  });

  test("never claims a face on a device that has nothing", () => {
    expect(resolveSpecimen("Inter", device())).toEqual({
      status: "unavailable",
    });
  });

  test("an empty name is unavailable rather than a probe for \"\"", () => {
    expect(resolveSpecimen("   ", device("Inter"))).toEqual({
      status: "unavailable",
    });
  });
});

describe("specimenCaveat", () => {
  test("says nothing when the specimen is the real thing", () => {
    expect(
      specimenCaveat("Inter", { status: "exact", fontFamily: "Inter" }),
    ).toBeNull();
  });

  test("names what you are actually looking at", () => {
    const caveat = specimenCaveat("Times New Roman Condensed", {
      status: "substitute",
      fontFamily: "Times New Roman",
      actualName: "Times New Roman",
    });
    expect(caveat).toContain("Showing Times New Roman");
    expect(caveat).toContain("Times New Roman Condensed");
  });

  test("says so plainly when there is nothing to show", () => {
    expect(
      specimenCaveat("Barbra Condensed", { status: "unavailable" }),
    ).toContain("Barbra Condensed");
  });
});
