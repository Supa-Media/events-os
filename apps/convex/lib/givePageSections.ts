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
import { ledgerPath } from "./publicLedgerPage";
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

/** The optional public-giving-wall fields shared by BOTH give forms (one-time
 *  + monthly): the opt-in checkbox, then a self-provided public display name
 *  and an optional public message (capped 280 chars client-side via
 *  `maxlength`, and again server-side). `givePageClient.ts`'s `wireAmountForm`
 *  only sends `publicName`/`message`/`shareOnWall` in the POST payload when
 *  the checkbox is checked — the backend only records a public activity-wall
 *  entry (F6, `givingActivity.recordPendingActivity`) when `shareOnWall` is
 *  set, so an unchecked box means nothing public is ever stored.
 *
 *  DEFAULT UNCHECKED, and the label says the two things that actually become
 *  public — the name they type here AND the amount. The old copy ("Share this
 *  on the wall") never mentioned the amount, so a giver could tick it without
 *  realising their gift size would be on a page anyone can load. The consent
 *  question now comes FIRST, above the fields it governs: you agree, then you
 *  fill in what gets shown.
 *
 *  What is NEVER public, and the hint says so: their real name and email. The
 *  wall only ever renders `displayName` (see `activityWallHtml`). */
function giveFormExtrasHtml(prefix: string): string {
  return `<label class="sharewall"><input type="checkbox" id="${prefix}_share"> Show my name and gift amount on our public giving wall</label>
  <p class="sharewall-hint">Off by default. The name you enter below and the amount you give appear on this page, which anyone can see. Your real name and email address never do.</p>
  <div class="fld"><label for="${prefix}_public_name">Display name (optional)</label><input id="${prefix}_public_name" placeholder="e.g. Sam K. — shown on the wall if you share"></div>
  <div class="fld"><label for="${prefix}_message">Leave a public message (optional)</label><textarea id="${prefix}_message" rows="2" maxlength="280" placeholder="Say a word of encouragement..."></textarea></div>`;
}

// ── Payment-method expectation (ACH) ─────────────────────────────────────────

/**
 * The one thing a giver needs to know before they land on Stripe Checkout and
 * see "US bank account" sitting next to "Card": a bank transfer is not
 * instant.
 *
 * ACH takes about 2–4 business days to clear and can fail after the fact, so
 * someone who picks it and then sees nothing happen has every reason to think
 * the gift didn't work. Two sentences here save that confusion; the full
 * story arrives by email (`givingComms.ts`) at each step.
 *
 * Deliberately placed under the submit button rather than as a banner — the
 * actual choice happens on Stripe's page, and this is the last thing they read
 * before going there. Kept to one line: it is a footnote, not a warning.
 *
 * MONTHLY ONLY, now. The one-time form asks the question outright
 * (`payMethodPickerHtml`) instead of previewing a choice that happens later.
 */
function payMethodNoteHtml(): string {
  return `<p class="paynote">You can give by card or bank transfer. Bank transfers take about 2&ndash;4 business days to clear &mdash; we'll email you either way.</p>`;
}

/**
 * "How do you plan to pay?" — asked HERE, so the fee can be quoted at the
 * right rate.
 *
 * WHY THE FORM ASKS A QUESTION STRIPE WILL ASK AGAIN. Stripe Checkout needs the
 * amount when the session is created and doesn't say which rail the donor
 * picked until after that, so "cover the fee" is always a forecast. This page
 * used to forecast card — the expensive rail — for everybody, and a donor
 * giving $300 by bank was charged $9.27 to cover a fee that turned out to be
 * $2.47 (#732). On a $5,000 gift the same guess is $149.64 against ACH's $5.00
 * cap. Asking is simply the cheapest way to make the forecast a good one.
 *
 * IT DOES NOT BIND THEM, and the copy says so. The checkout still offers every
 * rail, and the gift is booked at whatever was actually charged — so answering
 * this wrong costs a few dollars of precision on the coverage and nothing else.
 * An earlier draft pinned `payment_method_types` to the answer; that bought
 * nothing once the gift became the charge, and cost Link, which is its own
 * Stripe payment-method type rather than a flavour of card and disappears the
 * moment `payment_method_types` is named at all.
 *
 * CARD IS PRESELECTED, because it is what most people use and because a
 * preselection that costs MORE cannot be a dark pattern. The rate under each
 * option is filled in live by the client script from the real schedule, so the
 * cheaper rail argues for itself rather than being editorialised at.
 */
function payMethodPickerHtml(prefix: string): string {
  return `<fieldset class="paypick" id="${prefix}_paypick">
  <legend>How do you plan to pay?</legend>
  <label class="payopt sel"><input type="radio" name="${prefix}_method" value="card" checked>
    <span class="payopt-name">Card</span><span class="payopt-rate" id="${prefix}_rate_card"></span></label>
  <label class="payopt"><input type="radio" name="${prefix}_method" value="ach_debit">
    <span class="payopt-name">Bank transfer</span><span class="payopt-rate" id="${prefix}_rate_ach"></span></label>
  <p class="sharewall-hint">Just so we can work out the fee below &mdash; you can still pay whichever way you like at checkout.</p>
</fieldset>`;
}

// ── Cover the processing fees ────────────────────────────────────────────────

/**
 * "Add the processing fee so all of it gets through."
 *
 * THE COPY SAYS WHAT WE RECEIVE, not how generous ticking it is. A donor
 * deciding whether to add $3.30 to a $100 gift needs one fact — that without
 * it the card company takes a cut and we get $96.80 — and nothing about
 * "maximising your impact". The line under it is filled in live by the client
 * script from the real rate, so the number they read is the number they are
 * charged; and it stays honest when the box is UNticked too ("adds $3.30, so
 * the full $100 reaches us") rather than only appearing once they've agreed.
 *
 * OFF BY DEFAULT, like the wall opt-in above it. A pre-ticked box that quietly
 * adds money to a total is a dark pattern, and it would poison a gift.
 *
 * ONE-TIME ONLY, deliberately. The monthly form opens a Stripe SUBSCRIPTION
 * through `givingPledges`, where "the fee" is a recurring charge on a schedule
 * that can be re-priced — a different question with a different answer, and
 * guessing at it here would ship a number nobody had checked.
 */
function coverFeesHtml(prefix: string): string {
  return `<label class="sharewall"><input type="checkbox" id="${prefix}_covfees"> Cover the processing fee so my whole gift gets through</label>
  <p class="sharewall-hint">Whichever way you pay, the processor takes a cut of every gift. Tick this and it's added to your total instead of coming out of what you gave &mdash; priced for the method you picked above. Completely optional &mdash; your gift is welcome either way.</p>
  <p class="covline" id="${prefix}_covline" style="display:none"></p>`;
}

// ── One-time give form ───────────────────────────────────────────────────────

/** The one-time gift form's fields (amount presets + custom + name/email +
 *  submit). Callers wrap this in whatever container (a standalone card on the
 *  map page, a tab panel on the territory page) suits the surrounding layout.
 *  `slug` is NOT baked in here — the client script reads it off
 *  `window.__GIVE__.slug`, which is `null` on the map page (⇒ a central gift)
 *  and the territory's slug on a territory page.
 *
 *  `showWallOptIn` (default `true`) controls whether the public-giving-wall
 *  consent block renders. The MAP page passes `false`: the wall is
 *  per-territory, so a central (no-slug) gift has no wall to appear on and
 *  `startGiveDonationCheckout` discards `shareOnWall` for it outright. Showing
 *  the box there asked people to agree to something that then silently never
 *  happened — harmless in that nothing was published, but it is not honest to
 *  ask a consent question whose answer you intend to throw away. */
export function oneTimeGiveFormHtml(opts: {
  presetsCents: readonly number[];
  defaultIndex: number;
  submitLabel: string;
  showWallOptIn?: boolean;
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
  ${payMethodPickerHtml("gc_onetime")}
  <div class="achnote" id="gc_onetime_achnote" style="display:none"></div>
  ${coverFeesHtml("gc_onetime")}
  <div class="fld"><label for="gc_onetime_name">Your name</label><input id="gc_onetime_name" autocomplete="name" placeholder="First and last name"></div>
  <div class="fld"><label for="gc_onetime_email">Email</label><input id="gc_onetime_email" type="email" autocomplete="email" placeholder="you@example.com"></div>
  ${opts.showWallOptIn === false ? "" : giveFormExtrasHtml("gc_onetime")}
  <button type="submit" class="submitbtn" id="gc_onetime_submit">${esc(opts.submitLabel)}</button>
  <p class="paynote" id="gc_onetime_paynote"></p>
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
  <button type="submit" class="submitbtn" id="gc_monthly_submit">Back this city</button>
  ${payMethodNoteHtml()}
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

/**
 * The three programs, exported because they are no longer a section of their
 * own (v3, docs/plans/give-redesign-v3.md).
 *
 * They were always the SAME THREE THINGS as the milestone ladder — 20 backers
 * guarantees Worship With Strangers, 30 adds Eden, 50 adds Love Thy Neighbor —
 * rendered as a second grid directly below the ladder, saying it again with
 * less detail. `milestoneLadderHtml` now looks a rung's commitment up in here
 * (see `programForCommitment`) so the promise and the evidence sit together on
 * one rung, and the standalone grid is gone.
 */
export const PROGRAM_CARDS: ReadonlyArray<{
  emoji: string;
  title: string;
  body: string;
  instagramUrl?: string;
}> = [
  {
    emoji: "🌳",
    title: "Eden",
    body: "Eden brings people together for worship in a park — with free charcuterie, hand-made community gifts (last year, custom bouquets and warm blankets), and games that break the ice. Worship outside four walls: joyful, generous, rooted in the neighborhood.",
    instagramUrl: "https://www.instagram.com/p/DZGYzsXFhCi/",
  },
  {
    emoji: "🎉",
    title: "Love Thy Neighbor",
    body: "Love Thy Neighbor is a block party or cookout with a full band and an experienced worship leader — food, music, and the energy of a whole neighborhood showing up. It's bigger, so it takes permits, logistics, staging, and a production team to land well — and it reaches people who might never step into a church.",
    instagramUrl: "https://www.instagram.com/p/DO62pchjvAZ/",
  },
  {
    emoji: "🙌",
    title: "Worship With Strangers",
    body: "Worship With Strangers is the monthly rhythm that holds every chapter — honest, open worship, the gospel preached, and real time to connect. Small enough to feel real, frequent enough to become family.",
    instagramUrl: "https://www.instagram.com/p/DUrTvH6jvRh/",
  },
];

/**
 * The program whose name appears in a milestone's `commitment` string, or
 * `null`. Matched by substring because the commitment is editorial copy
 * ("+ Eden, the annual worship-and-picnic gathering") that names the program
 * inside a sentence, and because milestones are STORED (`backerMilestones`) —
 * a chapter can word its own rung, so an exact-equality lookup would silently
 * stop matching the moment someone edited the copy. A miss is harmless: the
 * rung renders without a blurb, exactly as it did before v3.
 */
export function programForCommitment(
  commitment: string,
): (typeof PROGRAM_CARDS)[number] | null {
  const hay = commitment.toLowerCase();
  return PROGRAM_CARDS.find((p) => hay.includes(p.title.toLowerCase())) ?? null;
}

// ── Active raises (map page's goal cards) ────────────────────────────────────


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


// ── Sustain section (F3, territory page, launched-but-under-backed) ─────────


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
// ── v3 (docs/plans/give-redesign-v3.md) ──────────────────────────────────────

/** One row of the public wall, as `api.givingActivity.getPublicWall` returns
 *  it (spec §C1). PII-free by construction: `displayName` is a self-provided
 *  public handle the giver consented to, never a CRM name or an email. */
export type PublicWallRow = {
  kind: "backer" | "gift" | "fundraiser" | "central";
  amountCents: number;
  at: number;
  scopeLabel: string | null;
  scopeSlug: string | null;
  displayName: string | null;
  message: string | null;
  goal: { label: string; raisedCents: number; targetCents: number } | null;
};

export type PublicWallData = {
  totals: {
    raisedCents: number;
    giftCount: number;
    giverCount: number;
    backerCount: number;
    cityCount: number;
  };
  rows: readonly PublicWallRow[];
};

/**
 * The public giving wall — "every gift, in public."
 *
 * WHAT CHANGED IN v3, and why it is a rebuild rather than a move. The old
 * `activityWallHtml` rendered only rows whose giver ticked the share box AND
 * typed a display name or message, so a city with real backers could still
 * render "Be the first to back this city" — the worst possible sentence on the
 * page that is trying to prove the city is alive. Now every settled gift has a
 * row and consent gates only ATTRIBUTION (spec D6): an unconsented gift is
 * "A gift to New York — $50", which discloses exactly what the published
 * ledger's gift roll already discloses monthly, only live.
 *
 * The total is LIVE, deliberately (spec D8) — a giver has to be able to give
 * and watch the number move. "Published month by month" is the books' promise
 * and belongs on `/finances`, not here; the footer says which is which so the
 * two numbers disagreeing is never a surprise.
 *
 * Times stay coarse (`relativeTimeLabel`'s buckets). A precise timestamp beside
 * an amount and a city is a re-identification vector while volume is low, which
 * matters more now than it will later.
 */
export function givingWallHtml(
  wall: PublicWallData,
  scope: { kind: "org" } | { kind: "city"; name: string },
): string {
  const isCity = scope.kind === "city";
  const heading = isCity
    ? `Backers &amp; gifts in ${esc(scope.name)}`
    : "Every gift, in public";

  if (wall.rows.length === 0) {
    return `<section>
  <h2 class="sectionhead">${heading}</h2>
  <div class="wallbox">
    <div class="wallfoot">${
      isCity
        ? `${esc(scope.name)}'s first gifts will show up here the moment they arrive.`
        : "The first gifts will show up here the moment they arrive."
    }</div>
  </div>
</section>`;
  }

  const headline = isCity
    ? `${wall.totals.backerCount} backer${wall.totals.backerCount === 1 ? "" : "s"}`
    : esc(formatCents(wall.totals.raisedCents, { showCents: false }));
  const subline = isCity
    ? `plus ${wall.totals.giftCount} gift${wall.totals.giftCount === 1 ? "" : "s"} to this chapter`
    : `given toward the mission, from ${wall.totals.giverCount} ${
        wall.totals.giverCount === 1 ? "person" : "people"
      }`;

  const rows = wall.rows.map((r) => walletRowHtml(r, isCity)).join("\n");

  return `<section>
  <h2 class="sectionhead">${heading}</h2>
  <div class="wallbox">
    <div class="wallhead">
      <div>
        <div class="wh-k">${headline}</div>
        <div class="wh-v">${subline}</div>
      </div>
      <span class="livepill"><span class="blip"></span> LIVE</span>
    </div>
    ${rows}
    <div class="wallfoot">Every settled gift appears here. Amounts and cities, never names &mdash; unless a giver chooses to sign theirs. Real names and email addresses are never published. These totals are live; <a href="${esc(ledgerPath())}">the books</a> are published month by month.</div>
  </div>
</section>`;
}

/** One wall row. `isCity` drops the redundant city label on a city page —
 *  every row there is already that city's. */
function walletRowHtml(r: PublicWallRow, isCity: boolean): string {
  const amount = esc(formatCents(r.amountCents, { showCents: false }));
  const who = r.displayName?.trim() ? `<b>${esc(r.displayName)}</b>` : null;
  const where =
    !isCity && r.scopeLabel
      ? ` <span class="wr-city">${esc(r.scopeLabel)}</span>`
      : "";

  // The verb differs by kind, so the row reads as a sentence rather than a
  // record. An unattributed row starts with the action, not with "Anonymous" —
  // naming the absence of a name draws attention to it.
  let line: string;
  let tag: string;
  let avatar: string;
  switch (r.kind) {
    case "backer":
      avatar = "🌱";
      tag = `<span class="wr-tag mo">monthly</span>`;
      line = who
        ? `${who} started backing${where} &mdash; <span class="wr-amt">${amount}</span>`
        : `Someone started backing${where} &mdash; <span class="wr-amt">${amount}</span>`;
      break;
    case "fundraiser":
      avatar = "🎪";
      tag = `<span class="wr-tag once">fundraiser</span>`;
      line = who
        ? `${who} gave toward ${esc(r.goal?.label ?? "a fundraiser")} &mdash; <span class="wr-amt">${amount}</span>`
        : `A gift toward ${esc(r.goal?.label ?? "a fundraiser")} &mdash; <span class="wr-amt">${amount}</span>`;
      break;
    case "central":
      avatar = "🎁";
      tag = `<span class="wr-tag central">central</span>`;
      line = who
        ? `${who} gave to <span class="wr-city">central operations</span> &mdash; <span class="wr-amt">${amount}</span>`
        : `A gift to <span class="wr-city">central operations</span> &mdash; <span class="wr-amt">${amount}</span>`;
      break;
    default:
      avatar = "🎁";
      tag = `<span class="wr-tag once">one-time</span>`;
      line = who
        ? `${who} gave${where} &mdash; <span class="wr-amt">${amount}</span>`
        : `A gift${where} &mdash; <span class="wr-amt">${amount}</span>`;
  }

  // A fundraiser row carries that fundraiser's live goal bar, so the giver sees
  // the gift AND the progress it just caused — the founder's "moving us closer
  // to our goal."
  const goalBar =
    r.goal && r.goal.targetCents > 0
      ? `<div class="wr-goal">
    <div class="wg-track"><div class="wg-fill" style="width:${Math.min(100, Math.round((r.goal.raisedCents / r.goal.targetCents) * 100))}%"></div></div>
    <div class="wg-lbl"><b>${esc(formatCents(r.goal.raisedCents, { showCents: false }))}</b> of ${esc(formatCents(r.goal.targetCents, { showCents: false }))}</div>
  </div>`
      : "";

  return `<div class="wallrow${r.kind === "backer" ? " backer" : ""}">
  <div class="wr-av">${avatar}</div>
  <div class="wr-body">
    <div class="wr-line">${line}${tag}</div>
    ${r.message ? `<div class="wr-msg">&ldquo;${esc(r.message)}&rdquo;</div>` : ""}
    ${goalBar}
    <div class="wr-time">${esc(relativeTimeLabel(r.at))}</div>
  </div>
</div>`;
}

/**
 * The four-number proof strip under the hero. Every figure is auditable and
 * comes from a real query — no "impact" adjectives, no number we cannot show
 * the working for. The last cell is the differentiator and links straight to
 * the receipts.
 *
 * Deliberately does NOT repeat the wall's dollar total: the strip establishes
 * that the thing is real, the wall carries the money. Saying the same number
 * twice on one screen reads as anxiety rather than emphasis.
 */
export function proofStripHtml(totals: PublicWallData["totals"]): string {
  const cell = (k: string, v: string) =>
    `<div class="proofcell"><div class="pk">${k}</div><div class="pv">${v}</div></div>`;
  return `<div class="proofstrip">
  ${cell(String(totals.backerCount), "monthly backers<br>funding city teams")}
  ${cell(String(totals.giverCount), "people have given<br>at least once")}
  ${cell(String(totals.cityCount), `${totals.cityCount === 1 ? "city" : "cities"} taking<br>backers right now`)}
  ${cell("100%", `of our spending is public &mdash;<br><a href="${esc(ledgerPath())}">every line item &rarr;</a>`)}
</div>`;
}

/**
 * The city cards — the hero module, and the page's actual conversion (spec §
 * "Page composition"). Replaces BOTH `activeRaisesHtml` ("Raising right now")
 * and the `.citylist` "Every territory" rows, which were two lists of the same
 * territories stacked on top of each other, splitting attention and halving
 * the urgency of each.
 *
 * Every card shows the GAP, not just the total: "2 more backers guarantee
 * Worship With Strangers" is a closable ask in a way "18 of 20" is not. The
 * prospect card at the end is the interest-capture doorway — the founder's
 * "tell us where you are, ask for a chapter here."
 */
export function cityCardsHtml(
  territories: readonly MapTerritory[],
  nextCommitments: Readonly<
    Record<string, { remaining: number; commitment: string }>
  > = {},
): string {
  // Launched and raising cities are backable today; a prospect has no chapter
  // to fund yet, so it belongs in the "ask for one" card rather than the grid.
  const backable = territories.filter((t) => t.stage !== "prospect");
  const cards = backable
    .map((t) => {
      const pct =
        t.targetBackers > 0
          ? Math.min(100, Math.round((t.backerCount / t.targetBackers) * 100))
          : 0;
      // The GAP, not the total — "2 more backers guarantee Worship With
      // Strangers" is a closable ask in a way "18 of 20" is not.
      //
      // `nextCommitments` lets a caller pass a city's OWN stored milestone copy
      // (`backerMilestones`, which a chapter can word itself). The map query
      // returns counts only, so the fallback derives the rung from the shared
      // `PUBLIC_BACKER_TIERS` — the same ladder the city page and
      // `/give/how-it-works` render, so the two can't disagree.
      const next = nextCommitments[t.slug] ?? nextTierFor(t.backerCount);
      const nextLine = next
        ? `<div class="cc-next"><b>${next.remaining} more backer${next.remaining === 1 ? "" : "s"}</b> guarantee${next.remaining === 1 ? "s" : ""} ${esc(next.commitment)}.</div>`
        : `<div class="cc-next">Every backer here funds the team that shows up on the corner.</div>`;
      return `<a class="citycard${t.stage === "launched" ? " flagship" : ""}" href="${givePagePath(t.slug)}">
  <div class="cc-top">
    <div><div class="cc-name">${esc(t.name)}</div><div class="cc-region">${esc(t.region)}</div></div>
    ${stageChipHtml(t.stage)}
  </div>
  <div class="cc-count"><b>${t.backerCount}</b> of ${t.targetBackers} backers</div>
  <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
  ${nextLine}
  <span class="cc-cta">Back ${esc(t.name)} &mdash; ${esc(formatCents(BACKER_UNIT_CENTS, { showCents: false }))}/mo</span>
</a>`;
    })
    .join("\n");

  const prospectCard = `<a class="citycard prospectcard" href="#gi_form">
  <div class="cc-top">
    <div><div class="cc-name">Your city</div><div class="cc-region">Not on the map yet</div></div>
    <span class="chip prospect">Prospect</span>
  </div>
  <div class="cc-body">Tell us where you are. When enough people in one place raise their hand, we plan a launch there together.</div>
  <span class="cc-cta">Ask for a chapter here</span>
</a>`;

  return `<section>
  <h2 class="sectionhead">Back a city</h2>
  <div class="citygrid">
    ${cards}
    ${prospectCard}
  </div>
</section>`;
}

/** The first `PUBLIC_BACKER_TIERS` rung above `backerCount`, as a gap + the
 *  thing that rung guarantees — or `null` once a city is past the top rung
 *  (there is no honest "next" to name, so the card says something else). */
function nextTierFor(
  backerCount: number,
): { remaining: number; commitment: string } | null {
  const rung = [...PUBLIC_BACKER_TIERS]
    .sort((a, b) => a.minBackers - b.minBackers)
    .find((t) => t.minBackers > backerCount);
  return rung
    ? { remaining: rung.minBackers - backerCount, commitment: rung.commitment }
    : null;
}

/** The stage chip, duplicated from `givePage.ts`'s private helper so the card
 *  builder doesn't need to import back out of the page module (which imports
 *  this one — a cycle). */
function stageChipHtml(stage: "prospect" | "raising" | "launched"): string {
  const label =
    stage === "launched" ? "Launched" : stage === "raising" ? "Raising" : "Prospect";
  return `<span class="chip ${stage}">${label}</span>`;
}

/**
 * A chapter's fundraisers — open AND finished, all of them still giveable
 * (spec D9).
 *
 * WHY FINISHED ONES STAY. `getPublicTerritory` used to return only future
 * fundraisers, so the moment an event happened it vanished from the page. That
 * throws away the single best evidence a chapter is real — "we did Pathway
 * Ball, we did the block party, here is what it raised" — and it also closes a
 * door nobody asked to close: a finished fundraiser with a goal is still
 * something a person can put money toward, and it all lands in the same pot.
 * A met goal turns the bar green rather than hiding the card.
 */
export function fundraisersHtml(
  fundraisers: readonly {
    name: string;
    slug: string;
    goalCents: number;
    raisedCents: number;
    startDate: number;
    state: "open" | "finished";
    goalMet: boolean;
  }[],
  cityName: string,
): string {
  if (fundraisers.length === 0) return "";
  const cards = fundraisers
    .map((f) => {
      const pct =
        f.goalCents > 0
          ? Math.min(100, Math.round((f.raisedCents / f.goalCents) * 100))
          : 0;
      const finished = f.state === "finished";
      const chip = f.goalMet
        ? `<span class="fc-chip done">Goal met</span>`
        : finished
          ? `<span class="fc-chip done">Finished</span>`
          : `<span class="fc-chip live">Open</span>`;
      return `<div class="fundcard${finished ? " past" : ""}">
  <div class="fc-top">
    <div class="fc-name">${esc(f.name)}</div>
    ${chip}
  </div>
  <div class="fc-when">${esc(fundraiserDateLabel(f.startDate))}${finished ? " &middot; finished" : ""}</div>
  <div class="fc-track"><div class="fc-fill${f.goalMet ? " met" : ""}" style="width:${pct}%"></div></div>
  <div class="fc-lbl"><b${f.goalMet ? ` class="met"` : ""}>${esc(formatCents(f.raisedCents, { showCents: false }))}</b> of ${esc(formatCents(f.goalCents, { showCents: false }))}</div>
  <div class="fc-body"></div>
  <a class="fc-cta" href="${rsvpPath(f.slug)}">Give toward this</a>
</div>`;
    })
    .join("\n");
  return `<section>
  <h2 class="sectionhead">Fundraisers in ${esc(cityName)}</h2>
  <div class="fundgrid">${cards}</div>
</section>`;
}

const FUNDRAISER_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "September 14" — deliberately no year and no time. The card says whether it
 *  is open or finished; an exact timestamp adds nothing and dates a page. */
function fundraiserDateLabel(at: number): string {
  const d = new Date(at);
  return `${FUNDRAISER_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/**
 * "Where the money goes," as three facts and two links.
 *
 * This REPLACES `moneyTransparencyHtml`, which rendered a tier table, two
 * expandable expense breakdowns, a percentage split and a five-role table —
 * roughly 450 words and two tables — inline on BOTH give pages, and stated the
 * 85/15 split four separate times on `/give` alone. The full content now lives
 * at `/give/how-it-works`; the receipts live at `/finances`, which neither give
 * page linked to at all before v3.
 *
 * The sharpest sentence the org has is the one about its own mistakes, so it
 * goes here rather than three sections deep in a page nobody scrolls: an org
 * that volunteers its own bad rows is making a claim nobody can fake.
 *
 * NO COMPENSATION CLAIM (spec D3) — deliberately. It is not a flex, and it
 * would become false the day it changes.
 */
export function moneyTeaserHtml(publishedMonths: number): string {
  const localPct = Math.round((1 - CENTRAL_SKIM_PCT) * 100);
  const skimPct = Math.round(CENTRAL_SKIM_PCT * 100);
  const operating = sumMoneyLines(MONTHLY_OPERATING_LINES);
  const monthsLine =
    publishedMonths > 0
      ? `${publishedMonths} month${publishedMonths === 1 ? "" : "s"}`
      : "Every month";
  return `<section>
  <div class="moneyteaser">
    <h2>Where the money goes</h2>
    <p class="mt-lead">We publish our books. Not a summary, not a pie chart &mdash; <span class="sharp">every line item, every month</span>: what we spent, who we paid, and what it was for.</p>
    <p class="mt-lead">That includes the ones that make us look bad. <span class="sharp">If a volunteer accidentally puts a personal charge on the wrong card, it's in there, labelled as exactly that.</span> We publish the rows we can't produce a receipt for, and mark them. We'd rather you find it in our own books than anywhere else.</p>
    <div class="mt-facts">
      <div class="fact"><div class="k">${localPct} / ${skimPct}</div><div class="v">${localPct}% of a backer's gift stays with their local chapter. ${skimPct}% funds the next city's launch.</div></div>
      <div class="fact"><div class="k">${esc(formatCents(operating, { showCents: false }))}<span style="font-size:15px">/mo</span></div><div class="v">Runs a whole chapter &mdash; film, food, transport, storage, software.</div></div>
      <div class="fact"><div class="k">${monthsLine}</div><div class="v">published so far, down to the transaction. Nothing redacted, nothing rounded.</div></div>
    </div>
    <div class="mt-links">
      <a class="ctabtn primary" href="${esc(ledgerPath())}">Read the books &rarr;</a>
      <a class="ctabtn secondary" href="${givePagePath()}/how-it-works">How the money model works</a>
    </div>
  </div>
</section>`;
}

/** The `/finances` doorway on a city page — one card replacing the ~200 lines
 *  of finance tables that used to be inlined here. */
export function bookLinkHtml(cityName: string): string {
  return `<div class="booklink">
  <div class="bl-ic">📗</div>
  <div>
    <div class="bl-t">${esc(cityName)}'s book is public</div>
    <div class="bl-s">Every transaction this chapter has made, month by month, down to the line item. <a href="${esc(ledgerPath())}">Read it &rarr;</a></div>
  </div>
</div>`;
}


// ── Team philosophy (F7, both pages) ─────────────────────────────────────────

