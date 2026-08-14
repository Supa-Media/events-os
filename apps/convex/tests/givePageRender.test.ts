import { describe, expect, test } from "vitest";
import {
  renderGiveMapPage,
  renderGiveTerritoryPage,
  type MapTerritory,
  type PublicTerritoryData,
} from "../lib/givePage";
import type { PublicWallData } from "../lib/givePageSections";

/**
 * Render tests for the public `/give` pages (server-rendered HTML, no React).
 * The renderers are pure functions, so these run without the convex-test
 * harness.
 *
 * v3 (docs/plans/give-redesign-v3.md) rebuilt both pages, so these tests are
 * mostly about pinning the founder's LOCKED DECISIONS rather than smoke-testing
 * markup — each one is a thing somebody argued about, and each one would
 * regress silently if a later edit put it back:
 *
 *   D1/D2  the hero is the "Back a city" ask, and carries NO backer count.
 *   D3     no compensation claim anywhere on either page.
 *   D4     giving once stays one tap away, and asks where the money should go.
 *   D5     the money model moved off /give; both pages link out to it.
 *   D6/D7  every settled gift gets a wall row — consent gates ATTRIBUTION,
 *          never existence — and central gifts appear, tagged.
 *   D9     a finished fundraiser that met its goal stays, and stays giveable.
 *   D10    the city page is no longer `noindex`.
 *
 * Plus the merged ladder (program blurbs now ride on the milestone rungs, and
 * the standalone program-card grid is gone), and the surfaces that survived v3
 * unchanged: OG/share cards, the thank-you states, the launch-fund module, the
 * zero-state, and the fee surfaces.
 */

const SITE = "https://publicworship.life";
const STATS = { total: 42, wantInCity: 27 };

/** The salary/compensation claim the founder cut (D3). Deliberately does NOT
 *  ban the bare word "volunteer(s)" — `MONTHLY_OPERATING_LINES` has a
 *  "Food — team, musicians & volunteers" line, and the hero legitimately talks
 *  about "the volunteer team". What is banned is the CLAIM. */
const COMP_CLAIM =
  /salary|salaries|nobody draws|nobody is paid|everyone is a volunteer|all volunteers/i;

/** A number of humans, in the hero — the exact thing D2 forbids ("one of the
 *  twenty people"). Digits only: "the next few backers" is fine, "20 backers"
 *  is not. */
const COUNTED_PEOPLE = /\d[\d,]*\s*(?:more\s+)?(?:people|persons|backers|givers)/i;

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
  fundraisers: [],
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
  fundraisers: [],
  sponsorshipCount: 0,
};

/** A launched chapter with real history: one open fundraiser and one that is
 *  FINISHED AND MET ITS GOAL — the case D9 exists for. */
const FUNDRAISER_TERRITORY: PublicTerritoryData = {
  ...LAUNCHED_TERRITORY,
  name: "Chicago",
  slug: "chicago-il",
  region: "IL",
  backerCount: 18,
  targetBackers: 25,
  sponsorshipCount: 2,
  fundraisers: [
    {
      name: "Fall Cookout Fundraiser",
      slug: "fall-cookout",
      goalCents: 200000,
      raisedCents: 50000,
      startDate: Date.UTC(2026, 8, 14),
      state: "open",
      goalMet: false,
    },
    {
      name: "Pathway Ball",
      slug: "pathway-ball",
      goalCents: 300000,
      raisedCents: 418000,
      startDate: Date.UTC(2026, 2, 3),
      state: "finished",
      goalMet: true,
    },
  ],
};

// ── The public wall fixture (spec §C1) ───────────────────────────────────────
// All four row kinds, and both consent states: `displayName`/`message` are
// non-null ONLY for a giver who consented — the renderer's job is to attribute
// what it is given and stay anonymous otherwise (D6).

const HOUR = 60 * 60 * 1000;

const WALL: PublicWallData = {
  totals: {
    raisedCents: 1_284_500,
    giftCount: 46,
    giverCount: 38,
    backerCount: 21,
    cityCount: 2,
  },
  rows: [
    // Consented recurring backer — name + message render.
    {
      kind: "backer",
      amountCents: 5000,
      at: Date.now() - 2 * 24 * HOUR,
      scopeLabel: "New York",
      scopeSlug: "new-york",
      displayName: "Sam K.",
      message: "Let's make this happen.",
      goal: null,
    },
    // UNCONSENTED one-time gift — exists on the wall, anonymously (D6).
    {
      kind: "gift",
      amountCents: 10000,
      at: Date.now() - 5 * HOUR,
      scopeLabel: "New York",
      scopeSlug: "new-york",
      displayName: null,
      message: null,
      goal: null,
    },
    // A central gift — on the wall, tagged central (D7).
    {
      kind: "central",
      amountCents: 2500,
      at: Date.now() - 30 * HOUR,
      scopeLabel: "Central operations",
      scopeSlug: null,
      displayName: null,
      message: null,
      goal: null,
    },
    // A fundraiser gift — carries that fundraiser's live goal bar.
    {
      kind: "fundraiser",
      amountCents: 7500,
      at: Date.now() - 3 * HOUR,
      scopeLabel: "New York",
      scopeSlug: "new-york",
      displayName: "Dana R.",
      message: null,
      goal: { label: "Pathway Ball", raisedCents: 240000, targetCents: 300000 },
    },
  ],
};

const EMPTY_WALL: PublicWallData = {
  totals: {
    raisedCents: 0,
    giftCount: 0,
    giverCount: 0,
    backerCount: 0,
    cityCount: 0,
  },
  rows: [],
};

// ── Block extractors ─────────────────────────────────────────────────────────
// Several assertions are only meaningful SCOPED to a block: "no backer count"
// is a statement about the hero, not about a page whose city cards are nothing
// but backer counts.

/**
 * Just the words a visitor reads: `<script>`/`<style>` blocks dropped whole,
 * then every remaining tag stripped. Used by the vocabulary assertions, where
 * matching against raw HTML would flag internal identifiers (a slug, a class
 * name, `G.mode==='territory'`) that never reach a reader.
 */
function visibleProse(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

/** The hero: `<div class="give-hero">` up to the city-card anchor below it. */
function heroBlock(html: string): string {
  const start = html.indexOf('class="give-hero"');
  const end = html.indexOf('id="gc_cities"', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

/** The giving wall's `<div class="wallbox">…</div>`. */
function wallBlock(html: string): string {
  const start = html.indexOf('class="wallbox"');
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf("</section>", start);
  return html.slice(start, end);
}

/** The milestone ladder section. */
function ladderBlock(html: string): string {
  const start = html.indexOf('class="ladder"');
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf("</section>", start);
  return html.slice(start, end);
}

/** Every give page ever rendered by these tests, for the page-wide bans. */
const MAP_HTML = renderGiveMapPage(TERRITORIES, STATS, false, SITE, null, WALL, {}, 7);
const TERRITORY_HTML = renderGiveTerritoryPage(
  RAISING_TERRITORY,
  STATS,
  SITE,
  null,
  null,
  WALL,
);

describe("give map page — the hero (D1/D2)", () => {
  const html = MAP_HTML;

  test("renders a full HTML document without throwing", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("</html>");
  });

  test("the h1 and the title are the 'Back a city' ask", () => {
    expect(html).toContain("<title>Back a city.</title>");
    expect(html).toContain('property="og:title" content="Back a city."');
    expect(heroBlock(html)).toMatch(/<h1[^>]*>Back a <span[^>]*>city<\/span>\.<\/h1>/);
  });

  test("the old recruiting headline is gone from the title and the hero", () => {
    // It was a "start a chapter in your city" sentence on a giving URL — and it
    // was the og:title, so every share of /give previewed as that sentence.
    expect(html).not.toMatch(/See where Public Worship is growing/i);
    expect(heroBlock(html)).not.toMatch(/start a chapter/i);
  });

  test("the hero carries NO backer count (D2)", () => {
    // The ladder guarantees different things at 20, 30 and 50, so pinning the
    // headline to twenty caps the ask at the floor and undersells every city
    // already above it. The ladder does the counting, per city.
    const hero = heroBlock(html);
    expect(hero).not.toMatch(COUNTED_PEOPLE);
    expect(hero).not.toMatch(/twenty|thirty|fifty/i);
    expect(hero).not.toMatch(/one of the/i);
    // What it DOES carry: the price, and the promise the ladder will size.
    expect(hero).toContain("$50");
    expect(hero).toMatch(/what the next few backers would add/);
  });

  test("the hero speaks public vocabulary — 'city', never 'territory' (D1)", () => {
    expect(heroBlock(html)).not.toMatch(/territor/i);
  });

  test("both hero CTAs land on the page's two asks", () => {
    const hero = heroBlock(html);
    expect(hero).toContain('href="#gc_cities"');
    expect(hero).toContain('href="#gc_once"');
    expect(html).toContain('id="gc_cities"');
    expect(html).toContain('id="gc_once"');
  });
});

describe("give map page — structure", () => {
  const html = MAP_HTML;

  test("renders the city cards, with the gap rather than the bare total", () => {
    expect(html).toContain('class="citygrid"');
    expect(html).toContain("/give/new-york");
    expect(html).toContain("/give/columbus-oh");
    expect(html).toMatch(/more backers?<\/b> guarantees?/);
    // A prospect city has no chapter to fund yet — it belongs in the
    // "ask for one" card, not the backable grid.
    expect(html).toContain("Ask for a chapter here");
  });

  test("the map is demoted but still rendered, with its legend", () => {
    expect(html).toContain('class="us-outline"');
    expect(html).toMatch(/Where we are, and where we're going/);
    expect(html).toContain("People asking for one");
    // The hero comes first now; the map sits below the cities, the wall and
    // the one-time section.
    expect(html.indexOf('class="give-hero"')).toBeLessThan(
      html.indexOf('class="us-outline"'),
    );
    expect(html.indexOf('id="gc_once"')).toBeLessThan(
      html.indexOf('class="us-outline"'),
    );
  });

  test("captures interest and shows the interest count", () => {
    expect(html).toContain("/api/give/interest");
    expect(html).toContain("27"); // wantInCity
  });

  test("renders multi-select interest checkboxes + the founding-team reveal", () => {
    expect(html).toContain('name="gi_kind"');
    expect(html).toContain('value="want_in_city"');
    expect(html).toContain('value="join_team"');
    expect(html).toContain('name="gi_role"');
    // The role's apostrophe is HTML-escaped by `esc()`.
    expect(html).toContain("Wherever I&#39;m needed");
    expect(html).toContain('id="gi_phone"');
    expect(html).toContain('id="gi_social"');
  });

  test("bootstraps the client with one-time presets", () => {
    expect(html).toContain("__GIVE__");
    expect(html).toContain("2500");
  });

  test("stays indexable", () => {
    expect(html).not.toContain('name="robots"');
  });

  test("does NOT show a thank-you banner when thankYou is false", () => {
    expect(html).not.toMatch(/thank you for your gift/i);
  });

  test("shows a thank-you banner when thankYou is true", () => {
    const thanked = renderGiveMapPage(TERRITORIES, STATS, true, SITE, null, WALL);
    expect(thanked).toMatch(/thank you for your gift/i);
    expect(thanked).toContain("receipt is on its way");
  });

  test("the proof strip reports the wall's real counts", () => {
    expect(html).toContain('class="proofstrip"');
    expect(html).toMatch(/>21<\/div>\s*<div class="pv">monthly backers/);
    expect(html).toMatch(/>38<\/div>\s*<div class="pv">people have given/);
    expect(html).toMatch(/>2<\/div>\s*<div class="pv">cities taking/);
  });

  test("renders without a wall at all (the query is allowed to fail)", () => {
    const noWall = renderGiveMapPage(TERRITORIES, STATS, false, SITE, null, null);
    expect(noWall.startsWith("<!doctype html>")).toBe(true);
    expect(noWall).not.toContain('class="proofstrip"');
    // The ask itself survives — proof is worth a lot, but not the checkout.
    expect(noWall).toContain("/api/give/donate");
    expect(noWall).toContain('class="citygrid"');
  });
});

describe("giving once, from the map (D4)", () => {
  const html = MAP_HTML;

  test("is one tap from the hero, as its own section", () => {
    expect(html).toContain('id="gc_once"');
    expect(html).toMatch(/Or give once/);
    expect(html).toContain("/api/give/donate");
  });

  test("asks where the gift should go — central OR a specific city", () => {
    expect(html).toContain('id="gc_dest"');
    expect(html).toMatch(/Where should it go\?/);
    expect(html).toMatch(
      /<input type="radio" name="gc_dest_choice" value="central" checked>/,
    );
    expect(html).toMatch(/<input type="radio" name="gc_dest_choice" value="city">/);
    expect(html).toMatch(/Central operations/);
    expect(html).toMatch(/A specific city/);
  });

  test("the city picker offers every backable city, and no prospects", () => {
    expect(html).toContain('id="gc_dest_slug"');
    expect(html).toContain('<option value="new-york">New York, NY</option>');
    expect(html).toContain('<option value="columbus-oh">Columbus, OH</option>');
    expect(html).not.toContain('<option value="queens-ny"');
  });

  test("tells donors gifts are unrestricted, right under the give form", () => {
    expect(html).toContain("Gifts are unrestricted");
    expect(html).toMatch(/stated intention/i);
    expect(html).toMatch(/general operations and other programs/i);
    expect(html).toMatch(/gift to a specific chapter stays with that chapter/i);
  });

  test("does not ask for wall consent it would then throw away", () => {
    // A central (no-slug) gift has no wall to appear on, so the opt-in is off
    // the map's form entirely rather than asked and discarded.
    expect(html).not.toContain('id="gc_onetime_share"');
  });
});

describe("the money model moved off /give (D5)", () => {
  test("neither page inlines the finance report", () => {
    for (const html of [MAP_HTML, TERRITORY_HTML]) {
      // The tier table, the two expense breakdowns and the roles table.
      expect(html).not.toContain('class="mt-table"');
      expect(html).not.toContain('class="moneybox"');
      expect(html).not.toContain('class="mt-lines"');
      expect(html).not.toContain('class="mt-line"');
      expect(html).not.toMatch(/Where your giving goes/i);
      expect(html).not.toMatch(/what we.re buying/i);
      expect(html).not.toContain("Shure SM58");
      expect(html).not.toContain("Storage unit");
    }
  });

  test("both pages link to the books AND to how the money works", () => {
    for (const html of [MAP_HTML, TERRITORY_HTML]) {
      expect(html).toContain('href="/finances"');
      expect(html).toContain('href="/give/how-it-works"');
    }
  });

  test("the teaser keeps three facts and the published-months count", () => {
    expect(MAP_HTML).toMatch(/Where the money goes/);
    expect(MAP_HTML).toMatch(/85 \/ 15/);
    expect(MAP_HTML).toContain("$670");
    expect(MAP_HTML).toMatch(/7 months/); // publishedMonths = 7
    // With nothing published yet it must not claim a count.
    const fresh = renderGiveMapPage(TERRITORIES, STATS, false, SITE, null, WALL, {}, 0);
    expect(fresh).toMatch(/Every month/);
    expect(fresh).not.toMatch(/0 months/);
  });

  test("the removed sections are gone from both pages", () => {
    for (const html of [MAP_HTML, TERRITORY_HTML]) {
      expect(html).not.toContain('class="teamphilo"'); // teamPhilosophyHtml
      expect(html).not.toContain('class="raisecards"'); // activeRaisesHtml
      expect(html).not.toContain('class="sustainbox"'); // sustainSectionHtml
      expect(html).not.toContain('class="activitywall"'); // activityWallHtml
      expect(html).not.toContain('class="programgrid"'); // programCardsHtml
      expect(html).not.toMatch(/Who we're looking for/i);
      expect(html).not.toMatch(/Not fully backed yet/i);
      // cityLaunchPlanHtml — folded into the hero. Asserted on the MARKUP, not
      // on the copy: `GIVE_CSS` still carries a `/* city launch plan */`
      // comment, so a copy regex would match the stylesheet forever.
      expect(html).not.toContain('class="citylaunch"');
      expect(html).not.toMatch(/Public Worship — The Movement/);
    }
  });
});

describe("no compensation claim, anywhere (D3)", () => {
  test("the map page makes no claim about who is paid", () => {
    expect(MAP_HTML).not.toMatch(COMP_CLAIM);
  });

  test("the city page makes no claim about who is paid", () => {
    expect(TERRITORY_HTML).not.toMatch(COMP_CLAIM);
  });

  test("every city-page variant stays clean too", () => {
    const variants = [
      renderGiveTerritoryPage(LAUNCHED_TERRITORY, STATS, SITE, "donated", null, WALL),
      renderGiveTerritoryPage(FUNDRAISER_TERRITORY, STATS, SITE, null, null, WALL),
      renderGiveTerritoryPage(RAISING_TERRITORY, STATS, SITE, "success", null, null),
    ];
    for (const html of variants) expect(html).not.toMatch(COMP_CLAIM);
  });

  test("the ban is on the CLAIM, not on the word 'volunteer'", () => {
    // Guards the guard: the pages legitimately describe a volunteer team, and a
    // regex that banned the bare word would fail for the wrong reason.
    expect(MAP_HTML).toMatch(/volunteer/i);
  });
});

describe("give city page (raising, pre-launch)", () => {
  const html = TERRITORY_HTML;

  test("renders without throwing", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("</html>");
  });

  test("offers both a monthly backer path and a one-time gift path", () => {
    expect(html).toContain("/api/give/pledge");
    expect(html).toContain("/api/give/donate");
    // Monthly is the DEFAULT tab; one-time is the second.
    expect(html).toContain('<button type="button" class="tab-btn active" data-tab="monthly">');
    expect(html).toContain('<button type="button" class="tab-btn" data-tab="onetime">');
  });

  test("uses the $50 backer framing, with no arbitrary $20 lower bound", () => {
    expect(html).not.toContain("$20/mo");
    expect(html).not.toContain("$20 and $49");
  });

  test("shows the progress card and the next-milestone callout", () => {
    expect(html).toMatch(/<b>9<\/b> of 25 backers/);
    expect(html).toMatch(
      /11 more backers guarantee Worship With Strangers, monthly in Columbus\./,
    );
  });

  test("OG description carries the exact backer count; no og:image without a card", () => {
    expect(html).toMatch(/9 of 25 backers so far/);
    expect(html).not.toContain('property="og:image"');
  });

  test("emits the og:image + large card when a share card is uploaded", () => {
    const withImg = renderGiveTerritoryPage(
      { ...RAISING_TERRITORY, hasOgImage: true },
      STATS,
      SITE,
      null,
      null,
      WALL,
    );
    expect(withImg).toContain('property="og:image"');
    expect(withImg).toContain("/give/columbus-oh/og");
    expect(withImg).toContain("summary_large_image");
    expect(withImg).toContain('property="og:title"');
    expect(withImg).toContain('property="og:description"');
    expect(withImg).toContain('property="og:url"');
  });

  test("is INDEXABLE — v3 dropped noindex (D10)", () => {
    // It was set because the wall paired self-provided donor names with
    // amounts. The wall is anonymous by default now (D6) and attribution is
    // gated a second time on `consentIndexable`, so there is nothing left for
    // `noindex` to protect — and it cost the page the one conversion it exists
    // for.
    expect(html).not.toContain('name="robots"');
    expect(html).not.toContain("noindex");
    const withImg = renderGiveTerritoryPage(
      { ...RAISING_TERRITORY, hasOgImage: true },
      STATS,
      SITE,
      null,
      null,
      WALL,
    );
    expect(withImg).not.toContain("noindex");
  });

  test("zero backers → a 'be the first' OG description", () => {
    const zero = renderGiveTerritoryPage(
      { ...RAISING_TERRITORY, backerCount: 0 },
      STATS,
      SITE,
      null,
      null,
      EMPTY_WALL,
    );
    expect(zero).toMatch(/Be the first to back Public Worship in Columbus/);
  });

  test("renders the launch-fund pot with its month bars and unrestricted note", () => {
    expect(html).toMatch(/Launch fund/);
    expect(html).toContain("$2,500");
    expect(html).toContain("$8,000");
    expect(html).toContain('class="lf-bar-fill"');
    expect(html).toMatch(
      /The pot is our stated intention for these gifts — gifts are unrestricted/,
    );
  });

  test("frames the one-time tab as the City Launch Fund (pre-launch)", () => {
    expect(html).toMatch(/Give toward the Columbus City Launch Fund/i);
    expect(html).toMatch(/microphones/i);
    expect(html).toContain("100000"); // $1,000 suggested amount bootstrapped
  });

  test("sends the territory slug with an interest submission", () => {
    expect(html).toContain("columbus-oh");
    expect(html).toContain("/api/give/interest");
  });

  // D1: "territory" is the INTERNAL word — the schema, the queries, the admin
  // and the bootstrap payload all keep it. Public copy says "city". This caught
  // two real leaks when it was written: the monthly form's submit button read
  // "Back this territory", and the 404 said "This territory isn't on the map ·
  // See every territory →".
  //
  // Scoped to the page's PROSE, not the whole document: the inline client
  // script legitimately carries `G.mode==='territory'` and a stack of comments
  // using the internal word, and none of it is copy anybody reads. Strip the
  // <script> blocks and the tags, and what is left is what a visitor sees.
  test("public copy says 'city', never 'territory'", () => {
    expect(visibleProse(html)).not.toMatch(/territor/i);
  });

  test("carries the book link to /finances for this city", () => {
    expect(html).toContain('class="booklink"');
    expect(html).toMatch(/Columbus's book is public/);
  });
});

describe("the milestone ladder, merged with the program cards", () => {
  const ladder = ladderBlock(TERRITORY_HTML);

  test("each rung carries the blurb of the program its commitment names", () => {
    expect(ladder).toMatch(/Worship With Strangers is the monthly rhythm/);
    expect(ladder).toMatch(/Eden brings people together for worship in a park/);
    expect(ladder).toMatch(/Love Thy Neighbor is a block party or cookout/);
  });

  test("each rung links to that program's Instagram post", () => {
    expect(ladder).toContain("https://www.instagram.com/p/DUrTvH6jvRh/"); // WWS
    expect(ladder).toContain("https://www.instagram.com/p/DZGYzsXFhCi/"); // Eden
    expect(ladder).toContain("https://www.instagram.com/p/DO62pchjvAZ/"); // LTN
    expect(ladder).toMatch(/rel="noopener"/);
  });

  test("still frames rungs as guarantees, not unlocks", () => {
    expect(ladder).toMatch(/What your backing guarantees/);
    expect(ladder).toMatch(/11 more backers guarantee Worship With Strangers/);
    expect(ladder).not.toMatch(/unlock/i);
  });

  test("the standalone program-card grid is gone — the blurbs say it once", () => {
    expect(TERRITORY_HTML).not.toContain('class="programgrid"');
    expect(TERRITORY_HTML).not.toContain('class="programcard"');
    // Each program's body text appears exactly once on the page, on its rung.
    const eden = TERRITORY_HTML.split("Eden brings people together").length - 1;
    expect(eden).toBe(1);
  });

  test("an unmatched commitment falls back to the milestone's own description", () => {
    const custom = renderGiveTerritoryPage(
      {
        ...RAISING_TERRITORY,
        milestones: [
          {
            minBackers: 20,
            label: "Weekly prayer",
            commitment: "a weekly prayer walk",
            description: "Every Saturday morning, rain or shine.",
          },
        ],
        nextMilestone: {
          minBackers: 20,
          label: "Weekly prayer",
          commitment: "a weekly prayer walk",
        },
      },
      STATS,
      SITE,
      null,
      null,
      WALL,
    );
    expect(ladderBlock(custom)).toContain("Every Saturday morning, rain or shine.");
  });
});

describe("the public giving wall (D6/D7)", () => {
  const cityWall = wallBlock(TERRITORY_HTML);
  const orgWall = wallBlock(MAP_HTML);

  test("an UNCONSENTED gift still gets a row, anonymously", () => {
    // Consent gates attribution, never existence. The $100 gift in the fixture
    // has no display name and no message.
    expect(cityWall).toContain("$100");
    expect(cityWall).toMatch(/A gift &mdash; <span class="wr-amt">\$100<\/span>/);
    // And it is not labelled as an absence — "Anonymous" points at the very
    // thing the row is being discreet about.
    expect(cityWall).not.toMatch(/anonymous/i);
  });

  test("a CONSENTED gift renders its display name and message", () => {
    expect(cityWall).toContain("<b>Sam K.</b>");
    expect(cityWall).toMatch(/<b>Sam K\.<\/b> started backing/);
    // The message's apostrophe is HTML-escaped by `esc()`.
    expect(cityWall).toContain("Let&#39;s make this happen.");
    expect(cityWall).toContain("<b>Dana R.</b>");
  });

  test("attribution follows the name, row for row", () => {
    // The same row, consented and not — the ONLY difference the renderer makes.
    const unsigned: PublicWallData = {
      ...WALL,
      rows: [{ ...WALL.rows[0], displayName: null, message: null }],
    };
    const signedHtml = renderGiveTerritoryPage(
      RAISING_TERRITORY, STATS, SITE, null, null,
      { ...WALL, rows: [WALL.rows[0]] },
    );
    const unsignedHtml = renderGiveTerritoryPage(
      RAISING_TERRITORY, STATS, SITE, null, null, unsigned,
    );
    expect(wallBlock(signedHtml)).toContain("<b>Sam K.</b>");
    expect(wallBlock(unsignedHtml)).not.toContain("Sam K.");
    expect(wallBlock(unsignedHtml)).toMatch(/Someone started backing/);
    // Both rows exist. Existence is not consent-gated.
    expect(wallBlock(unsignedHtml)).toContain("$50");
  });

  test("a central gift appears on the wall, tagged central (D7)", () => {
    expect(orgWall).toContain('<span class="wr-tag central">central</span>');
    expect(orgWall).toMatch(/A gift to <span class="wr-city">central operations<\/span>/);
  });

  test("a fundraiser row renders its live goal bar", () => {
    expect(cityWall).toContain('class="wr-goal"');
    expect(cityWall).toMatch(/A gift toward Pathway Ball|Dana R\.<\/b> gave toward Pathway Ball/);
    expect(cityWall).toContain('style="width:80%"'); // $2,400 of $3,000
    expect(cityWall).toMatch(/<b>\$2,400<\/b> of \$3,000/);
  });

  test("the org wall leads with the LIVE total (D8), the city wall with backers", () => {
    expect(orgWall).toContain('class="livepill"');
    expect(orgWall).toContain("$12,845"); // raisedCents, live
    expect(orgWall).toMatch(/from 38 people/);
    expect(cityWall).toMatch(/21 backers/);
    expect(cityWall).toMatch(/plus 46 gifts to this chapter/);
    // The books' "published month by month" promise belongs to /finances, and
    // the footer says which number is which.
    expect(orgWall).toMatch(/These totals are live; <a href="\/finances">the books<\/a> are published month by month\./);
  });

  test("keeps times coarse — no precise timestamps beside an amount", () => {
    expect(cityWall).toMatch(/2 days ago/);
    expect(cityWall).toMatch(/5 hours ago/);
    expect(cityWall).not.toMatch(/\d{1,2}:\d{2}/);
  });

  test("a city with backers never reads 'be the first' — with an empty wall…", () => {
    const html = renderGiveTerritoryPage(
      LAUNCHED_TERRITORY, STATS, SITE, null, null, EMPTY_WALL,
    );
    expect(html).not.toMatch(/Be the first to back this city/i);
    expect(html).toMatch(/New York's first gifts will show up here the moment they arrive\./);
    // The rest of the page is unaffected.
    expect(html).toContain("/api/give/pledge");
  });

  test("…nor with no wall at all", () => {
    const html = renderGiveTerritoryPage(
      LAUNCHED_TERRITORY, STATS, SITE, null, null, null,
    );
    expect(html).not.toMatch(/Be the first to back this city/i);
    expect(html).not.toContain('class="wallbox"');
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("/api/give/pledge");
  });
});

describe("fundraisers stay, and stay giveable (D9)", () => {
  const html = renderGiveTerritoryPage(
    FUNDRAISER_TERRITORY,
    STATS,
    SITE,
    null,
    null,
    WALL,
  );

  test("the OPEN fundraiser renders with its goal bar and give link", () => {
    expect(html).toMatch(/Fundraisers in Chicago/);
    expect(html).toMatch(/Fall Cookout Fundraiser/);
    expect(html).toContain('<span class="fc-chip live">Open</span>');
    expect(html).toContain("/rsvp/fall-cookout");
    expect(html).toContain("$500"); // raised
    expect(html).toContain("$2,000"); // goal
  });

  test("a FINISHED fundraiser that MET its goal still renders", () => {
    // The founder's explicit ask: a finished fundraiser is the best evidence a
    // chapter has that it is real. It does not vanish the day the event ends.
    expect(html).toMatch(/Pathway Ball/);
    expect(html).toContain('class="fundcard past"');
    expect(html).toContain('<span class="fc-chip done">Goal met</span>');
    expect(html).toMatch(/March 3 &middot; finished/);
    expect(html).toContain("$4,180"); // raised, past the $3,000 goal
    expect(html).toContain("$3,000");
    expect(html).toContain('class="fc-fill met"');
  });

  test("…and STILL CARRIES A GIVE LINK — same pot (D9)", () => {
    // The single assertion this whole block exists for.
    // Scoped to the fundraiser grid — "Pathway Ball" is also a wall row's goal
    // label further up the page.
    const grid = html.slice(html.indexOf('class="fundgrid"'));
    const start = grid.indexOf("Pathway Ball");
    const end = grid.indexOf("</div>", grid.indexOf('class="fc-cta"', start));
    expect(end).toBeGreaterThan(start);
    const card = grid.slice(start, end);
    expect(card).not.toContain("fall-cookout"); // the slice really is one card
    expect(card).toContain('<a class="fc-cta" href="/rsvp/pathway-ball">Give toward this</a>');
  });

  test("a chapter with no fundraisers renders no fundraiser section", () => {
    expect(TERRITORY_HTML).not.toContain('class="fundgrid"');
    expect(TERRITORY_HTML).not.toMatch(/Fundraisers in/);
  });
});

describe("give city page (launched / founding)", () => {
  test("the one-time thank-you carries the books promise AND the upgrade ask", () => {
    const html = renderGiveTerritoryPage(
      { ...LAUNCHED_TERRITORY, backerCount: 18, nextMilestone: {
        minBackers: 20, label: "WWS", commitment: "Worship With Strangers, monthly",
      } },
      STATS,
      SITE,
      "donated",
      null,
      WALL,
    );
    expect(html).toMatch(/Thank you for your gift to New York/);
    expect(html).toMatch(/our public books/);
    expect(html).toMatch(/2 more backers guarantee Worship With Strangers, monthly here\./);
    expect(html).toContain('class="ty-cta"');
    expect(html).toMatch(/Become a backer — \$50\/month/);
  });

  test("a successful pledge thanks the new backer", () => {
    const html = renderGiveTerritoryPage(
      LAUNCHED_TERRITORY, STATS, SITE, "success", null, WALL,
    );
    expect(html).toMatch(/you're backing New York/);
    expect(html).toContain("receipt is on its way");
  });

  test("a canceled checkout is not treated as a gift", () => {
    const html = renderGiveTerritoryPage(
      LAUNCHED_TERRITORY, STATS, SITE, "canceled", null, WALL,
    );
    expect(html).toMatch(/Checkout canceled/);
    expect(html).not.toMatch(/Thank you for your gift/);
  });

  test("renders the founding / New York callout for a launched territory", () => {
    const html = renderGiveTerritoryPage(
      LAUNCHED_TERRITORY, STATS, SITE, null, null, WALL,
    );
    expect(html).toMatch(/Where it started/);
    // A launched chapter funds itself — no launch-fund pot.
    expect(html).not.toContain('class="launch-fund"');
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
  const html = renderGiveMapPage(TERRITORIES, STATS, false, SITE, RATES, WALL);

  test("the cover-fees box says what we RECEIVE, and is off by default", () => {
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
    expect(html).toContain('"cardRate":{"percentBps":290,"fixedCents":30}');
    expect(html).toContain(
      '"achRate":{"percentBps":80,"fixedCents":0,"capCents":500}',
    );
    expect(html).toContain('"achThresholdCents":50000');
  });

  test("WITHOUT rates the form still renders and simply shows no fee figures", () => {
    // The degradation that matters: a fee question must never be the reason
    // somebody cannot give.
    const bare = renderGiveMapPage(TERRITORIES, STATS, false, SITE, null, WALL);
    expect(bare).toContain("/api/give/donate");
    expect(bare).toContain('id="gc_onetime_submit"');
    // Asserted on the BOOTSTRAP, not the page: the client script always
    // mentions `G.cardRate` — the point is that no rate was stamped for it to
    // read, so every fee surface stays hidden.
    expect(bare).not.toContain('"cardRate":');
    expect(bare).not.toContain('"achRate":');
    expect(bare).not.toContain('"achThresholdCents":');
  });

  test("the MONTHLY form has no cover-fees box — a subscription is a different question", () => {
    const territory = renderGiveTerritoryPage(
      RAISING_TERRITORY,
      STATS,
      SITE,
      null,
      RATES,
      WALL,
    );
    expect(territory).toContain('id="gc_onetime_covfees"');
    expect(territory).not.toContain('id="gc_monthly_covfees"');
  });
});
