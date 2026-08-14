import { describe, expect, test } from "vitest";
import {
  renderGiveMapPage,
  renderGiveTerritoryPage,
  type MapTerritory,
  type PublicTerritoryData,
  type TerritoryActivityEntry,
} from "../lib/givePage";

/**
 * Render smoke tests for the redesigned public `/give` pages (server-rendered
 * HTML, no React). The renderers are pure functions, so these run without the
 * convex-test harness — they guard against the redesign regressing.
 *
 * Wave 1: the immediate one-time give CTA, the City Launch Plan framing, the
 * "guarantees" milestone language, the $50 backer framing (no stale "$20/mo"
 * copy), the program cards, and the interest / suggest-a-space section.
 *
 * Wave 2: the map thank-you banner (F1), the deep money-transparency section
 * (F2 — tiers table, monthly-operating breakdown, launch-fund "what we're
 * buying" equipment list), the launched-but-under-backed sustain section
 * (F3), the multi-select interest checkboxes + founding-team progressive
 * reveal (F4), the one-time → City Launch Fund framing for pre-launch
 * territories (F5), the public activity wall (F6), and the team-philosophy
 * block (F7).
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
  hasOgImage: false,
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
  upcomingFundraisers: [],
  sponsorshipCount: 0,
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
  upcomingFundraisers: [],
  sponsorshipCount: 0,
};

/** Launched but under-backed — triggers F3's sustain section. */
const UNDERBACKED_LAUNCHED_TERRITORY: PublicTerritoryData = {
  ...LAUNCHED_TERRITORY,
  name: "Chicago",
  slug: "chicago-il",
  backerCount: 18,
  targetBackers: 25,
  sponsorshipCount: 2,
  upcomingFundraisers: [
    {
      name: "Fall Cookout Fundraiser",
      slug: "fall-cookout",
      goalCents: 200000,
      raisedCents: 50000,
      startDate: Date.now() + 1000 * 60 * 60 * 24 * 10,
    },
  ],
};

const ACTIVITY: TerritoryActivityEntry[] = [
  {
    kind: "backer",
    displayName: "Sam K.",
    amountCents: 5000,
    message: "Let's make this happen.",
    at: Date.now() - 1000 * 60 * 60 * 24 * 2,
  },
  {
    kind: "gift",
    amountCents: 10000,
    at: Date.now() - 1000 * 60 * 60 * 5,
  },
];

describe("give map page", () => {
  const html = renderGiveMapPage(TERRITORIES, STATS, false, SITE);

  test("renders a full HTML document without throwing", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("</html>");
  });

  test("leads with an immediate one-time give call to action", () => {
    expect(html).toMatch(/one-time/i);
    expect(html).toContain("/api/give/donate");
  });

  test("frames the movement as a city launch plan with the playbook one-liner", () => {
    expect(html).toMatch(/City Launch Plan/i);
    expect(html).toMatch(/self-sustaining/i);
    expect(html).not.toContain("~25 monthly backers");
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

  test("does NOT show a thank-you banner when thankYou is false", () => {
    expect(html).not.toMatch(/thank you for your gift/i);
  });

  test("shows a thank-you banner when thankYou is true (F1)", () => {
    const thanked = renderGiveMapPage(TERRITORIES, STATS, true, SITE);
    expect(thanked).toMatch(/thank you for your gift/i);
    expect(thanked).toContain("receipt is on its way");
  });

  test("tells donors gifts are unrestricted, right under the give form", () => {
    expect(html).toContain("Gifts are unrestricted");
    expect(html).toMatch(/stated intention/i);
    expect(html).toMatch(/general operations and other programs/i);
    expect(html).toMatch(/gift to a specific chapter stays with that chapter/i);
  });

  test("renders the money transparency section (F2)", () => {
    expect(html).toMatch(/Where your giving goes/i);
    expect(html).toMatch(/what we.re buying/i);
    expect(html).toContain("4× Shure SM58 microphones");
    expect(html).toMatch(/Worship With Strangers, every month/);
    expect(html).toMatch(/Chapter Director/);
  });

  test("renders the team-philosophy block (F7), incl. the one-year term", () => {
    expect(html).toMatch(/Who we're looking for/i);
    expect(html).toMatch(/sacrificial giving/i);
    // Positions are a one-year term, renewable once.
    expect(html).toMatch(/one-year term/i);
  });

  test("renders multi-select interest checkboxes (F4)", () => {
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('name="gi_kind"');
    expect(html).toContain('value="want_in_city"');
    expect(html).toContain('value="join_team"');
  });

  test("renders the founding-team role options for the join_team reveal (F4)", () => {
    expect(html).toContain('name="gi_role"');
    expect(html).toMatch(/Chapter Director/);
    // The role's apostrophe is HTML-escaped by `esc()`, like every other
    // interpolated string on this page.
    expect(html).toContain("Wherever I&#39;m needed");
    expect(html).toContain('id="gi_phone"');
    expect(html).toContain('id="gi_social"');
  });

  // The map lists cities, not people — it carries no giving wall, so it stays
  // discoverable. Only the territory pages are noindexed.
  test("stays indexable", () => {
    expect(html).not.toContain('name="robots"');
  });
});

describe("give territory page (raising, pre-launch)", () => {
  const html = renderGiveTerritoryPage(RAISING_TERRITORY, STATS, ACTIVITY, SITE, null);

  test("renders without throwing", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("</html>");
  });

  test("offers both a monthly backer path and a one-time gift path", () => {
    expect(html).toContain("/api/give/pledge");
    expect(html).toContain("/api/give/donate");
  });

  test("uses the $50 backer framing, with no arbitrary $20 lower bound", () => {
    expect(html).not.toContain("$20/mo");
    expect(html).not.toContain("$20 and $49");
  });

  test("OG description carries the exact backer count; no og:image without a card", () => {
    expect(html).toMatch(/9 of 25 backers so far/);
    expect(html).not.toContain('property="og:image"');
  });

  test("emits the og:image + large card when a share card is uploaded", () => {
    const withImg = renderGiveTerritoryPage(
      { ...RAISING_TERRITORY, hasOgImage: true },
      STATS,
      ACTIVITY,
      SITE,
      null,
    );
    expect(withImg).toContain('property="og:image"');
    expect(withImg).toContain("/give/columbus-oh/og");
    expect(withImg).toContain("summary_large_image");
  });

  // The wall publishes donor display names next to dollar amounts. Consenting
  // to appear on a page you can be shown is not consenting to be findable by
  // name in Google — hence noindex, and hence the preview card surviving it.
  test("stays out of search indexes", () => {
    expect(html).toContain('name="robots" content="noindex"');
  });

  test("noindex does NOT cost the page its share preview", () => {
    const withImg = renderGiveTerritoryPage(
      { ...RAISING_TERRITORY, hasOgImage: true },
      STATS,
      ACTIVITY,
      SITE,
      null,
    );
    expect(withImg).toContain('name="robots" content="noindex"');
    // Everything a link unfurl needs, still there beside the robots tag.
    expect(withImg).toContain('property="og:title"');
    expect(withImg).toContain('property="og:description"');
    expect(withImg).toContain('property="og:url"');
    expect(withImg).toContain('property="og:image"');
    expect(withImg).toContain("summary_large_image");
  });

  test("zero backers → a 'be the first' OG description", () => {
    const zero = renderGiveTerritoryPage(
      { ...RAISING_TERRITORY, backerCount: 0 },
      STATS,
      ACTIVITY,
      SITE,
      null,
    );
    expect(zero).toMatch(/Be the first to back Public Worship in Columbus/);
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

  test("tells donors gifts are unrestricted, incl. on the launch-pot copy", () => {
    // The give box's transparency note…
    expect(html).toContain("Gifts are unrestricted");
    expect(html).toMatch(/gift to a specific chapter stays with that chapter/i);
    // …and the launch-fund pot, which raises for a specific purpose.
    expect(html).toMatch(
      /The pot is our stated intention for these gifts — gifts are unrestricted/,
    );
  });

  test("frames the one-time tab as the City Launch Fund (F5, pre-launch)", () => {
    expect(html).toMatch(/Give toward the Columbus City Launch Fund/i);
    expect(html).toMatch(/microphones/i);
    expect(html).toContain("100000"); // $1,000 suggested amount bootstrapped
  });

  test("renders the activity wall with the mock activity (F6)", () => {
    expect(html).toMatch(/Sam K\./);
    expect(html).toContain("$50/mo");
    // The message's apostrophe is HTML-escaped by `esc()`.
    expect(html).toContain("Let&#39;s make this happen.");
    expect(html).toContain("$100"); // the anonymous one-time gift
    expect(html).toMatch(/one-time/);
  });

  test("does not show the sustain section pre-launch", () => {
    expect(html).not.toMatch(/Not fully backed yet/i);
  });
});

describe("give territory page (launched / founding)", () => {
  test("shows a thank-you for a completed one-time gift", () => {
    const html = renderGiveTerritoryPage(
      LAUNCHED_TERRITORY,
      STATS,
      ACTIVITY,
      SITE,
      "donated",
    );
    expect(html).toMatch(/thank you/i);
  });

  test("renders the founding / New York callout for a launched territory", () => {
    const html = renderGiveTerritoryPage(LAUNCHED_TERRITORY, STATS, ACTIVITY, SITE, null);
    expect(html).toMatch(/New York/);
  });

  test("does not show the sustain section once fully backed", () => {
    const html = renderGiveTerritoryPage(LAUNCHED_TERRITORY, STATS, ACTIVITY, SITE, null);
    expect(html).not.toMatch(/Not fully backed yet/i);
  });

  test("shows the activity wall's empty state when there's no activity", () => {
    const html = renderGiveTerritoryPage(LAUNCHED_TERRITORY, STATS, [], SITE, null);
    expect(html).toMatch(/Be the first to back this city/i);
  });
});

describe("give territory page (launched, under-backed — F3 sustain section)", () => {
  const html = renderGiveTerritoryPage(
    UNDERBACKED_LAUNCHED_TERRITORY,
    STATS,
    [],
    SITE,
    null,
  );

  test("shows the sustain section when launched but under target", () => {
    expect(html).toMatch(/Not fully backed yet/i);
    expect(html).toMatch(/one-time gift/i);
  });

  test("mentions sponsorship status", () => {
    expect(html).toMatch(/2 active sponsorships/i);
  });

  test("links the mocked upcoming fundraiser via the rsvp path with a goal progress bar", () => {
    expect(html).toContain("/rsvp/fall-cookout");
    expect(html).toMatch(/Fall Cookout Fundraiser/);
    expect(html).toContain("$500"); // raised
    expect(html).toContain("$2,000"); // goal
  });
});

/**
 * COVER THE FEES + the ACH nudge — the two fee surfaces on the give form.
 *
 * Both render EMPTY and hidden; the client script fills them from the rates
 * stamped into `window.__GIVE__`. So what a render test can pin is the
 * CONTRACT between the two halves: the ids the script looks for exist, the
 * rates it needs are in the bootstrap, and — the property that actually
 * matters — a page rendered WITHOUT rates still renders a working give form.
 */
describe("the fee surfaces on the give form", () => {
  const RATES = {
    card: { percentBps: 290, fixedCents: 30 },
    ach: { percentBps: 80, fixedCents: 0, capCents: 500 },
    achThresholdCents: 50_000,
  };

  test("the cover-fees box says what we RECEIVE, and is off by default", () => {
    const html = renderGiveMapPage(TERRITORIES, STATS, false, SITE, RATES);
    expect(html).toContain('id="gc_onetime_covfees"');
    expect(html).toMatch(/Cover the processing fee so my whole gift gets through/);
    // Rail-neutral, because the form now offers both — and it says the quote
    // follows the method they picked, which is the fix for #732.
    expect(html).toMatch(/the processor takes a cut of every gift/);
    expect(html).toMatch(/priced for the method you picked above/);
    expect(html).toMatch(/Completely optional/);
    // A pre-ticked box that quietly adds money to a total is a dark pattern.
    expect(html).not.toMatch(/id="gc_onetime_covfees"[^>]*checked/);
  });

  test("the rail picker is asked BEFORE the fee is quoted, and defaults to card", () => {
    // The order is the point: Stripe needs the amount when the session is
    // created, so the only way to quote a good rate is to ask first. Card is
    // preselected because a preselection that costs MORE cannot be a dark
    // pattern — and because it is what most people use.
    const html = renderGiveMapPage(TERRITORIES, STATS, false, SITE, RATES);
    expect(html).toContain('id="gc_onetime_paypick"');
    expect(html).toMatch(/How do you plan to pay\?/);
    // And it must NOT read as a commitment — the checkout still offers every
    // rail, and the gift is whatever was charged either way.
    expect(html).toMatch(/you can still pay whichever way you like at checkout/);
    expect(html).toMatch(
      /<input type="radio" name="gc_onetime_method" value="card" checked>/,
    );
    expect(html).toMatch(
      /<input type="radio" name="gc_onetime_method" value="ach_debit">/,
    );
    expect(html.indexOf("gc_onetime_paypick")).toBeLessThan(
      html.indexOf("gc_onetime_covfees"),
    );
    // The monthly form is a SUBSCRIPTION and offers no fee coverage, so it
    // keeps the old footnote rather than growing a picker.
    expect(html).not.toContain('name="gc_monthly_method"');
  });

  test("the live figure and the nudge render hidden, for the script to fill", () => {
    const html = renderGiveMapPage(TERRITORIES, STATS, false, SITE, RATES);
    // Empty until there is an amount to price — never a stale or placeholder
    // number sitting in the markup where a donor could read it as their total.
    expect(html).toContain(
      '<p class="covline" id="gc_onetime_covline" style="display:none"></p>',
    );
    expect(html).toContain(
      '<div class="achnote" id="gc_onetime_achnote" style="display:none"></div>',
    );
  });

  test("both rates and the threshold reach the browser", () => {
    const html = renderGiveMapPage(TERRITORIES, STATS, false, SITE, RATES);
    expect(html).toContain('"cardRate":{"percentBps":290,"fixedCents":30}');
    expect(html).toContain(
      '"achRate":{"percentBps":80,"fixedCents":0,"capCents":500}',
    );
    expect(html).toContain('"achThresholdCents":50000');
  });

  test("WITHOUT rates the form still renders and simply shows no fee figures", () => {
    // The degradation that matters: a fee question must never be the reason
    // somebody cannot give.
    const html = renderGiveMapPage(TERRITORIES, STATS, false, SITE, null);
    expect(html).toContain("/api/give/donate");
    expect(html).toContain('id="gc_onetime_submit"');
    // Asserted on the BOOTSTRAP, not the page: the client script always
    // mentions `G.cardRate` — the point is that no rate was stamped for it to
    // read, so every fee surface stays hidden.
    expect(html).not.toContain('"cardRate":');
    expect(html).not.toContain('"achRate":');
    expect(html).not.toContain('"achThresholdCents":');
  });

  test("the MONTHLY form has no cover-fees box — a subscription is a different question", () => {
    const html = renderGiveTerritoryPage(
      RAISING_TERRITORY,
      STATS,
      ACTIVITY,
      SITE,
      null,
      RATES,
    );
    expect(html).toContain('id="gc_onetime_covfees"');
    expect(html).not.toContain('id="gc_monthly_covfees"');
  });
});
