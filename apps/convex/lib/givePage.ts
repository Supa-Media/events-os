/**
 * Public giving map + territory pages (docs/plans/giving-territories.md) —
 * server-rendered HTML from Convex `httpAction`s, the same house pattern as
 * `landingPage.ts`: self-contained inline CSS/JS, OG tags, no external assets
 * (no map-tile service). Served by `http.ts` at `/give` (the map) and
 * `/give/<slug>` (one territory's page). URLs are unchanged from the retired
 * cityCampaigns pages so already-shared links survive the cutover.
 *
 * v3 redesign (2026-08, docs/plans/give-redesign-v3.md) — READ THAT PLAN
 * BEFORE CHANGING THE COMPOSITION HERE. It records decisions that look
 * arbitrary in code and are not:
 *
 *  - The map page's hero is the BACKER ask, and the one-time gift is a section
 *    below it. v2 led with `oneTimeGiveFormHtml` as the first interactive
 *    element and never rendered the monthly form on `/give` at all, so the
 *    conversion the whole page exists for was unreachable from it.
 *  - The hero carries NO backer count (D2). 20/30/50 guarantee different
 *    things, so naming twenty in the headline caps the ask at the floor.
 *  - No compensation claim anywhere (D3) — it is not a flex, and it becomes
 *    false the day it changes.
 *  - The money model moved to `/give/how-it-works`; the books are at
 *    `/finances`, which neither give page linked to before v3 despite it being
 *    the org's strongest asset.
 *  - The wall shows every gift given THROUGH THESE PAGES, anonymous unless the
 *    giver signed it (D6), which is what let the territory page drop `noindex`
 *    (D10). Money that arrives another way (desk-entered checks, imports) is
 *    counted in the totals but has no row — `/finances` is the complete
 *    record, and the wall's own footer says so.
 *  - Program cards merged into the milestone ladder — they were always the same
 *    three things, rendered twice.
 *
 * Public copy says "city"; "territory" stays the internal word (D1).
 *
 * The map's dots are plotted with a hand-rolled equirectangular projection
 * (see `projectPoint`) onto a simplified, hand-rolled continental-US outline
 * polygon (`US_OUTLINE`) — no tile imagery, no third-party map library.
 */
import { BASE_CSS, FAVICON, FONTS } from "./landingPageStyles";
import { GIVE_CSS } from "./givePageStyles";
import { GIVE_CAMPAIGN_SCRIPT } from "./givePageClient";
import {
  bookLinkHtml,
  cityCardsHtml,
  fundraisersHtml,
  givingWallHtml,
  interestSectionHtml,
  moneyTeaserHtml,
  monthlyGiveFormHtml,
  oneTimeGiveFormHtml,
  programForCommitment,
  proofStripHtml,
  type PublicWallData,
} from "./givePageSections";
import { ledgerPath } from "./publicLedgerPage";
import { escapeHtml as esc } from "./html";
import { givePagePath } from "./siteUrl";
import {
  BACKER_UNIT_CENTS,
  CENTRAL_SKIM_PCT,
  formatCents,
  launchTemplateTotalCents,
  PUBLIC_BACKER_TIERS,
  CHAPTER_CORE_ROLES,
} from "@events-os/shared";

type TerritoryStage = "prospect" | "raising" | "launched";

export type MapTerritory = {
  name: string;
  region: string;
  lat: number;
  lng: number;
  slug: string;
  stage: TerritoryStage;
  backerCount: number;
  targetBackers: number;
};

export type PublicTerritoryData = {
  name: string;
  region: string;
  slug: string;
  stage: TerritoryStage;
  backerCount: number;
  targetBackers: number;
  story: string | null;
  /** Whether an uploaded share-card image exists (→ emit `og:image`). */
  hasOgImage: boolean;
  milestones: Array<{
    minBackers: number;
    label: string;
    commitment: string;
    description?: string;
  }>;
  nextMilestone: {
    minBackers: number;
    label: string;
    commitment: string;
    description?: string;
  } | null;
  // The pre-launch launch pot (docs/plans/giving-territories.md §D3), or `null`
  // once launched (the page renders the launched state as before). `months` is
  // the last-12 gift series, oldest→newest ("watch the pot go up").
  launchFund: {
    cents: number;
    targetCents: number;
    months: Array<{ month: string; cents: number }>;
  } | null;
  /**
   * This chapter's fundraiser event pages carrying a `goalCents` — OPEN AND
   * FINISHED (v3, docs/plans/give-redesign-v3.md §C3/D9).
   *
   * Was `upcomingFundraisers`, future-only, capped 5, and rendered only for a
   * launched-but-under-backed territory. A finished fundraiser vanishing the
   * moment its date passed threw away the best evidence a chapter has that it
   * is real — "we did Pathway Ball, we did the block party" — and closed a door
   * nobody asked to close, since a finished fundraiser with a goal is still
   * something a person can give toward, into the same pot. Now capped 8, open
   * first (soonest), then finished (most recent), and rendered for every
   * territory that has any. `goalMet` is descriptive, never a gate.
   */
  fundraisers: Array<{
    name: string;
    slug: string;
    goalCents: number;
    raisedCents: number;
    startDate: number;
    state: "open" | "finished";
    goalMet: boolean;
  }>;
  // Wave 2 (F3) — count of committed/active sponsorships for this chapter (0
  // when none). PII-free (a count, not the sponsor list).
  sponsorshipCount: number;
};

/** PII-free aggregate counts for the interest section's live "N people want
 *  this in their city" line — fed by `api.givingInterest.publicInterestStats`
 *  (bounded counts only, mirrors `getPublicMapData`'s discipline). */
export type InterestStats = { total: number; wantInCity: number };

/**
 * What the two rails cost, handed to the page so it can do the fee arithmetic
 * live as somebody types.
 *
 * Passed in rather than imported because the RATES ARE STORED — a treasurer
 * can override them without a deploy (`processorFeeSchedule`), so the renderer
 * has to be told rather than told-once-at-build. `null` when the schedule
 * can't be read: the page then renders the fee surfaces hidden and gives
 * exactly as it did before, because a fee question must never be the reason
 * somebody can't give.
 */
export type GiveFeeRates = {
  card: { percentBps: number; fixedCents: number; capCents?: number } | null;
  ach: { percentBps: number; fixedCents: number; capCents?: number } | null;
  /** Above this, suggest a bank transfer. NOT a break-even — see
   *  `ACH_NUDGE_THRESHOLD_CENTS`. */
  achThresholdCents: number;
};

// ── Preset give amounts ──────────────────────────────────────────────────────
// One-time (map + territory): $25/$50/$100/$250, default $50. Backer/monthly
// (territory only): $50/$100/$200, default $50, plus a custom "any monthly
// amount" — below BACKER_UNIT_CENTS the giver is framed as a "recurring
// giver" rather than a "backer" (both welcomed; see `givePageSections.ts`'s
// `monthlyGiveFormHtml`/`givePageClient.ts`'s `gc_monthly_note`).

export const ONE_TIME_PRESETS_CENTS = [2500, 5000, 10000, 25000];
export const ONE_TIME_DEFAULT_INDEX = 1; // $50
export const BACKER_PRESETS_CENTS = [5000, 10000, 20000];

// F5 (wave 2): a pre-launch territory's one-time tab is framed as a gift
// toward that city's Launch Fund — swap in a couple of larger suggested
// amounts (keeping the $50 default) to invite generosity toward the ~$8k
// equipment + training ask, rather than the map's smaller "just give" range.
export const LAUNCH_FUND_ONE_TIME_PRESETS_CENTS = [5000, 10000, 25000, 100000];
export const LAUNCH_FUND_ONE_TIME_DEFAULT_INDEX = 0; // $50

// ── Map projection ────────────────────────────────────────────────────────────
// A simple EQUIRECTANGULAR projection (linear lat/lng → x/y — no curvature
// correction; fine at continental-US scale for a schematic map, not a
// navigational one) onto a fixed SVG viewBox. `MAP_LAT_*`/`MAP_LNG_*` are the
// continental US's rough bounding box (Key West to the Canadian border;
// Pacific coast to the Maine coast) — Alaska/Hawaii are out of frame (PRD
// Appendix C#6: US-only at v1), matching the hand-rolled outline below.

const MAP_VIEW_WIDTH = 960;
const MAP_VIEW_HEIGHT = 600;
const MAP_LAT_MIN = 24.5; // Key West, FL
const MAP_LAT_MAX = 49.5; // US/Canada border (49th parallel + a margin)
const MAP_LNG_MIN = -125; // Pacific coast (Olympic Peninsula)
const MAP_LNG_MAX = -66.5; // Atlantic coast (Eastport, ME)

/** lat/lng → SVG {x,y} in the `MAP_VIEW_WIDTH`×`MAP_VIEW_HEIGHT` viewBox.
 *  x scales longitude west→east across the box; y scales latitude
 *  north→south (SVG's y grows DOWNWARD, so it's the INVERSE of latitude,
 *  which grows northward — hence `MAP_LAT_MAX - lat` in the numerator). */
function projectPoint(lat: number, lng: number): { x: number; y: number } {
  const x =
    ((lng - MAP_LNG_MIN) / (MAP_LNG_MAX - MAP_LNG_MIN)) * MAP_VIEW_WIDTH;
  const y =
    ((MAP_LAT_MAX - lat) / (MAP_LAT_MAX - MAP_LAT_MIN)) * MAP_VIEW_HEIGHT;
  return { x, y };
}

/** Clamp a projected dot inside the viewBox with a small margin, so a city
 *  just outside the hand-rolled outline (e.g. near a coastline simplification)
 *  never renders off-canvas. */
function clampToView(p: { x: number; y: number }): { x: number; y: number } {
  const margin = 14;
  return {
    x: Math.min(MAP_VIEW_WIDTH - margin, Math.max(margin, p.x)),
    y: Math.min(MAP_VIEW_HEIGHT - margin, Math.max(margin, p.y)),
  };
}

// A SIMPLIFIED, hand-rolled continental-US border, traced clockwise from the
// Pacific Northwest as ~35 lat/lng waypoints (no imported geo data — a rough
// schematic silhouette, not survey-accurate). Projected through
// `projectPoint` at render time so the outline and the city dots always share
// the exact same projection math.
const US_OUTLINE: ReadonlyArray<[number, number]> = [
  [49.0, -123.0], // Puget Sound
  [46.2, -124.0], // Oregon coast
  [42.0, -124.2], // N. California coast
  [37.8, -122.5], // San Francisco
  [34.0, -119.7], // Santa Barbara
  [32.7, -117.2], // San Diego
  [31.3, -111.0], // AZ/Mexico border
  [31.8, -106.5], // El Paso
  [29.4, -101.4], // Big Bend, TX
  [26.0, -97.2], // Brownsville, TX
  [29.3, -94.8], // Galveston, TX
  [30.0, -89.9], // MS/LA Gulf coast
  [30.4, -87.2], // Pensacola, FL
  [29.7, -85.0], // FL panhandle
  [27.9, -82.6], // Tampa, FL
  [25.1, -80.8], // Florida Keys
  [25.8, -80.2], // Miami, FL
  [30.3, -81.4], // Jacksonville, FL
  [32.8, -79.9], // Charleston, SC
  [35.2, -75.6], // Cape Hatteras, NC
  [37.0, -76.0], // Chesapeake, VA
  [39.3, -74.4], // NJ shore
  [40.7, -74.0], // NYC
  [41.5, -71.3], // Rhode Island
  [42.3, -70.9], // Boston, MA
  [43.7, -69.9], // Maine coast
  [44.8, -66.9], // Eastport, ME (easternmost)
  [45.0, -70.0], // NH/Maine border, north
  [45.0, -75.0], // St. Lawrence / NY border
  [43.5, -79.5], // Niagara (Lake Ontario)
  [41.7, -83.5], // Lake Erie, south shore
  [45.8, -84.7], // Michigan Upper Peninsula
  [47.5, -90.0], // Lake Superior, north shore
  [49.0, -95.0], // Northern MN (Lake of the Woods)
  [49.0, -123.0], // back to start along the 49th parallel
];

function usOutlinePath(): string {
  const points = US_OUTLINE.map(([lat, lng]) => {
    const { x, y } = projectPoint(lat, lng);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `M${points.join("L")}Z`;
}

// ── Shared bits ────────────────────────────────────────────────────────────────

const STAGE_LABEL: Record<TerritoryStage, string> = {
  prospect: "Prospect",
  raising: "Raising",
  launched: "Launched",
};

function stageChip(stage: TerritoryStage): string {
  return `<span class="chip ${stage}">${STAGE_LABEL[stage]}</span>`;
}

function ogHead(opts: {
  title: string;
  description: string;
  url: string;
  /** Absolute URL of the 1080×1080 share-card image (the uploaded per-territory
   *  card). When set, the page advertises it to every OG scraper + uses a
   *  large-image Twitter card. */
  imageUrl?: string;
  /**
   * Emit `<meta name="robots" content="noindex">`.
   *
   * SHARING A LINK IS NOT THE SAME AS BEING INDEXED, and this page is the one
   * place where the difference matters: `/give/<slug>` publishes donor display
   * names next to dollar amounts on the "Backers & gifts" wall. Someone who
   * ticks "Show my name and gift amount on our public giving wall" is agreeing
   * to appear on a page they can be *shown*. They are not agreeing to be
   * findable by name, beside what they gave, in Google forever.
   *
   * `noindex` is exactly that line: crawlers stay out, while the page still
   * loads for anyone with the link and still renders its Open Graph preview
   * card — the OG scrapers behind iMessage/WhatsApp/Slack don't consult
   * `robots`. This is the first `noindex` + `og:*` head in the codebase; the
   * other five (`pollPage`, `reimbursePage`, `unsubscribePage`,
   * `projectActionPage`, `landingPage`'s ticket) are token-gated pages with no
   * preview at all, so the combination is deliberate, not a leftover.
   */
  noindex?: boolean;
}): string {
  const imageTags = opts.imageUrl
    ? `<meta property="og:image" content="${opts.imageUrl}">
<meta property="og:image:width" content="1080">
<meta property="og:image:height" content="1080">
<meta property="og:image:alt" content="${esc(opts.title)}">
<meta name="twitter:image" content="${opts.imageUrl}">`
    : "";
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${opts.noindex ? `<meta name="robots" content="noindex">\n` : ""}<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Public Worship">
<meta property="og:title" content="${esc(opts.title)}">
<meta property="og:description" content="${esc(opts.description)}">
<meta property="og:url" content="${opts.url}">
<meta name="twitter:card" content="${opts.imageUrl ? "summary_large_image" : "summary"}">
<meta name="twitter:title" content="${esc(opts.title)}">
<meta name="twitter:description" content="${esc(opts.description)}">
${imageTags}
<meta name="theme-color" content="#FDF6F6">
${FAVICON}
${FONTS}`;
}

/**
 * The hero's one-line pitch (spec D1/D2).
 *
 * DELIBERATELY CARRIES NO BACKER COUNT. An earlier draft read "one of the
 * twenty people who keep worship happening in a neighborhood all year," which
 * is true only of the FIRST rung: 20 backers guarantees Worship With Strangers,
 * 30 adds Eden, 50 adds Love Thy Neighbor. Naming twenty in the headline caps
 * the ask at the floor and undersells every city already above it. The
 * milestone ladder does the counting, per city, where the number is real.
 */
const HERO_SUBHEAD =
  "$50 a month backs the volunteer team that puts worship on a neighborhood corner all year. Every city shows you what it can guarantee today — and what the next few backers would add.";

/** The topbar, with the books link that neither give page carried before v3 —
 *  `/finances` has been live and unlinked from `/give` since it shipped. */
function giveTopbarHtml(): string {
  return `<div class="give-topbar">
  <div class="wordmark">✦ PUBLIC WORSHIP ✦</div>
  <div class="give-topnav"><a class="give-navlink" href="${esc(ledgerPath())}">Read our books →</a></div>
</div>`;
}

function giveFooterHtml(): string {
  return `<footer style="margin-top:20px;text-align:center;font-size:12.5px;color:var(--faint)">Made with <span class="hearts">♥</span> by Public Worship · <a href="${esc(ledgerPath())}">Read our books</a> · <a href="${givePagePath()}/how-it-works">How the money works</a></footer>`;
}

/** Every gift's plain-language transparency line (block #10) — the split
 *  read from `CENTRAL_SKIM_PCT` so it can never drift from the real math.
 *  Shown right under a give form, where the ask is fresh. The second line is
 *  the unrestricted-gift statement (leadership decision, 2026-07): every pool
 *  is unrestricted, and donors are told so at the point of giving. */
function transparencyNoteHtml(): string {
  const localPct = Math.round((1 - CENTRAL_SKIM_PCT) * 100);
  const skimPct = Math.round(CENTRAL_SKIM_PCT * 100);
  return `<p class="transparency-note">Every gift is recorded and receipted by email. ${localPct}% funds the local chapter; ${skimPct}% becomes the City Launch Fund for the next city.</p>
<p class="transparency-note">When we raise for a specific purpose — an event, a program, a new city — that's our stated intention for your gift. Gifts are unrestricted: if a goal is exceeded or plans change, your generosity may support general operations and other programs. A gift to a specific chapter stays with that chapter.</p>`;
}


/** The backer-vs-recurring-giver explainer (block #3), shown right beside the
 *  territory page's give box so the ask and the framing sit together. */
function backerVsRecurringGiverHtml(): string {
  const unit = esc(formatCents(BACKER_UNIT_CENTS, { showCents: false }));
  return `<p class="giveprompt">A backer commits ${unit} or more each month to a city chapter — directly funding the core team. Give a smaller monthly amount and you're a recurring giver: just as valued, building the launch fund with us. Both matter. Both count.</p>`;
}

/** The founding/New-York callout (block #8) — rendered only for the launched
 *  (flagship) chapter, i.e. `data.stage === "launched"`. */
function foundingCalloutHtml(): string {
  return `<section class="founding-callout">
  <h2 class="sectionhead">Where it started</h2>
  <p>Public Worship began in New York, and past giving has already covered its launch fund. Because New York is dense and communal, training didn't require heavy travel costs — so your gift here goes straight into growing the mission everywhere else.</p>
</section>`;
}

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** `"YYYY-MM"` → a short month label (e.g. "Mar"), else the raw key. */
function monthAbbr(key: string): string {
  const m = parseInt(key.split("-")[1] ?? "", 10);
  return Number.isFinite(m) && m >= 1 && m <= 12 ? MONTH_ABBR[m - 1] : key;
}

/**
 * The pre-launch launch-pot module: "Launch fund: $X of ~$8,000", a progress
 * bar, simple month bars ("watch the pot go up"), and the transparency line
 * that this pot offsets central's one-time City Launch Fund grant. Only
 * rendered while the territory is pre-launch (`launchFund` non-null) — a
 * launched territory funds itself and shows the launched state as before.
 */
function launchFundModuleHtml(fund: NonNullable<PublicTerritoryData["launchFund"]>): string {
  const pct =
    fund.targetCents > 0
      ? Math.min(100, Math.round((fund.cents / fund.targetCents) * 100))
      : 0;
  const maxMonth = Math.max(1, ...fund.months.map((m) => m.cents));
  const bars = fund.months
    .map((m) => {
      const h = Math.round((m.cents / maxMonth) * 100);
      const title = `${monthAbbr(m.month)} — ${esc(formatCents(m.cents, { showCents: false }))}`;
      return `<div class="lf-bar" title="${title}">
  <div class="lf-bar-track"><div class="lf-bar-fill" style="height:${h}%"></div></div>
  <div class="lf-bar-lbl">${esc(monthAbbr(m.month))}</div>
</div>`;
    })
    .join("");
  return `<section class="launch-fund">
  <h2>Launch fund</h2>
  <div class="lf-amount"><b>${esc(formatCents(fund.cents, { showCents: false }))}</b> of ~${esc(formatCents(fund.targetCents, { showCents: false }))}</div>
  <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
  <div class="lf-bars">${bars}</div>
  <p class="lf-note">Every dollar backers give before launch goes straight into this pot — it offsets the one-time ~${esc(formatCents(launchTemplateTotalCents(), { showCents: false }))} City Launch Fund grant central would otherwise cover to start the chapter. The pot is our stated intention for these gifts — gifts are unrestricted, so if the goal is exceeded or plans change, they may support general operations and other programs.</p>
</section>`;
}

/** The territory page's milestone ladder — retitled "What your backing
 *  guarantees" (public language reframed from "unlocks" → "guarantees," PRD
 *  §owner note). Each rung reads: unlocked ⇒ "Guaranteed ✓"; the very next
 *  rung ⇒ "<N> more backers guarantee(s) <commitment>"; any further-out rung
 *  ⇒ its plain backer threshold. */
function milestoneLadderHtml(data: PublicTerritoryData): string {
  const rungs = data.milestones
    .map((m) => {
      const unlocked = data.backerCount >= m.minBackers;
      const isNext = !unlocked && data.nextMilestone?.minBackers === m.minBackers;
      const cls = unlocked ? "unlocked" : isNext ? "next" : "";
      const badge = unlocked ? "✓" : String(m.minBackers);
      const remaining = Math.max(0, m.minBackers - data.backerCount);
      const status = unlocked
        ? "Guaranteed ✓"
        : isNext
          ? `${remaining} more backer${remaining === 1 ? "" : "s"} guarantee${remaining === 1 ? "s" : ""} ${esc(m.commitment)}`
          : `${m.minBackers} backers`;
      // v3: the rung carries its own program blurb + Instagram link. The three
      // `programCardsHtml` cards said the same three things as these rungs, in
      // less detail, in a second grid immediately below this one — so the
      // promise and the evidence for it now sit together instead of competing.
      const program = programForCommitment(m.commitment);
      const programLine = program
        ? `<div class="ds">${esc(program.body)}${program.instagramUrl ? ` <a href="${esc(program.instagramUrl)}" target="_blank" rel="noopener">Watch it →</a>` : ""}</div>`
        : m.description
          ? `<div class="ds">${esc(m.description)}</div>`
          : "";
      return `<div class="rung ${cls}">
  <div class="badge">${badge}</div>
  <div class="rt">
    <div class="lb">${esc(m.label)}</div>
    <div class="cm">${status}</div>
    ${programLine}
  </div>
</div>`;
    })
    .join("\n");
  return `<section class="ladder">
  <h2 class="sectionhead">What your backing guarantees</h2>
  ${rungs}
</section>`;
}

/**
 * The territory page's give box: a two-tab (monthly default, one-time) give
 * form, with the backer-vs-recurring-giver explainer and the transparency
 * note right alongside.
 *
 * F5 (wave 2): a PRE-LAUNCH territory (`stage !== "launched"`) frames the
 * one-time tab as a gift toward that city's Launch Fund — a short intro tying
 * the ask to the equipment list, plus larger suggested amounts
 * (`LAUNCH_FUND_ONE_TIME_PRESETS_CENTS`) to invite generosity. A launched
 * territory's one-time tab is unchanged from wave 1.
 */
function giveBoxHtml(data: PublicTerritoryData): string {
  const preLaunch = data.stage !== "launched";
  const oneTimePresets = preLaunch
    ? LAUNCH_FUND_ONE_TIME_PRESETS_CENTS
    : ONE_TIME_PRESETS_CENTS;
  const oneTimeDefaultIndex = preLaunch
    ? LAUNCH_FUND_ONE_TIME_DEFAULT_INDEX
    : ONE_TIME_DEFAULT_INDEX;
  const oneTimeIntro = preLaunch
    ? `<div class="onetime-launch-intro">
  <h3>Give toward the ${esc(data.name)} City Launch Fund</h3>
  <p>Your gift helps buy the microphones, the mixer, the speakers — everything on the launch team's equipment list — and fund their training trip before day one.</p>
</div>`
    : "";
  return `<section class="givecard">
  <div class="givecard-head">
    <h2>Give to ${esc(data.name)}</h2>
  </div>
  ${backerVsRecurringGiverHtml()}
  <div class="give-tabs">
    <button type="button" class="tab-btn active" data-tab="monthly">Give monthly</button>
    <button type="button" class="tab-btn" data-tab="onetime">One-time</button>
  </div>
  <div class="tab-panel active" data-tab-panel="monthly">
    ${monthlyGiveFormHtml(BACKER_PRESETS_CENTS)}
  </div>
  <div class="tab-panel" data-tab-panel="onetime">
    ${oneTimeIntro}
    ${oneTimeGiveFormHtml({
      presetsCents: oneTimePresets,
      defaultIndex: oneTimeDefaultIndex,
      submitLabel: "Give now",
    })}
  </div>
  ${transparencyNoteHtml()}
</section>`;
}

/**
 * The fee half of `window.__GIVE__`, shared by both pages.
 *
 * Emits NOTHING when the rates are unavailable, so the client's `G.cardRate`
 * is simply undefined and every fee surface stays hidden — the page degrades
 * to exactly what it rendered before this feature rather than to a broken
 * form or a wrong number.
 */
function feeBootstrap(rates?: GiveFeeRates | null): Record<string, unknown> {
  if (!rates) return {};
  return {
    ...(rates.card ? { cardRate: rates.card } : {}),
    ...(rates.ach ? { achRate: rates.ach } : {}),
    achThresholdCents: rates.achThresholdCents,
  };
}

// ── /give — the map ──────────────────────────────────────────────────────────

export function renderGiveMapPage(
  territories: MapTerritory[],
  interestStats: InterestStats,
  thankYou: boolean,
  siteUrl: string,
  feeRates?: GiveFeeRates | null,
  wall?: PublicWallData | null,
  nextCommitments: Readonly<
    Record<string, { remaining: number; commitment: string }>
  > = {},
  publishedMonths = 0,
): string {
  // v3: the page asks for a BACKER. The old title ("See where Public Worship is
  // growing, and start a chapter in your city") was a recruiting headline on a
  // giving URL, and it was also the og:title — every share of /give previewed
  // as a 74-character sentence about starting a chapter.
  //
  // No backer NUMBER in the headline (spec D2): the ladder guarantees different
  // things at 20, 30 and 50, so "one of the twenty people" undersells every
  // rung above the first. The ladder does the counting.
  const title = "Back a city.";
  const description =
    "Public Worship gathers neighborhoods for worship in public spaces. $50 a month backs the volunteer team that puts worship on a neighborhood corner all year — and every dollar we spend is published, line by line.";

  // F1 (wave 2): a one-time gift on the map returns to `/give?donated=1` —
  // the orchestrator (http.ts) reads that query param and passes `thankYou`.
  const thankYouBanner = thankYou
    ? `<div class="thankyou success">🙏 Thank you for your gift — a receipt is on its way.</div>`
    : "";

  const dots = territories
    .map((c) => {
      const raw = projectPoint(c.lat, c.lng);
      const { x, y } = clampToView(raw);
      const label = `${esc(c.name)}, ${esc(c.region)} — ${c.backerCount} of ${c.targetBackers} backers (${STAGE_LABEL[c.stage]})`;
      return `<a class="city-dot ${c.stage}" href="${givePagePath(c.slug)}" aria-label="${label}">
  <circle class="ring" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="12"></circle>
  <circle class="core" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6.5"></circle>
  <title>${label}</title>
</a>`;
    })
    .join("\n");

  // v3: giving once is a SECTION, not the page's opening statement, and it asks
  // where the money should go rather than inferring it from which page the
  // giver happened to land on (spec D4). The destination picker is wired by
  // `givePageClient.ts`, which sets `slug` on the POST payload.
  const backableCities = territories.filter((t) => t.stage !== "prospect");
  const cityOptions = backableCities
    .map((t) => `<option value="${esc(t.slug)}">${esc(t.name)}, ${esc(t.region)}</option>`)
    .join("");

  // WITH NO BACKABLE CITY, THERE IS NO CHOICE TO OFFER — so the picker isn't
  // rendered at all. The `<select>` is populated from the same non-prospect
  // list the city grid draws from; when that list is empty, "A specific city"
  // opened an empty dropdown and submitted with no slug, which the API reads as
  // a CENTRAL gift. A giver who deliberately picked "a specific city" and
  // silently got the other thing is the one outcome D4 exists to prevent. The
  // client script is already tolerant: `destinationSlug()` returns '' when
  // `#gc_dest` is missing, which is exactly "central".
  const hasBackableCities = backableCities.length > 0;
  const destBlock = hasBackableCities
    ? `<h2>Where should it go?</h2>
      <p>Both are unrestricted gifts, and both are receipted the same way. Pick whichever you meant.</p>
      <fieldset class="destpick" id="gc_dest">
        <label class="destopt sel"><input type="radio" name="gc_dest_choice" value="central" checked>
          <span><span class="dt">Central operations</span><span class="dh">Keeps the whole thing running &mdash; and seeds the next city's launch fund.</span></span></label>
        <label class="destopt"><input type="radio" name="gc_dest_choice" value="city">
          <span><span class="dt">A specific city</span><span class="dh">Goes to that chapter's team. ${Math.round((1 - CENTRAL_SKIM_PCT) * 100)}% stays local; ${Math.round(CENTRAL_SKIM_PCT * 100)}% funds the next launch.</span></span></label>
        <div class="destcity" id="gc_dest_city" hidden>
          <label class="sr-only" for="gc_dest_slug">Which city</label>
          <select id="gc_dest_slug">${cityOptions}</select>
        </div>
      </fieldset>`
    : `<h2>Where it goes</h2>
      <p>Straight to central operations &mdash; keeping the whole thing running, and seeding the first city's launch fund. It's an unrestricted gift, and it's receipted by email.</p>`;

  const oneTimeSection = `<section id="gc_once">
  <h2 class="sectionhead">Or give once</h2>
  <div class="oncebox">
    <div class="once-l">
      ${destBlock}
    </div>
    <div class="once-r">
      ${oneTimeGiveFormHtml({
        presetsCents: ONE_TIME_PRESETS_CENTS,
        defaultIndex: ONE_TIME_DEFAULT_INDEX,
        submitLabel: "Give now",
        // No wall opt-in on this form: three more fields in front of checkout
        // for something that only matters after it succeeds. There is no
        // thank-you flow that collects it afterwards either — so a one-time
        // gift given here appears on the wall (D6) and is ALWAYS anonymous.
        // See `oneTimeGiveFormHtml`'s doc for the full trade.
        showWallOptIn: false,
      })}
      ${transparencyNoteHtml()}
    </div>
  </div>
</section>`;

  const initialJson = JSON.stringify({
    mode: "map",
    slug: null,
    oneTimePresetsCents: ONE_TIME_PRESETS_CENTS,
    oneTimeDefaultIndex: ONE_TIME_DEFAULT_INDEX,
    ...feeBootstrap(feeRates),
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
${ogHead({ title, description, url: `${siteUrl}${givePagePath()}` })}
<style>
${BASE_CSS}${GIVE_CSS}
</style>
</head>
<body>
<main class="give">
  ${giveTopbarHtml()}

  ${thankYouBanner}

  <div class="give-hero">
    <h1 class="serif">Back a <span style="color:var(--accent)">city</span>.</h1>
    <p>${esc(HERO_SUBHEAD)}</p>
    <div class="hero-cta">
      <a class="ctabtn primary" href="#gc_cities">Back a city &mdash; ${esc(formatCents(BACKER_UNIT_CENTS, { showCents: false }))}/month</a>
      <a class="ctabtn secondary" href="#gc_once">Prefer to give once? &rarr;</a>
    </div>
  </div>

  ${wall ? proofStripHtml(wall.totals) : ""}

  <div id="gc_cities"></div>
  ${cityCardsHtml(territories, nextCommitments)}

  ${wall ? givingWallHtml(wall, { kind: "org" }) : ""}

  ${oneTimeSection}

  ${moneyTeaserHtml(publishedMonths)}

  <section>
    <h2 class="sectionhead">Where we are, and where we're going</h2>
    <div class="mapwrap">
    ${
      territories.length === 0
        ? `<div class="map-empty">No cities on the map yet — check back soon.</div>`
        : `<svg viewBox="0 0 ${MAP_VIEW_WIDTH} ${MAP_VIEW_HEIGHT}" role="img" aria-label="Map of Public Worship chapters and prospect territories across the continental United States">
  <path class="us-outline" d="${usOutlinePath()}"></path>
  ${dots}
</svg>`
    }
    <div class="legend">
      <span class="item"><span class="swatch launched"></span> Launched chapter</span>
      <span class="item"><span class="swatch raising"></span> Raising backers</span>
      <span class="item"><span class="swatch prospect"></span> People asking for one</span>
    </div>
    </div>
  </section>

  ${interestSectionHtml(interestStats)}

  ${giveFooterHtml()}
</main>

<script>window.__GIVE__=${initialJson};</script>
<script>
${GIVE_CAMPAIGN_SCRIPT}
</script>
</body>
</html>`;
}

// ── /give/<slug> — one territory's page ───────────────────────────────────────

export function renderGiveTerritoryPage(
  data: PublicTerritoryData,
  interestStats: InterestStats,
  siteUrl: string,
  pledgeParam: string | null,
  feeRates?: GiveFeeRates | null,
  wall?: PublicWallData | null,
): string {
  const url = `${siteUrl}${givePagePath(data.slug)}`;
  const backerUnit = formatCents(BACKER_UNIT_CENTS, { showCents: false });
  // City-first title + a description carrying the EXACT live backer count (or
  // the zero-state) — the numbers ride in the preview TEXT, so the uploaded
  // image card can stay static ("BECOME A BACKER"). Renders in every share.
  const title = `Public Worship — ${data.name}`;
  const countLine =
    data.backerCount === 0
      ? `Be the first to back Public Worship in ${data.name}, ${data.region}.`
      : data.stage === "launched"
        ? `${data.backerCount} backers strong in ${data.name}, ${data.region}.`
        : `${data.backerCount} of ${data.targetBackers} backers so far in ${data.name}, ${data.region}.`;
  const description = `${countLine} Become a backer at ${backerUnit}/mo, or give a one-time gift.`;
  // The uploaded share card (served from Convex storage), when set.
  const ogImageUrl = data.hasOgImage
    ? `${siteUrl}${givePagePath(data.slug)}/og`
    : undefined;

  const progressPct = data.targetBackers > 0
    ? Math.min(100, Math.round((data.backerCount / data.targetBackers) * 100))
    : 0;

  // `pledgeParam` carries the Stripe return state for BOTH flows: the
  // existing recurring-pledge values ("success"/"canceled", set by
  // `givingPledges.startPledgeCheckout`'s return URL) and the new one-time
  // gift's "donated" value (the `?donated=1` return param, translated to
  // this same slot by http.ts so the renderer's signature stays frozen).
  // v3: the `donated` return is the warmest moment the site ever gets, and it
  // used to spend it on six words of thanks. It now carries the two things
  // worth saying there — the books promise (nobody else can make it) and the
  // one-time → backer upgrade ask, with the city's real remaining gap.
  const upgradeGap = data.nextMilestone
    ? Math.max(0, data.nextMilestone.minBackers - data.backerCount)
    : 0;
  const upgradeLine =
    data.nextMilestone && upgradeGap > 0
      ? ` <b>${upgradeGap} more backer${upgradeGap === 1 ? "" : "s"} guarantee${upgradeGap === 1 ? "s" : ""} ${esc(data.nextMilestone.commitment)} here.</b>`
      : "";
  const thankYou =
    pledgeParam === "success"
      ? `<div class="thankyou success">🙏 Thank you — you're backing ${esc(data.name)}! A receipt is on its way to your inbox.</div>`
      : pledgeParam === "canceled"
        ? `<div class="thankyou canceled">Checkout canceled — ${esc(data.name)} is still waiting for you whenever you're ready.</div>`
        : pledgeParam === "donated"
          ? `<div class="thankyou success stacked">
  <div>🙏 Thank you for your gift to ${esc(data.name)} — a receipt is on its way.</div>
  <div class="ty-upgrade">
    <div class="ty-b">Your gift will appear in <a href="${esc(ledgerPath())}">our public books</a> when we publish that month — the same line-item treatment as everything else we spend.${upgradeLine}</div>
    <a class="ty-cta" href="#gc_monthly_amt">Become a backer — ${esc(formatCents(BACKER_UNIT_CENTS, { showCents: false }))}/month</a>
  </div>
</div>`
          : "";

  const remaining = data.nextMilestone
    ? Math.max(0, data.nextMilestone.minBackers - data.backerCount)
    : 0;
  const nextCallout = data.nextMilestone
    ? `<div class="next-callout">${remaining} more backer${remaining === 1 ? "" : "s"} guarantee${remaining === 1 ? "s" : ""} ${esc(data.nextMilestone.commitment)} in ${esc(data.name)}.</div>`
    : "";

  // F5 (wave 2): a pre-launch territory's one-time tab uses the larger
  // Launch-Fund preset ladder (see `giveBoxHtml`) — bootstrap the SAME
  // presets/default here so the client script's amount picker matches
  // whichever preset is server-rendered `.sel`.
  const preLaunch = data.stage !== "launched";
  const oneTimePresetsCents = preLaunch
    ? LAUNCH_FUND_ONE_TIME_PRESETS_CENTS
    : ONE_TIME_PRESETS_CENTS;
  const oneTimeDefaultIndex = preLaunch
    ? LAUNCH_FUND_ONE_TIME_DEFAULT_INDEX
    : ONE_TIME_DEFAULT_INDEX;

  const initialJson = JSON.stringify({
    mode: "territory",
    slug: data.slug,
    backerPresetsCents: BACKER_PRESETS_CENTS,
    oneTimePresetsCents,
    oneTimeDefaultIndex,
    backerUnitCents: BACKER_UNIT_CENTS,
    ...feeBootstrap(feeRates),
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
${ogHead({
  title,
  description,
  url,
  ...(ogImageUrl ? { imageUrl: ogImageUrl } : {}),
  // NO `noindex` from v3 onward (docs/plans/give-redesign-v3.md D10).
  //
  // It was set because the wall paired self-provided donor display names with
  // amounts, and being *shown* is not the same as being *findable by name
  // beside what you gave, forever*. That reasoning was right, and the cost was
  // that the pages carrying the org's primary ask could never be found by
  // search — a hard ceiling on the one conversion the page exists for.
  //
  // What changed is the wall itself (spec D6): a row is now anonymous by
  // default, and consent gates only the attribution. The rows that DO carry a
  // name are gated a second time on `consentIndexable`, which is set only for
  // consent captured under copy that says plainly the page can be found by
  // search — so nobody who agreed under the old promise is retroactively made
  // searchable. With that in place there is nothing left for `noindex` to
  // protect, and it costs the ask.
})}
<style>
${BASE_CSS}${GIVE_CSS}
</style>
</head>
<body>
<main class="give">
  ${giveTopbarHtml()}
  <a class="give-back" href="${givePagePath()}">← All cities</a>

  ${thankYou}

  <div class="campaign-head">
    ${stageChip(data.stage)}
    <h1 class="serif">${esc(data.name)}</h1>
    <div class="region">${esc(data.region)}</div>
  </div>

  <div class="progress-card">
    <div class="progress-count"><b>${data.backerCount}</b> of ${data.targetBackers} backers</div>
    <div class="progress-sub">Monthly backers funding the five-person volunteer team here.</div>
    <div class="progress-track"><div class="progress-fill" style="width:${progressPct}%"></div></div>
    ${nextCallout}
  </div>

  ${data.launchFund ? launchFundModuleHtml(data.launchFund) : ""}

  ${giveBoxHtml(data)}

  ${milestoneLadderHtml(data)}

  ${bookLinkHtml(data.name)}

  ${wall ? givingWallHtml(wall, { kind: "city", name: data.name }) : ""}

  ${fundraisersHtml(data.fundraisers, data.name)}

  ${data.stage === "launched" ? foundingCalloutHtml() : ""}

  ${data.story ? `<section><h2 class="sectionhead">The story so far</h2><div class="story">${esc(data.story)}</div></section>` : ""}

  ${moneyTeaserHtml(0)}

  ${interestSectionHtml(interestStats)}

  ${giveFooterHtml()}
</main>

<script>window.__GIVE__=${initialJson};</script>
<script>
${GIVE_CAMPAIGN_SCRIPT}
</script>
</body>
</html>`;
}

/** Friendly 404 for an unknown/hidden territory slug. */
export function renderGiveNotFound(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Territory not found · Public Worship</title>${FAVICON}${FONTS}
<style>${BASE_CSS}
.give-404{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;gap:10px}
.give-404 h1{font-family:'Corben',Georgia,serif;font-size:34px}
.give-404 p{color:var(--muted);max-width:320px}
</style></head><body><div class="give-404">
<div style="font-size:44px">🗺️</div>
<h1>Nothing here yet</h1>
<p>This city isn't on the map. <a href="${givePagePath()}">See every city →</a></p>
</div></body></html>`;
}
