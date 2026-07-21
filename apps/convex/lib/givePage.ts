/**
 * Public giving map + territory pages (docs/plans/giving-territories.md) —
 * server-rendered HTML from Convex `httpAction`s, the same house pattern as
 * `landingPage.ts`: self-contained inline CSS/JS, OG tags, no external assets
 * (no map-tile service). Served by `http.ts` at `/give` (the map) and
 * `/give/<slug>` (one territory's page). URLs are unchanged from the retired
 * cityCampaigns pages so already-shared links survive the cutover.
 *
 * v2 redesign (2026-07): leads with an immediate one-time "just give" CTA,
 * then the movement/city-launch-plan map, then the backer/recurring-giver
 * give box, milestone "guarantees," program cards, and an interest +
 * suggest-a-space capture section. The shared form/section widgets (one-time
 * give form, monthly give form, interest form, program cards, active-raise
 * goal cards) live in `givePageSections.ts` to keep this file's two page
 * compositions readable.
 *
 * The map's dots are plotted with a hand-rolled equirectangular projection
 * (see `projectPoint`) onto a simplified, hand-rolled continental-US outline
 * polygon (`US_OUTLINE`) — no tile imagery, no third-party map library.
 */
import { BASE_CSS, FAVICON, FONTS } from "./landingPageStyles";
import { GIVE_CSS } from "./givePageStyles";
import { GIVE_CAMPAIGN_SCRIPT } from "./givePageClient";
import {
  activeRaisesHtml,
  interestSectionHtml,
  monthlyGiveFormHtml,
  oneTimeGiveFormHtml,
  programCardsHtml,
} from "./givePageSections";
import { escapeHtml as esc } from "./html";
import { givePagePath } from "./siteUrl";
import {
  BACKER_UNIT_CENTS,
  CENTRAL_SKIM_PCT,
  formatCents,
  launchTemplateTotalCents,
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
};

/** PII-free aggregate counts for the interest section's live "N people want
 *  this in their city" line — fed by `api.givingInterest.publicInterestStats`
 *  (bounded counts only, mirrors `getPublicMapData`'s discipline). */
export type InterestStats = { total: number; wantInCity: number };

// ── Preset give amounts ──────────────────────────────────────────────────────
// One-time (map + territory): $25/$50/$100/$250, default $50. Backer/monthly
// (territory only): $50/$100/$200, default $50, plus a custom "any monthly
// amount" — below BACKER_UNIT_CENTS the giver is framed as a "recurring
// giver" rather than a "backer" (both welcomed; see `givePageSections.ts`'s
// `monthlyGiveFormHtml`/`givePageClient.ts`'s `gc_monthly_note`).

export const ONE_TIME_PRESETS_CENTS = [2500, 5000, 10000, 25000];
export const ONE_TIME_DEFAULT_INDEX = 1; // $50
export const BACKER_PRESETS_CENTS = [5000, 10000, 20000];

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
}): string {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Public Worship">
<meta property="og:title" content="${esc(opts.title)}">
<meta property="og:description" content="${esc(opts.description)}">
<meta property="og:url" content="${opts.url}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(opts.title)}">
<meta name="twitter:description" content="${esc(opts.description)}">
<meta name="theme-color" content="#FDF6F6">
${FAVICON}
${FONTS}`;
}

/** Every gift's plain-language transparency line (block #10) — the split
 *  read from `CENTRAL_SKIM_PCT` so it can never drift from the real math.
 *  Shown right under a give form, where the ask is fresh. */
function transparencyNoteHtml(): string {
  const localPct = Math.round((1 - CENTRAL_SKIM_PCT) * 100);
  const skimPct = Math.round(CENTRAL_SKIM_PCT * 100);
  return `<p class="transparency-note">Every gift is recorded and receipted by email. ${localPct}% funds the local chapter; ${skimPct}% becomes the City Launch Fund for the next city.</p>`;
}

/** The "How a chapter happens" explainer — the playbook's transparency
 *  section (PRD §5), with every number pulled from the shared finance
 *  constants so it can never drift from the real skim/backer/launch-grant
 *  math. Territory-page only (kept as-is from the pre-redesign page); the map
 *  page's philosophy section is `whereYourGivingGoesHtml` below. */
function explainerHtml(): string {
  const localPct = Math.round((1 - CENTRAL_SKIM_PCT) * 100);
  const skimPct = Math.round(CENTRAL_SKIM_PCT * 100);
  return `<section class="explainer">
  <h2 class="sectionhead">How a chapter happens</h2>
  <div class="grid">
    <div class="fact"><div class="k">5</div><div class="v">A core team of five gets a city started — worship, hospitality, comms, ops, and a chapter director.</div></div>
    <div class="fact"><div class="k">${esc(formatCents(BACKER_UNIT_CENTS, { showCents: false }))}/mo</div><div class="v">The backer floor. Every recurring backer chips in at least this much to fund the team's monthly operating costs.</div></div>
    <div class="fact"><div class="k">${localPct}% / ${skimPct}%</div><div class="v">${localPct}% of backer revenue stays local to the chapter; ${skimPct}% goes to the City Launch Fund that seeds the NEXT city.</div></div>
    <div class="fact"><div class="k">~${esc(formatCents(launchTemplateTotalCents(), { showCents: false }))}</div><div class="v">The one-time City Launch Fund grant — equipment plus a training trip — that starts a brand-new chapter.</div></div>
  </div>
</section>`;
}

/** The map page's "Where your giving goes" philosophy section (block #4) —
 *  an adaptation of `explainerHtml`'s fact grid (same constant-driven
 *  numbers) with the philosophy prose ahead of it. */
function whereYourGivingGoesHtml(): string {
  const localPct = Math.round((1 - CENTRAL_SKIM_PCT) * 100);
  const skimPct = Math.round(CENTRAL_SKIM_PCT * 100);
  const launchGrant = esc(
    formatCents(launchTemplateTotalCents(), { showCents: false }),
  );
  return `<section class="explainer">
  <h2 class="sectionhead">Where your giving goes</h2>
  <p class="lead">A core team of five — worship, hospitality, comms, ops, chapter director — runs a city's chapter. ${localPct}% of monthly backer revenue funds their work locally; ${skimPct}% flows to a City Launch Fund that trains and equips the next team. A new city receives about ${launchGrant} to start: equipment, materials, and a training trip. One dollar, multiplied across cities.</p>
  <div class="grid">
    <div class="fact"><div class="k">5</div><div class="v">A core team of five gets a city started — worship, hospitality, comms, ops, and a chapter director.</div></div>
    <div class="fact"><div class="k">${esc(formatCents(BACKER_UNIT_CENTS, { showCents: false }))}/mo</div><div class="v">The backer floor. Every recurring backer chips in at least this much to fund the team's monthly operating costs.</div></div>
    <div class="fact"><div class="k">${localPct}% / ${skimPct}%</div><div class="v">${localPct}% of backer revenue stays local to the chapter; ${skimPct}% goes to the City Launch Fund that seeds the NEXT city.</div></div>
    <div class="fact"><div class="k">~${launchGrant}</div><div class="v">The one-time City Launch Fund grant — equipment plus a training trip — that starts a brand-new chapter.</div></div>
  </div>
</section>`;
}

/** The map page's "City Launch Plan" section (block #2) — the movement
 *  pitch right above the map itself. */
function cityLaunchPlanHtml(): string {
  const unit = esc(formatCents(BACKER_UNIT_CENTS, { showCents: false }));
  return `<div class="citylaunch">
  <h2 class="sectionhead serif">Public Worship — The Movement: City Launch Plan</h2>
  <p>Every city starts the same way: a worship leader, a hospitality coordinator, someone on comms, an operations lead, and a chapter director. Find ~25 monthly backers at ${unit} or more, and that team launches where you are. Starting with New York, we train a team, then plan the next cities together.</p>
</div>`;
}

/** The backer-vs-recurring-giver explainer (block #3), shown right beside the
 *  territory page's give box so the ask and the framing sit together. */
function backerVsRecurringGiverHtml(): string {
  const unit = esc(formatCents(BACKER_UNIT_CENTS, { showCents: false }));
  return `<p class="giveprompt">A backer commits ${unit} or more each month to a city chapter — directly funding the core team. Give between $20 and $49/mo and you're a recurring giver: just as valued, building the launch fund with us. Both matter. Both count.</p>`;
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
  <p class="lf-note">Every dollar backers give before launch goes straight into this pot — it offsets the one-time ~${esc(formatCents(launchTemplateTotalCents(), { showCents: false }))} City Launch Fund grant central would otherwise cover to start the chapter.</p>
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
      return `<div class="rung ${cls}">
  <div class="badge">${badge}</div>
  <div class="rt">
    <div class="lb">${esc(m.label)}</div>
    <div class="cm">${status}</div>
    ${m.description ? `<div class="ds">${esc(m.description)}</div>` : ""}
  </div>
</div>`;
    })
    .join("\n");
  return `<section class="ladder">
  <h2 class="sectionhead">What your backing guarantees</h2>
  ${rungs}
</section>`;
}

/** The territory page's give box: a two-tab (monthly default, one-time) give
 *  form, with the backer-vs-recurring-giver explainer and the transparency
 *  note right alongside. */
function giveBoxHtml(data: PublicTerritoryData): string {
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
    ${oneTimeGiveFormHtml({
      presetsCents: ONE_TIME_PRESETS_CENTS,
      defaultIndex: ONE_TIME_DEFAULT_INDEX,
      submitLabel: "Give now",
    })}
  </div>
  ${transparencyNoteHtml()}
</section>`;
}

// ── /give — the map ──────────────────────────────────────────────────────────

export function renderGiveMapPage(
  territories: MapTerritory[],
  interestStats: InterestStats,
  siteUrl: string,
): string {
  const title = "See where Public Worship is growing, and start a chapter in your city.";
  const description =
    "Public Worship gathers neighborhoods for worship in public spaces — bold gospel and generous community care. Give a one-time gift to help the work right now, or back the team that will bring it to your city.";

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

  const listRows = territories
    .map(
      (c) => `<a class="row" href="${givePagePath(c.slug)}">
  <div class="info"><div class="nm">${esc(c.name)}, ${esc(c.region)}</div><div class="rg">${stageChip(c.stage)}</div></div>
  <div class="stat"><span class="count">${c.backerCount} / ${c.targetBackers} backers</span></div>
</a>`,
    )
    .join("\n");

  const oneTimeCard = `<section class="givecard">
  <div class="givecard-head">
    <h2>Give a one-time gift</h2>
    <p>Every gift goes straight to the mission — no chapter required.</p>
  </div>
  ${oneTimeGiveFormHtml({
    presetsCents: ONE_TIME_PRESETS_CENTS,
    defaultIndex: ONE_TIME_DEFAULT_INDEX,
    submitLabel: "Give now",
  })}
  ${transparencyNoteHtml()}
</section>`;

  const initialJson = JSON.stringify({
    mode: "map",
    slug: null,
    oneTimePresetsCents: ONE_TIME_PRESETS_CENTS,
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
  <div class="give-topbar"><div class="wordmark">✦ PUBLIC WORSHIP ✦</div></div>
  <div class="give-hero">
    <h1 class="serif">${esc(title)}</h1>
    <p>${esc(description)}</p>
  </div>

  ${oneTimeCard}

  ${cityLaunchPlanHtml()}

  <div class="mapwrap">
    ${
      territories.length === 0
        ? `<div class="map-empty">No territories on the map yet — check back soon.</div>`
        : `<svg viewBox="0 0 ${MAP_VIEW_WIDTH} ${MAP_VIEW_HEIGHT}" role="img" aria-label="Map of Public Worship chapters and prospect territories across the continental United States">
  <path class="us-outline" d="${usOutlinePath()}"></path>
  ${dots}
</svg>`
    }
    <div class="legend">
      <span class="item"><span class="swatch launched"></span> Launched chapter</span>
      <span class="item"><span class="swatch raising"></span> Raising</span>
      <span class="item"><span class="swatch prospect"></span> Prospect territory</span>
    </div>
  </div>

  <section>
    <h2 class="sectionhead">Raising right now</h2>
    ${activeRaisesHtml(territories)}
  </section>

  <div class="citylist">
    <h2 class="sectionhead">Every territory</h2>
    ${territories.length === 0 ? `<p style="color:var(--muted);font-size:14px">Nothing here yet.</p>` : listRows}
  </div>

  ${whereYourGivingGoesHtml()}

  ${interestSectionHtml(interestStats)}

  <footer style="margin-top:20px;text-align:center;font-size:12.5px;color:var(--faint)">Made with <span class="hearts">♥</span> by Public Worship</footer>
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
): string {
  const url = `${siteUrl}${givePagePath(data.slug)}`;
  const backerUnit = formatCents(BACKER_UNIT_CENTS, { showCents: false });
  const title = `${data.name}, ${data.region} — ${data.backerCount} of ${data.targetBackers} backers`;
  const description = data.nextMilestone
    ? `${Math.max(0, data.nextMilestone.minBackers - data.backerCount)} more backers guarantee ${data.nextMilestone.commitment} in ${data.name}. Back this territory for ${backerUnit}/mo, or give a one-time gift.`
    : `Help ${data.name}, ${data.region} launch a Public Worship chapter. Back this territory for ${backerUnit}/mo, or give a one-time gift.`;

  const progressPct = data.targetBackers > 0
    ? Math.min(100, Math.round((data.backerCount / data.targetBackers) * 100))
    : 0;

  // `pledgeParam` carries the Stripe return state for BOTH flows: the
  // existing recurring-pledge values ("success"/"canceled", set by
  // `givingPledges.startPledgeCheckout`'s return URL) and the new one-time
  // gift's "donated" value (the `?donated=1` return param, translated to
  // this same slot by http.ts so the renderer's signature stays frozen).
  const thankYou =
    pledgeParam === "success"
      ? `<div class="thankyou success">🙏 Thank you — you're backing ${esc(data.name)}! A receipt is on its way to your inbox.</div>`
      : pledgeParam === "canceled"
        ? `<div class="thankyou canceled">Checkout canceled — ${esc(data.name)} is still waiting for you whenever you're ready.</div>`
        : pledgeParam === "donated"
          ? `<div class="thankyou success">🙏 Thank you for your gift — a receipt is on its way.</div>`
          : "";

  const remaining = data.nextMilestone
    ? Math.max(0, data.nextMilestone.minBackers - data.backerCount)
    : 0;
  const nextCallout = data.nextMilestone
    ? `<div class="next-callout">${remaining} more backer${remaining === 1 ? "" : "s"} guarantee${remaining === 1 ? "s" : ""} ${esc(data.nextMilestone.commitment)} in ${esc(data.name)}.</div>`
    : "";

  const initialJson = JSON.stringify({
    mode: "territory",
    slug: data.slug,
    backerPresetsCents: BACKER_PRESETS_CENTS,
    oneTimePresetsCents: ONE_TIME_PRESETS_CENTS,
    backerUnitCents: BACKER_UNIT_CENTS,
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
${ogHead({ title, description, url })}
<style>
${BASE_CSS}${GIVE_CSS}
</style>
</head>
<body>
<main class="give">
  <div class="give-topbar"><div class="wordmark">✦ PUBLIC WORSHIP ✦</div></div>
  <a class="give-back" href="${givePagePath()}">← All territories</a>

  ${thankYou}

  <div class="campaign-head">
    ${stageChip(data.stage)}
    <h1 class="serif">${esc(data.name)}</h1>
    <div class="region">${esc(data.region)}</div>
  </div>

  <div class="progress-card">
    <div class="progress-count"><b>${data.backerCount}</b> of ${data.targetBackers} backers</div>
    <div class="progress-sub">Monthly backers funding the team that will launch this chapter.</div>
    <div class="progress-track"><div class="progress-fill" style="width:${progressPct}%"></div></div>
  </div>

  ${nextCallout}

  ${data.launchFund ? launchFundModuleHtml(data.launchFund) : ""}

  ${giveBoxHtml(data)}

  ${milestoneLadderHtml(data)}

  ${programCardsHtml()}

  ${data.stage === "launched" ? foundingCalloutHtml() : ""}

  ${data.story ? `<section><h2 class="sectionhead">The story so far</h2><div class="story">${esc(data.story)}</div></section>` : ""}

  ${explainerHtml()}

  ${interestSectionHtml(interestStats)}

  <footer style="margin-top:20px;text-align:center;font-size:12.5px;color:var(--faint)">Made with <span class="hearts">♥</span> by Public Worship</footer>
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
<p>This territory isn't on the map. <a href="${givePagePath()}">See every territory →</a></p>
</div></body></html>`;
}
