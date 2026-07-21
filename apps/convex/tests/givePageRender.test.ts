import { describe, expect, test } from "vitest";
import {
  renderGiveMapPage,
  renderGiveTerritoryPage,
  type MapTerritory,
  type PublicTerritoryData,
} from "../lib/givePage";

/**
 * Render smoke tests for the redesigned public `/give` pages (server-rendered
 * HTML, no React). The renderers are pure functions, so these run without the
 * convex-test harness — they guard against the redesign regressing: the
 * immediate one-time give CTA, the City Launch Plan framing, the "guarantees"
 * milestone language, the $50 backer framing (no stale "$20/mo" copy), the
 * program cards, and the interest / suggest-a-space section.
 */

const SITE = "https://publicworship.life";
const STATS = { total: 42, wantInCity: 27 };

const TERRITORIES: MapTerritory[] = [
  {
    name: "New York",
    region: "NY",
    lat: 40.73,
    lng: -73.94,
    slug: "new-york",
    stage: "launched",
    backerCount: 31,
    targetBackers: 25,
  },
  {
    name: "Columbus",
    region: "OH",
    lat: 39.96,
    lng: -82.99,
    slug: "columbus-oh",
    stage: "raising",
    backerCount: 9,
    targetBackers: 25,
  },
  {
    name: "Queens",
    region: "NY",
    lat: 40.72,
    lng: -73.79,
    slug: "queens-ny",
    stage: "prospect",
    backerCount: 2,
    targetBackers: 20,
  },
];

const RAISING_TERRITORY: PublicTerritoryData = {
  name: "Columbus",
  region: "OH",
  slug: "columbus-oh",
  stage: "raising",
  backerCount: 9,
  targetBackers: 25,
  story: "A small team started gathering in a park last summer.",
  milestones: [
    { minBackers: 20, label: "WWS", commitment: "Worship With Strangers, monthly" },
    { minBackers: 30, label: "+Eden", commitment: "Eden" },
    { minBackers: 50, label: "+LTN", commitment: "Love Thy Neighbor" },
  ],
  nextMilestone: {
    minBackers: 20,
    label: "WWS",
    commitment: "Worship With Strangers, monthly",
  },
  launchFund: {
    cents: 250000,
    targetCents: 800000,
    months: [
      { month: "2025-08", cents: 40000 },
      { month: "2025-09", cents: 60000 },
    ],
  },
};

const LAUNCHED_TERRITORY: PublicTerritoryData = {
  ...RAISING_TERRITORY,
  name: "New York",
  region: "NY",
  slug: "new-york",
  stage: "launched",
  backerCount: 31,
  targetBackers: 25,
  nextMilestone: null,
  launchFund: null,
};

describe("give map page", () => {
  const html = renderGiveMapPage(TERRITORIES, STATS, SITE);

  test("renders a full HTML document without throwing", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("</html>");
  });

  test("leads with an immediate one-time give call to action", () => {
    expect(html).toMatch(/one-time/i);
    expect(html).toContain("/api/give/donate");
  });

  test("frames the movement as a city launch plan", () => {
    expect(html).toMatch(/City Launch Plan/i);
  });

  test("still renders the map + every-territory list", () => {
    expect(html).toContain("us-outline");
    expect(html).toContain("/give/new-york");
    expect(html).toContain("/give/columbus-oh");
  });

  test("captures interest and shows the interest count", () => {
    expect(html).toContain("/api/give/interest");
    expect(html).toContain("27"); // wantInCity
  });

  test("bootstraps the client with one-time presets", () => {
    expect(html).toContain("__GIVE__");
    expect(html).toContain("2500");
  });
});

describe("give territory page (raising)", () => {
  const html = renderGiveTerritoryPage(RAISING_TERRITORY, STATS, SITE, null);

  test("renders without throwing", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("</html>");
  });

  test("offers both a monthly backer path and a one-time gift path", () => {
    expect(html).toContain("/api/give/pledge");
    expect(html).toContain("/api/give/donate");
  });

  test("uses the $50 backer framing, not the stale $20/mo copy", () => {
    expect(html).not.toContain("$20/mo");
  });

  test("frames milestones as guarantees, not unlocks", () => {
    expect(html).toMatch(/guarantee/i);
  });

  test("describes the programs backing makes happen", () => {
    expect(html).toMatch(/Eden/);
    expect(html).toMatch(/Love Thy Neighbor/);
    expect(html).toMatch(/Worship With Strangers/);
  });

  test("sends the territory slug with an interest submission", () => {
    expect(html).toContain("columbus-oh");
    expect(html).toContain("/api/give/interest");
  });
});

describe("give territory page (launched / founding)", () => {
  test("shows a thank-you for a completed one-time gift", () => {
    const html = renderGiveTerritoryPage(
      LAUNCHED_TERRITORY,
      STATS,
      SITE,
      "donated",
    );
    expect(html).toMatch(/thank you/i);
  });

  test("renders the founding / New York callout for a launched territory", () => {
    const html = renderGiveTerritoryPage(LAUNCHED_TERRITORY, STATS, SITE, null);
    expect(html).toMatch(/New York/);
  });
});
