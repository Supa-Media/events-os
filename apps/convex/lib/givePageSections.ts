/**
 * Reusable HTML "widgets" shared by the public `/give` map page and `/give/
 * <slug>` territory page (`givePage.ts`) — the one-time give form, the
 * monthly/backer give form, the interest + suggest-a-space section, the
 * three static "what your backing makes happen" program cards, and (wave 2)
 * the deep money-transparency section, the launched-but-under-backed
 * "sustain" section, the public activity wall, and the "who we're looking
 * for" team-philosophy block. Split out of `givePage.ts` so the two
 * page-composition functions stay readable; every function here is a pure
 * string builder (no Convex access), matching the house pattern (`esc()` on
 * all interpolated dynamic text).
 *
 * Element ids are deliberately stable across both pages so ONE client script
 * (`givePageClient.ts`) can wire whichever forms happen to be present:
 *   - `gc_onetime_*` — the one-time gift form (map + territory).
 *   - `gc_monthly_*` — the monthly backer/recurring-giver form (territory only).
 *   - `gi_*`         — the interest / suggest-a-space form (map + territory).
 *     Both give forms also carry a shared `${prefix}_public_name` /
 *     `${prefix}_message` / `${prefix}_share` trio (F6 — "share this on the
 *     wall", see `giveFormExtrasHtml`) feeding the activity wall.
 */
import { escapeHtml as esc } from "./html";
import { givePagePath, rsvpPath } from "./siteUrl";
import {
  BACKER_UNIT_CENTS,
  CENTRAL_SKIM_PCT,
  CHAPTER_CORE_ROLES,
  formatCents,
  LAUNCH_EQUIPMENT_LINES,
  LAUNCH_TRAINING_TRIP_LINES,
  MONTHLY_OPERATING_LINES,
  PUBLIC_BACKER_TIERS,
  type MoneyLine,
} from "@events-os/shared";
import type {
  MapTerritory,
  PublicTerritoryData,
  TerritoryActivityEntry,
} from "./givePage";

// ── Share-on-the-wall extras (F6) ────────────────────────────────────────────

/** The optional "share this on the wall" fields shared by BOTH give forms
 *  (one-time + monthly): a self-provided public display name, an optional
 *  public message (capped 280 chars client-side via `maxlength`, and again
 *  server-side), and the opt-in checkbox. `givePageClient.ts`'s
 *  `wireAmountForm` only sends `publicName`/`message`/`shareOnWall` in the
 *  POST payload when the checkbox is checked — the backend only records a
 *  public activity-wall entry (F6, `givingActivity.recordPendingActivity`)
 *  when `shareOnWall` is set, so an unchecked box means nothing public is
 *  ever stored. */
function giveFormExtrasHtml(prefix: string): string {
  return `<div class="fld"><label for="${prefix}_public_name">Display name (optional)</label><input id="${prefix}_public_name" placeholder="e.g. Sam K. — shown on the wall if you share"></div>
  <div class="fld"><label for="${prefix}_message">Leave a public message (optional)</label><textarea id="${prefix}_message" rows="2" maxlength="280" placeholder="Say a word of encouragement..."></textarea></div>
  <label class="sharewall"><input type="checkbox" id="${prefix}_share"> Share this on the wall</label>`;
}

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
  ${giveFormExtrasHtml("gc_onetime")}
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
  ${giveFormExtrasHtml("gc_monthly")}
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

/** The founding-team role picker (join-team progressive reveal, below) — the
 *  5 core roles (single-sourced from `CHAPTER_CORE_ROLES` so this list can
 *  never drift from the "what your backing guarantees"/roles-table copy)
 *  plus two catch-alls for a team that grows past five. */
const JOIN_TEAM_ROLE_OPTIONS: readonly string[] = [
  ...CHAPTER_CORE_ROLES.map((r) => r.role),
  "Event Coordinator",
  "Wherever I'm needed",
];

/** The "What comes next?" interest + suggest-a-space section — MULTI-SELECT
 *  (F4): a person can check several interest options at once. `kinds` is
 *  collected client-side from the checked boxes and sent as `kinds: string[]`
 *  to `POST /api/give/interest`. Two fields progressively reveal:
 *   - the location field, when `want_in_city` or `suggest_space` is checked.
 *   - the founding-team block (role picker, skills, church, phone, social),
 *     when `join_team` is checked — at that point NAME, PHONE, EMAIL, and at
 *     least one ROLE become required (client-validated in
 *     `givePageClient.ts`); every other selection stays fully optional.
 *  `interestStats` drives the live, PII-free count line; `territorySlug` is
 *  NOT baked into the markup — same pattern as the give forms above, the
 *  client script reads `window.__GIVE__.slug` (present only in
 *  `mode:"territory"`) and includes it as `territorySlug` in the POST body. */
export function interestSectionHtml(interestStats: {
  total: number;
  wantInCity: number;
}): string {
  const options = INTEREST_OPTIONS.map(
    (o) =>
      `<label class="interest-opt">
  <input type="checkbox" name="gi_kind" value="${esc(o.kind)}">
  <span class="io-text"><span class="io-label">${esc(o.label)}</span><span class="io-hint">${esc(o.hint)}</span></span>
</label>`,
  ).join("\n");

  const roleOptions = JOIN_TEAM_ROLE_OPTIONS.map(
    (role) =>
      `<label class="role-opt"><input type="checkbox" name="gi_role" value="${esc(role)}"><span>${esc(role)}</span></label>`,
  ).join("\n");

  return `<section class="interestbox">
  <h2 class="sectionhead">What comes next?</h2>
  <p class="interest-count">${interestStats.wantInCity} ${interestStats.wantInCity === 1 ? "person wants" : "people want"} Public Worship in their city.</p>
  <p class="interest-hint">Choose as many as apply.</p>
  <div class="interest-opts">${options}</div>
  <form id="gi_form">
    <div class="fld" id="gi_location_fld" style="display:none">
      <label for="gi_location">Where (a city, or the space you have in mind)</label>
      <input id="gi_location" placeholder="e.g. Austin, TX — or a park name">
    </div>
    <div class="fld jointeam-fld" id="gi_jointeam_fld" style="display:none">
      <p class="jointeam-note">Want to join the founding team? We'll need your name, phone, and email (below), plus at least one role here.</p>
      <div class="fld">
        <label>Which role(s) interest you?</label>
        <div class="role-opts">${roleOptions}</div>
      </div>
      <div class="fld"><label for="gi_skills">What skills do you bring?</label><textarea id="gi_skills" rows="3" placeholder="Tell us about your experience..."></textarea></div>
      <div class="fld"><label for="gi_church">What church do you attend?</label><input id="gi_church" placeholder="Church name"></div>
      <div class="fld"><label for="gi_phone">Phone</label><input id="gi_phone" type="tel" autocomplete="tel" placeholder="(555) 555-5555"></div>
      <div class="fld"><label for="gi_social">Social media handle (optional)</label><input id="gi_social" placeholder="@yourhandle"></div>
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

// ── Money transparency (F2, both pages) ──────────────────────────────────────

/** Render a list of `MoneyLine`s as label/amount rows (used for both the
 *  monthly-operating and launch-fund breakdowns). */
function moneyLineRowsHtml(lines: readonly MoneyLine[]): string {
  return lines
    .map(
      (l) =>
        `<div class="mt-line"><span class="mt-line-label">${esc(l.label)}${l.note ? ` <span class="mt-line-note">— ${esc(l.note)}</span>` : ""}</span><span class="mt-line-amt">${esc(formatCents(l.amountCents, { showCents: false }))}</span></div>`,
    )
    .join("");
}

/** Sum a list of `MoneyLine`s' cents (never a hardcoded total — every total
 *  shown by `moneyTransparencyHtml` is derived from the shared constants). */
function sumMoneyLines(lines: readonly MoneyLine[]): number {
  return lines.reduce((total, l) => total + l.amountCents, 0);
}

/**
 * The deep "where your giving goes" transparency section (F2, both pages) —
 * every figure is derived from the shared finance constants
 * (`@events-os/shared`), never hardcoded, so the page can't drift from the
 * real City Launch Playbook model:
 *   - the backer tiers table (`PUBLIC_BACKER_TIERS`): backers → monthly →
 *     what's guaranteed.
 *   - the ~$670/mo monthly operating breakdown (`MONTHLY_OPERATING_LINES`).
 *   - the one-time City Launch Fund breakdown: the equipment "what we're
 *     buying" list (`LAUNCH_EQUIPMENT_LINES`) + the NYC training trip
 *     (`LAUNCH_TRAINING_TRIP_LINES`), totaling ~$8k.
 *   - the 85/15 split in dollars at the 20-backer tier.
 *   - the 5-person volunteer core-team roles table (`CHAPTER_CORE_ROLES`).
 *   - a brief "what counts as a backer" (non-team, headcount, anti-capture).
 * The two detail breakdowns are `<details>` so a long page stays scannable —
 * collapsed by default, no JS required.
 */
export function moneyTransparencyHtml(): string {
  const localPct = Math.round((1 - CENTRAL_SKIM_PCT) * 100);
  const skimPct = Math.round(CENTRAL_SKIM_PCT * 100);

  const tier20 =
    PUBLIC_BACKER_TIERS.find((t) => t.minBackers === 20) ?? PUBLIC_BACKER_TIERS[0];
  const monthlyAt20 = tier20.monthlyCents;
  const skimAt20 = Math.round(monthlyAt20 * CENTRAL_SKIM_PCT);
  const localAt20 = monthlyAt20 - skimAt20;

  const operatingTotal = sumMoneyLines(MONTHLY_OPERATING_LINES);
  const equipmentTotal = sumMoneyLines(LAUNCH_EQUIPMENT_LINES);
  const trainingTotal = sumMoneyLines(LAUNCH_TRAINING_TRIP_LINES);
  const launchTotal = equipmentTotal + trainingTotal;

  const tierRows = PUBLIC_BACKER_TIERS.map(
    (t) =>
      `<tr><td>${t.minBackers}</td><td>${esc(formatCents(t.monthlyCents, { showCents: false }))}/mo</td><td>${esc(t.commitment)}</td></tr>`,
  ).join("");

  const roleRows = CHAPTER_CORE_ROLES.map(
    (r) => `<tr><td>${esc(r.role)}</td><td>${esc(r.owns)}</td></tr>`,
  ).join("");

  return `<section class="moneybox">
  <h2 class="sectionhead">Where your giving goes</h2>
  <p class="lead">A 5-person volunteer core team runs each chapter's day-to-day. ${localPct}% of monthly backer revenue funds their work locally; ${skimPct}% flows to a City Launch Fund that trains and equips the next city.</p>

  <h3 class="mt-h3">What your backing guarantees</h3>
  <div class="mt-table-wrap"><table class="mt-table">
    <thead><tr><th>Backers</th><th>Monthly</th><th>Guarantees</th></tr></thead>
    <tbody>${tierRows}</tbody>
  </table></div>

  <details class="mt-detail">
    <summary>Monthly operating — ${esc(formatCents(operatingTotal, { showCents: false }))}/mo</summary>
    <div class="mt-lines">${moneyLineRowsHtml(MONTHLY_OPERATING_LINES)}</div>
    <div class="mt-total"><span>Total</span><span>${esc(formatCents(operatingTotal, { showCents: false }))}/mo</span></div>
  </details>

  <details class="mt-detail">
    <summary>One-time City Launch Fund — ~${esc(formatCents(launchTotal, { showCents: false }))}</summary>
    <div class="mt-sub">What we're buying</div>
    <div class="mt-lines">${moneyLineRowsHtml(LAUNCH_EQUIPMENT_LINES)}</div>
    <div class="mt-total"><span>Equipment</span><span>${esc(formatCents(equipmentTotal, { showCents: false }))}</span></div>
    <div class="mt-sub">NYC training trip</div>
    <div class="mt-lines">${moneyLineRowsHtml(LAUNCH_TRAINING_TRIP_LINES)}</div>
    <div class="mt-total"><span>Training trip</span><span>${esc(formatCents(trainingTotal, { showCents: false }))}</span></div>
    <div class="mt-total mt-total-grand"><span>Total</span><span>~${esc(formatCents(launchTotal, { showCents: false }))}</span></div>
  </details>

  <div class="mt-split">
    <div class="fact"><div class="k">${esc(formatCents(localAt20, { showCents: false }))}/mo</div><div class="v">stays with the local team at ${tier20.minBackers} backers (${localPct}%).</div></div>
    <div class="fact"><div class="k">${esc(formatCents(skimAt20, { showCents: false }))}/mo</div><div class="v">seeds the next city's launch fund (${skimPct}%).</div></div>
  </div>

  <h3 class="mt-h3">The 5-person volunteer core team</h3>
  <div class="mt-table-wrap"><table class="mt-table">
    <thead><tr><th>Role</th><th>Owns</th></tr></thead>
    <tbody>${roleRows}</tbody>
  </table></div>

  <p class="mt-backer-def">What counts as a backer: ${esc(formatCents(BACKER_UNIT_CENTS, { showCents: false }))}/mo, one headcount — the core team sits outside every count (no self-counting, no capture). One person is one backer, no matter how much more they give.</p>
</section>`;
}

// ── Sustain section (F3, territory page, launched-but-under-backed) ─────────

/**
 * The "not fully backed yet" sustain section — rendered by `givePage.ts` only
 * when a territory `stage === "launched"` AND `backerCount < targetBackers`
 * (this function assumes the caller already gated it, matching the house
 * pattern of `foundingCalloutHtml`). Covers one-time gifts, sponsorship
 * status, and any upcoming fundraiser events (linked via `rsvpPath`, with a
 * goal-progress bar reusing the map page's `.raisetrack`/`.raisefill`
 * classes) — with the message that fundraisers fund FREE worship events, but
 * the team would rather spend its time on worship than fundraising, which is
 * why consistent monthly backers matter most.
 */
export function sustainSectionHtml(data: PublicTerritoryData): string {
  const sponsorshipLine =
    data.sponsorshipCount > 0
      ? `${data.sponsorshipCount} active sponsorship${data.sponsorshipCount === 1 ? "" : "s"} help${data.sponsorshipCount === 1 ? "s" : ""} cover the gap right now.`
      : "We're exploring sponsorships for this chapter.";

  const fundraiserCards = data.upcomingFundraisers
    .map((f) => {
      const pct =
        f.goalCents > 0
          ? Math.min(100, Math.round((f.raisedCents / f.goalCents) * 100))
          : 0;
      return `<a class="fundraiser-card" href="${rsvpPath(f.slug)}">
  <div class="fc-name">${esc(f.name)}</div>
  <div class="fc-stat">${esc(formatCents(f.raisedCents, { showCents: false }))} of ${esc(formatCents(f.goalCents, { showCents: false }))} raised</div>
  <div class="raisetrack"><div class="raisefill" style="width:${pct}%"></div></div>
</a>`;
    })
    .join("\n");

  return `<section class="sustainbox">
  <h2 class="sectionhead">Not fully backed yet — here's how ${esc(data.name)} still delivers</h2>
  <p>${esc(data.name)} hasn't hit its backer goal yet, but the team is still bringing Worship With Strangers, Eden, and Love Thy Neighbor to the neighborhood. Fundraiser events exist to fund FREE worship gatherings — but the team would rather spend its time on worship than fundraising, which is exactly why consistent monthly backers matter most.</p>
  <div class="sustain-grid">
    <div class="sustain-item"><h3>One-time gifts</h3><p>Every one-time gift on this page goes straight into the local budget, closing the gap between backers and what it costs to run the team.</p></div>
    <div class="sustain-item"><h3>Sponsorships</h3><p>${sponsorshipLine}</p></div>
  </div>
  ${
    data.upcomingFundraisers.length > 0
      ? `<div class="fundraiser-cards">${fundraiserCards}</div>`
      : `<p class="fundraiser-empty">No fundraiser events scheduled right now.</p>`
  }
</section>`;
}

// ── Activity wall (F6, territory page) ───────────────────────────────────────

/** Coarse "N units ago" buckets for the activity wall — a public feed only
 *  needs a rough sense of recency, not a precise timestamp. */
const ACTIVITY_TIME_UNITS: ReadonlyArray<{ ms: number; label: string }> = [
  { ms: 365 * 24 * 60 * 60 * 1000, label: "year" },
  { ms: 30 * 24 * 60 * 60 * 1000, label: "month" },
  { ms: 7 * 24 * 60 * 60 * 1000, label: "week" },
  { ms: 24 * 60 * 60 * 1000, label: "day" },
  { ms: 60 * 60 * 1000, label: "hour" },
  { ms: 60 * 1000, label: "minute" },
];

/** A coarse, human "N units ago" label (falls back to "just now" under a
 *  minute) — good enough for a public activity feed, not a live-updating
 *  precise timestamp. `now` is a parameter (defaulting to `Date.now()`) so
 *  the render tests can pin it. */
function relativeTimeLabel(at: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - at);
  for (const unit of ACTIVITY_TIME_UNITS) {
    const n = Math.floor(diff / unit.ms);
    if (n >= 1) return `${n} ${unit.label}${n === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

/**
 * The public activity wall (F6, territory page): a feed of recurring backers
 * and one-time gifts, each opted-in via the give forms' "share this on the
 * wall" checkbox (`giveFormExtrasHtml`). Every entry required a real Stripe
 * payment (spam deterrent — see `givingActivity.recordPendingActivity`), and
 * this render is PII-free: `displayName` is the giver's own self-provided
 * public name, never an email. Falls back to a gentle prompt when the feed
 * is empty.
 */
export function activityWallHtml(
  activity: readonly TerritoryActivityEntry[],
): string {
  if (activity.length === 0) {
    return `<section class="activitywall">
  <h2 class="sectionhead">Backers &amp; gifts</h2>
  <p class="activity-empty">Be the first to back this city.</p>
</section>`;
  }
  const items = activity
    .map((a) => {
      const who = a.displayName?.trim() ? esc(a.displayName) : "A backer";
      const amt = esc(formatCents(a.amountCents, { showCents: false }));
      const suffix = a.kind === "backer" ? "/mo" : " one-time";
      return `<div class="activity-item">
  <div class="ai-line"><b>${who}</b> — ${amt}${suffix}</div>
  ${a.message ? `<div class="ai-msg">&ldquo;${esc(a.message)}&rdquo;</div>` : ""}
  <div class="ai-time">${esc(relativeTimeLabel(a.at))}</div>
</div>`;
    })
    .join("\n");
  return `<section class="activitywall">
  <h2 class="sectionhead">Backers &amp; gifts</h2>
  <div class="activity-list">${items}</div>
</section>`;
}

// ── Team philosophy (F7, both pages) ─────────────────────────────────────────

/**
 * The "who we're looking for" team-philosophy block (F7, both pages) — static
 * copy tied to the interest section's "I want to be on the founding team"
 * option, rendered just above/near it. No dynamic values, so no `esc()` is
 * needed (the house rule is escaping INTERPOLATED text; this template has
 * none).
 */
export function teamPhilosophyHtml(): string {
  return `<section class="teamphilo">
  <h2 class="sectionhead">Who we're looking for</h2>
  <p>Every Public Worship team — central and every chapter — is volunteer. We're looking for people who want real leadership experience and carry a genuine passion and heart for worship: people already committed to serving a local church community, who align with our statement of beliefs, and who understand sacrifice — already serving at their church and wanting to do more.</p>
  <p class="teamphilo-quote">Serving your church is your tithes and offerings; Public Worship is your sacrificial giving.</p>
  <p>We're looking for people willing to give sacrificially with their time. God has blessed Public Worship with more than enough candidates ready to answer the call, and it's central's duty to train them from the ground up so they have everything they need: resources, mentorship, discipleship, and custom in-house software that makes doing this well easier for everyone.</p>
  <p>Each position is a one-year term, with the option to renew for one more — long enough to pour in and build something real, with a natural moment to hand off the baton.</p>
</section>`;
}
