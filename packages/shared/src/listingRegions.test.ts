import { describe, expect, it } from "vitest";
import { listingRegions } from "./hiring";

describe("listingRegions", () => {
  it("reads a single city from the location line", () => {
    expect(listingRegions("New York City, in person")).toEqual(["nyc"]);
    expect(listingRegions("NYC")).toEqual(["nyc"]);
    expect(listingRegions("DMV (DC, Maryland, Virginia)")).toEqual(["dmv"]);
    expect(listingRegions("Washington, D.C.")).toEqual(["dmv"]);
  });

  it("puts a seat naming both cities under both", () => {
    expect(listingRegions("NYC or DMV")).toEqual(["nyc", "dmv"]);
  });

  it("treats remote and city-less seats as open to both", () => {
    expect(
      listingRegions(
        "Remote, or NYC-based preferred — with some travel for training and chapter launches",
      ),
    ).toEqual(["nyc", "dmv"]);
    expect(listingRegions("")).toEqual(["nyc", "dmv"]);
    expect(listingRegions("Anywhere")).toEqual(["nyc", "dmv"]);
  });

  it("does not match city names inside other words", () => {
    expect(listingRegions("Docked at the Bronxville office")).toEqual([
      "nyc",
      "dmv",
    ]);
  });
});
