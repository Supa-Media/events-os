/**
 * Reusable HTML "widgets" shared by the public `/give` map page and `/give/
 * <slug>` territory page (`givePage.ts`) — the one-time give form, the
 * monthly/backer give form, the interest + suggest-a-space section, and the
 * three static "what your backing makes happen" program cards. Split out of
 * `givePage.ts` so the two page-composition functions stay readable; every
 * function here is a pure string builder (no Convex access), matching the
 * house pattern (`esc()` on all interpolated dynamic text).
 *
 * Element ids are deliberately stable across both pages so ONE client script
 * (`givePageClient.ts`) can wire whichever forms happen to be present:
 *   - `gc_onetime_*` — the one-time gift form (map + territory).
 *   - `gc_monthly_*` — the monthly backer/recurring-giver form (territory only).
 *   - `gi_*`         — the interest / suggest-a-space form (map + territory).
 */
import { escapeHtml as esc } from "./html";
import { givePagePath } from "./siteUrl";
import { formatCents } from "@events-os/shared";
import type { MapTerritory } from "./givePage";

// ── One-time give form ───────────────────────────────────────────────────────

/** The one-time gift form's fields (amount presets + custom + name/email +
 *  submit). Callers wrap this in whatever container (a standalone card on the
 *  map page, a tab panel on the territory page) suits the surrounding layout.
 *  `slug` is NOT baked in here — the client script reads it off
 *  `window.__GIVE__.slug`, which is `null` on the map page (⇒ a central gift)
 *  and the territory's slug on a territory page. */
export function oneTimeGiveFormHtml(opts: {
  presetsCents: readonly number[];
  defaultIndex: number;
  submitLabel: string;
}): string {
  const amtButtons = opts.presetsCents
    .map(
      (c, i) =>
        `<button type="button" class="amtbtn${i === opts.defaultIndex ? " sel" : ""}" data-group="gc_onetime" data-cents="${c}">${esc(formatCents(c, { showCents: false }))}</button>`,
    )
    .join("");
  return `<form id="gc_onetime_form">
  <div class="amtgrid">${amtButtons}</div>
  <div class="amtcustom">
    <span class="cur">$</span>
    <input id="gc_onetime_custom" type="text" inputmode="decimal" placeholder="Other amount">
  </div>
  <div class="fld"><label for="gc_onetime_name">Your name</label><input id="gc_onetime_name" autocomplete="name" placeholder="First and last name"></div>
  <div class="fld"><label for="gc_onetime_email">Email</label><input id="gc_onetime_email" type="email" autocomplete="email" placeholder="you@example.com"></div>
  <button type="submit" class="submitbtn" id="gc_onetime_submit">${esc(opts.submitLabel)}</button>
  <div class="formerr" id="gc_onetime_err"></div>
  <div class="formok" id="gc_onetime_ok"></div>
</form>`;
}

// ── Monthly (backer / recurring-giver) give form — territory page only ──────

/** The monthly form's fields. Below `unitCents` (the backer floor,
 *  `BACKER_UNIT_CENTS`), the client script reveals `#gc_monthly_note` — the
 *  "you're a recurring giver, not a backer" framing (both are welcomed; see
 *  `givePage.ts`'s backer-vs-recurring-giver copy right above this form). */
export function monthlyGiveFormHtml(presetsCents: readonly number[]): string {
  const amtButtons = presetsCents
    .map(
      (c, i) =>
        `<button type="button" class="amtbtn${i === 0 ? " sel" : ""}" data-group="gc_monthly" data-cents="${c}">${esc(formatCents(c, { showCents: false }))}</button>`,
    )
    .join("");
  return `<form id="gc_monthly_form">
  <div class="amtgrid">${amtButtons}</div>
  <div class="amtcustom">
    <span class="cur">$</span>
    <input id="gc_monthly_custom" type="text" inputmode="decimal" placeholder="Any monthly amount">
  </div>
  <div class="recurring-note" id="gc_monthly_note" style="display:none">You're giving as a recurring giver rather than a backer — just as valued, and building the launch fund with us.</div>
  <div class="fld"><label for="gc_monthly_name">Your name</label><input id="gc_monthly_name" autocomplete="name" placeholder="First and last name"></div>
  <div class="fld"><label for="gc_monthly_email">Email</label><input id="gc_monthly_email" type="email" autocomplete="email" placeholder="you@example.com"></div>
  <button type="submit" class="submitbtn" id="gc_monthly_submit">Back this territory</button>
  <div class="formerr" id="gc_monthly_err"></div>
  <div class="formok" id="gc_monthly_ok"></div>
</form>`;
}

// ── Interest + suggest-a-space (map + territory) ─────────────────────────────

const INTEREST_OPTIONS: ReadonlyArray<{ kind: string; label: string; hint: string }> = [
  { kind: "want_in_city", label: "I want this in my city", hint: "Tell us where." },
  {
    kind: "volunteer",
    label: "I'd love to volunteer",
    hint: "Worship, welcome, production, logistics.",
  },
  {
    kind: "join_team",
    label: "I want to be on the founding team",
    hint: "One of the five we train.",
  },
  {
    kind: "fund",
    label: "I want to help fund it",
    hint: "Back it, one-time, or sponsor.",
  },
  {
    kind: "suggest_space",
    label: "Suggest a space",
    hint: "A park, corner, or center where public worship should happen.",
  },
];

/** The "What comes next?" interest + suggest-a-space section. `interestStats`
 *  drives the live, PII-free count line; `territorySlug` is NOT baked into the
 *  markup — same pattern as the give forms above, the client script reads
 *  `window.__GIVE__.slug` (present only in `mode:"territory"`) and includes it
 *  as `territorySlug` in the POST body. */
export function interestSectionHtml(interestStats: {
  total: number;
  wantInCity: number;
}): string {
  const options = INTEREST_OPTIONS.map(
    (o) =>
      `<button type="button" class="interest-opt" data-kind="${esc(o.kind)}">
  <span class="io-label">${esc(o.label)}</span>
  <span class="io-hint">${esc(o.hint)}</span>
</button>`,
  ).join("\n");

  return `<section class="interestbox">
  <h2 class="sectionhead">What comes next?</h2>
  <p class="interest-count">${interestStats.wantInCity} ${interestStats.wantInCity === 1 ? "person wants" : "people want"} Public Worship in their city.</p>
  <div class="interest-opts">${options}</div>
  <form id="gi_form">
    <div class="fld" id="gi_location_fld" style="display:none">
      <label for="gi_location">Where (a city, or the space you have in mind)</label>
      <input id="gi_location" placeholder="e.g. Austin, TX — or a park name">
    </div>
    <div class="fld">
      <label for="gi_message">Anything else? (optional)</label>
      <textarea id="gi_message" rows="3" placeholder="Tell us more..."></textarea>
    </div>
    <div class="fld"><label for="gi_name">Your name</label><input id="gi_name" autocomplete="name" placeholder="First and last name"></div>
    <div class="fld"><label for="gi_email">Email</label><input id="gi_email" type="email" autocomplete="email" placeholder="you@example.com"></div>
    <button type="submit" class="submitbtn" id="gi_submit">Send</button>
    <div class="formerr" id="gi_err"></div>
    <div class="formok" id="gi_ok"></div>
  </form>
</section>`;
}

// ── "What your backing makes happen" — the three program cards ──────────────

const PROGRAM_CARDS: ReadonlyArray<{ emoji: string; title: string; body: string }> = [
  {
    emoji: "🌳",
    title: "Eden",
    body: "Eden brings people together for worship in a park — with free charcuterie, hand-made community gifts (last year, custom bouquets and warm blankets), and games that break the ice. Worship outside four walls: joyful, generous, rooted in the neighborhood.",
  },
  {
    emoji: "🎉",
    title: "Love Thy Neighbor",
    body: "Love Thy Neighbor is a block party or cookout with a full band and an experienced worship leader — food, music, and the energy of a whole neighborhood showing up. It's bigger, so it takes permits, logistics, staging, and a production team to land well — and it reaches people who might never step into a church.",
  },
  {
    emoji: "🙌",
    title: "Worship With Strangers",
    body: "Worship With Strangers is the monthly rhythm that holds every chapter — honest, open worship, the gospel preached, and real time to connect. Small enough to feel real, frequent enough to become family.",
  },
];

export function programCardsHtml(): string {
  const cards = PROGRAM_CARDS.map(
    (p) => `<div class="programcard">
  <div class="picon">${p.emoji}</div>
  <div class="ptitle">${esc(p.title)}</div>
  <div class="pbody">${esc(p.body)}</div>
</div>`,
  ).join("\n");
  return `<section>
  <h2 class="sectionhead">What your backing makes happen</h2>
  <div class="programgrid">${cards}</div>
</section>`;
}

// ── Active raises (map page's goal cards) ────────────────────────────────────

/** The map page's "raising right now" goal cards — derived from `territories`
 *  where `stage` is `"prospect"` or `"raising"` (no separate query). Falls
 *  back to a gentle prompt toward the interest section when nothing is
 *  actively raising. */
export function activeRaisesHtml(territories: readonly MapTerritory[]): string {
  const active = territories.filter(
    (t) => t.stage === "prospect" || t.stage === "raising",
  );
  if (active.length === 0) {
    return `<p class="raise-empty">We're praying over the next cities — tell us where below.</p>`;
  }
  const cards = active
    .map((t) => {
      const pct =
        t.targetBackers > 0
          ? Math.min(100, Math.round((t.backerCount / t.targetBackers) * 100))
          : 0;
      return `<a class="raisecard" href="${givePagePath(t.slug)}">
  <div class="rc-name">${esc(t.name)}, ${esc(t.region)}</div>
  <div class="rc-stat">${t.backerCount} of ${t.targetBackers} backers</div>
  <div class="raisetrack"><div class="raisefill" style="width:${pct}%"></div></div>
</a>`;
    })
    .join("\n");
  return `<div class="raisecards">${cards}</div>`;
}
