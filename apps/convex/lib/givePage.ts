/**
 * Public giving map + territory pages (docs/plans/giving-territories.md) —
 * server-rendered HTML from Convex `httpAction`s, the same house pattern as
 * `landingPage.ts`: self-contained inline CSS/JS, OG tags, no external assets
 * (no map-tile service). Served by `http.ts` at `/give` (the map) and
 * `/give/<slug>` (one territory's page). URLs are unchanged from the retired
 * cityCampaigns pages so already-shared links survive the cutover.
 *
 * The map's dots are plotted with a hand-rolled equirectangular projection
 * (see `projectPoint`) onto a simplified, hand-rolled continental-US outline
 * polygon (`US_OUTLINE`) — no tile imagery, no third-party map library.
 */
import { BASE_CSS, FAVICON, FONTS } from "./landingPageStyles";
import { GIVE_CSS } from "./givePageStyles";
import { GIVE_CAMPAIGN_SCRIPT } from "./givePageClient";
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

/** The "how chapters happen" explainer — the playbook's transparency section
 *  (PRD §5), with every number pulled from the shared finance constants so it
 *  can never drift from the real skim/backer/launch-grant math. */
function explainerHtml(): string {
  const localPct = Math.round((1 - CENTRAL_SKIM_PCT) * 100);
  const skimPct = Math.round(CENTRAL_SKIM_PCT * 100);
  return `<section class="explainer">
  <h2>How a chapter happens</h2>
  <div class="grid">
    <div class="fact"><div class="k">5</div><div class="v">A core team of five gets a city started — worship, hospitality, comms, ops, and a chapter director.</div></div>
    <div class="fact"><div class="k">${esc(formatCents(BACKER_UNIT_CENTS, { showCents: false }))}/mo</div><div class="v">The backer floor. Every recurring backer chips in at least this much to fund the team's monthly operating costs.</div></div>
    <div class="fact"><div class="k">${localPct}% / ${skimPct}%</div><div class="v">${localPct}% of backer revenue stays local to the chapter; ${skimPct}% goes to the City Launch Fund that seeds the NEXT city.</div></div>
    <div class="fact"><div class="k">~${esc(formatCents(launchTemplateTotalCents(), { showCents: false }))}</div><div class="v">The one-time City Launch Fund grant — equipment plus a training trip — that starts a brand-new chapter.</div></div>
  </div>
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

const PRESET_AMOUNTS_CENTS = [2000, 5000, 10000];

function becomeABackerForm(): string {
  return `<section class="backer-form">
  <h2>Back this territory</h2>
  <form id="gc_form">
    <div class="amtgrid">
      ${PRESET_AMOUNTS_CENTS.map(
        (c, i) =>
          `<button type="button" class="amtbtn${i === 1 ? " sel" : ""}" data-cents="${c}">${esc(formatCents(c, { showCents: false }))}</button>`,
      ).join("")}
    </div>
    <div class="amtcustom">
      <span class="cur">$</span>
      <input id="gc_custom" type="text" inputmode="decimal" placeholder="Other monthly amount">
    </div>
    <div class="fld"><label for="gc_name">Your name</label><input id="gc_name" autocomplete="name" placeholder="First and last name"></div>
    <div class="fld"><label for="gc_email">Email</label><input id="gc_email" type="email" autocomplete="email" placeholder="you@example.com"></div>
    <button type="submit" class="submitbtn" id="gc_submit">Back this territory</button>
    <div class="formerr" id="gc_err"></div>
    <div class="formok" id="gc_ok"></div>
  </form>
</section>`;
}

// ── /give — the map ──────────────────────────────────────────────────────────

export function renderGiveMapPage(
  territories: MapTerritory[],
  siteUrl: string,
): string {
  const title = "Back a Public Worship chapter in your city";
  const description =
    "See every Public Worship chapter and prospect territory on one map, and become a monthly backer to help the next one launch.";

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

  <div class="citylist">
    <h2 class="serif">Every territory</h2>
    ${territories.length === 0 ? `<p style="color:var(--muted);font-size:14px">Nothing here yet.</p>` : listRows}
  </div>

  <footer style="margin-top:60px;text-align:center;font-size:12.5px;color:var(--faint)">Made with <span class="hearts">♥</span> by Public Worship</footer>
</main>
</body>
</html>`;
}

// ── /give/<slug> — one territory's page ───────────────────────────────────────

export function renderGiveTerritoryPage(
  data: PublicTerritoryData,
  siteUrl: string,
  pledgeParam: string | null,
): string {
  const url = `${siteUrl}${givePagePath(data.slug)}`;
  const title = `${data.name}, ${data.region} — ${data.backerCount} of ${data.targetBackers} backers`;
  const description = data.nextMilestone
    ? `${Math.max(0, data.nextMilestone.minBackers - data.backerCount)} more backers unlock ${data.nextMilestone.commitment} in ${data.name}. Back this territory for as little as $20/mo.`
    : `Help ${data.name}, ${data.region} launch a Public Worship chapter. Back this territory for as little as $20/mo.`;

  const progressPct = data.targetBackers > 0
    ? Math.min(100, Math.round((data.backerCount / data.targetBackers) * 100))
    : 0;

  const thankYou =
    pledgeParam === "success"
      ? `<div class="thankyou success">🙏 Thank you — you're backing ${esc(data.name)}! A receipt is on its way to your inbox.</div>`
      : pledgeParam === "canceled"
        ? `<div class="thankyou canceled">Checkout canceled — ${esc(data.name)} is still waiting for you whenever you're ready.</div>`
        : "";

  const rungs = data.milestones
    .map((m) => {
      const unlocked = data.backerCount >= m.minBackers;
      const isNext = !unlocked && data.nextMilestone?.minBackers === m.minBackers;
      const cls = unlocked ? "unlocked" : isNext ? "next" : "";
      const badge = unlocked ? "✓" : String(m.minBackers);
      return `<div class="rung ${cls}">
  <div class="badge">${badge}</div>
  <div class="rt">
    <div class="lb">${esc(m.label)}</div>
    <div class="cm">${esc(m.commitment)}</div>
    ${m.description ? `<div class="ds">${esc(m.description)}</div>` : ""}
  </div>
</div>`;
    })
    .join("\n");

  const nextCallout = data.nextMilestone
    ? `<div class="next-callout">${Math.max(0, data.nextMilestone.minBackers - data.backerCount)} more backer${
        Math.max(0, data.nextMilestone.minBackers - data.backerCount) === 1 ? "" : "s"
      } unlock${Math.max(0, data.nextMilestone.minBackers - data.backerCount) === 1 ? "s" : ""} ${esc(data.nextMilestone.commitment)} in ${esc(data.name)}.</div>`
    : "";

  const initialJson = JSON.stringify({
    slug: data.slug,
    presetsCents: PRESET_AMOUNTS_CENTS,
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

  <section class="ladder">
    <h2>What backers unlock</h2>
    ${rungs}
  </section>

  ${explainerHtml()}

  ${data.story ? `<section><div class="sectitle serif" style="font-family:'Corben',Georgia,serif;font-size:21px;margin-bottom:14px">The story so far</div><div class="story">${esc(data.story)}</div></section>` : ""}

  ${becomeABackerForm()}

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
