import { describe, expect, it, test } from "vitest";
import {
  applicationInChapterReach,
  chapterListingRegion,
  listingRegions,
} from "./hiring";

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

describe("chapterListingRegion", () => {
  test("reads the city from the chapter's name or slug, with no everywhere fallback", () => {
    expect(chapterListingRegion({ name: "New York", slug: "new-york" })).toBe("nyc");
    expect(chapterListingRegion({ name: "DMV", slug: "dmv-us-east" })).toBe("dmv");
    expect(chapterListingRegion({ name: "Ohio", slug: "ohio" })).toBeNull();
  });
});

describe("applicationInChapterReach", () => {
  const regions: Record<string, ("nyc" | "dmv")[]> = {
    "nyc-treasurer": ["nyc"],
    "dmv-treasurer": ["dmv"],
  };
  const of = (slug: string) => regions[slug] ?? null;
  const app = (over: Record<string, unknown> = {}) => ({
    roleSlug: "dmv-treasurer",
    roleTitle: "DMV Treasurer",
    ...over,
  });

  test("the role applied for, a ticked role, or the open pool", () => {
    expect(applicationInChapterReach(app({ roleSlug: "nyc-treasurer" }), "nyc", of)).toBe(true);
    expect(applicationInChapterReach(app(), "nyc", of)).toBe(false);
    expect(
      applicationInChapterReach(
        app({ otherRoles: [{ slug: "nyc-treasurer", title: "NYC Treasurer" }] }),
        "nyc",
        of,
      ),
    ).toBe(true);
    expect(applicationInChapterReach(app({ openToOtherRoles: true }), "nyc", of)).toBe(true);
    expect(applicationInChapterReach(app({ openToOtherRoles: true }), null, of)).toBe(true);
    expect(applicationInChapterReach(app({ roleSlug: "nyc-treasurer" }), null, of)).toBe(false);
  });

  test("a role with no listing any more is placed by its title", () => {
    expect(
      applicationInChapterReach(app({ roleSlug: "gone", roleTitle: "NYC Sound Lead" }), "nyc", of),
    ).toBe(true);
    expect(
      applicationInChapterReach(app({ roleSlug: "gone", roleTitle: "Sound Lead" }), "nyc", of),
    ).toBe(false);
  });
});
