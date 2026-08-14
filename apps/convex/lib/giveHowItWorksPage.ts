/**
 * `/give/how-it-works` — "Where the money goes."
 *
 * ── WHY THIS PAGE EXISTS ─────────────────────────────────────────────────────
 * Both public giving pages used to carry a full finance report inline
 * (`givePageSections.ts`'s `moneyTransparencyHtml` + `teamPhilosophyHtml`):
 * a tier table, two collapsed cost breakdowns, the 85/15 split, a roles table
 * and four paragraphs about who we recruit — roughly 450 words of model sitting
 * between a giver and the thing they came to do. The v3 redesign
 * (docs/plans/give-redesign-v3.md, decision **D5**) moves the whole money model
 * off `/give` and onto its own page: `/give` keeps three facts and a link, and
 * everything a person could actually want to audit lives here, in one place, at
 * whatever length it needs.
 *
 * That split is also what makes the page honest to link to. A giver who wants
 * the pitch gets the pitch; a giver who wants the arithmetic gets ALL of the
 * arithmetic rather than the three numbers that happened to fit above a form.
 *
 * ── THE MODEL IS A PLAN; THE BOOKS ARE WHAT HAPPENED ─────────────────────────
 * Everything on this page is a MODEL — what a chapter is designed to cost, what
 * a backer's $50 is designed to buy, what we budget to start a city. None of it
 * is evidence. The evidence is `/finances` (`publicLedgerPage.ts`), where every
 * transaction is published month by month, including the rows we cannot produce
 * a receipt for, marked as such. The closing section says exactly that and hands
 * the reader over; it also links back to `/give`, so this page is a loop rather
 * than a dead end. A transparency page you can only leave by hitting Back is a
 * transparency page that costs the org a gift.
 *
 * ── EVERY FIGURE IS SINGLE-SOURCED ───────────────────────────────────────────
 * Not one dollar amount is typed into this file. The monthly operating floor,
 * the tier ladder, the launch budget, the 85/15 split and the five core roles
 * all come from `packages/shared/src/finance.ts` — the same constants the
 * internal affordability math reads — so the public page cannot drift from the
 * real City Launch Playbook model without the model itself changing. Where a
 * total is shown it is SUMMED here (`sumMoneyLines`, `launchTemplateTotalCents`)
 * rather than restated, which is why the tests can derive their expectations
 * from the same constants instead of asserting a literal that would only prove
 * the literal matches itself.
 *
 * ── D3: NO COMPENSATION CLAIM, ANYWHERE ──────────────────────────────────────
 * The relocated copy is NOT a verbatim move. `moneyTransparencyHtml` said "A
 * 5-person volunteer core team…" and `teamPhilosophyHtml` opened with "Every
 * Public Worship team — central and every chapter — is volunteer." Both are
 * dropped here on purpose (spec **D3**, founder): it is not a flex, and it
 * becomes false the day one person is paid — at which point the claim is
 * sitting on a public page with a search index pointed at it. So this page
 * describes the roles, the term, and what the money buys, and says nothing at
 * all about what anybody is or isn't paid. `giveHowItWorksPage.test.ts` asserts
 * the absence with a regex so the claim cannot creep back in via a copy edit.
 *
 * ── HOUSE MECHANICS ──────────────────────────────────────────────────────────
 * Pure string builder, no Convex access, same shell as `renderGiveMapPage`:
 * `BASE_CSS + GIVE_CSS` inline, `FAVICON`/`FONTS`, OG tags, no external assets.
 * It adds NO CSS of its own — every class used here (`.sectionhead`, `.fact`,
 * `.mt-*`, `.ladder`/`.rung`, `.moneyteaser`, `.booklink`, `.ctabtn`,
 * `.give-topbar`/`.wordmark`, `.give-topnav`/`.give-navlink`) already exists in
 * `givePageStyles.ts`. Unlike `/give/<slug>` this page is INDEXABLE: it
 * publishes a model, never a donor, so `ogHead` deliberately omits `noindex`
 * (see `givePage.ts`'s `ogHead` doc for why that distinction is drawn per-page).
 */
import { BASE_CSS, FAVICON, FONTS } from "./landingPageStyles";
import { GIVE_CSS } from "./givePageStyles";
import { escapeHtml as esc } from "./html";
import { givePagePath } from "./siteUrl";
import { ledgerPath } from "./publicLedgerPage";
import {
  BACKER_UNIT_CENTS,
  CENTRAL_SKIM_PCT,
  CHAPTER_CORE_ROLES,
  formatCents,
  LAUNCH_BUDGET_TEMPLATE,
  LAUNCH_EQUIPMENT_LINES,
  LAUNCH_TRAINING_TRIP_LINES,
  launchTemplateTotalCents,
  MONTHLY_OPERATING_LINES,
  PUBLIC_BACKER_TIERS,
  type MoneyLine,
} from "@events-os/shared";

/**
 * The page's slug under `/give/`. `http.ts` routes `/give/<segment>` as a
 * TERRITORY slug, so this string has to be reserved in
 * `territories.saveTerritory` alongside the uniqueness check or a chapter
 * called "how-it-works" would shadow this page (spec §C4). Exported so the
 * route and the reserved-slug list can both read it from one place rather than
 * each spelling it out.
 */
export const GIVE_HOW_IT_WORKS_SLUG = "how-it-works";

/** Relative path of this page — `/give/how-it-works`. Built through
 *  `givePagePath` so it can never disagree with the rest of the give tree. */
export function giveHowItWorksPath(): string {
  return givePagePath(GIVE_HOW_IT_WORKS_SLUG);
}

// ── Money-line helpers ───────────────────────────────────────────────────────
// Deliberate duplicates of `givePageSections.ts`'s private helpers of the same
// name. They are four lines each, they are private there, and the alternative
// is exporting internals from a file another workstream owns purely so this one
// can reach them — a coupling that buys nothing. If a third caller ever appears,
// promote them to a shared module then.

/** A list of `MoneyLine`s as label/amount rows. */
function moneyLineRowsHtml(lines: readonly MoneyLine[]): string {
  return lines
    .map(
      (l) =>
        `<div class="mt-line"><span class="mt-line-label">${esc(l.label)}${l.note ? ` <span class="mt-line-note">— ${esc(l.note)}</span>` : ""}</span><span class="mt-line-amt">${esc(formatCents(l.amountCents, { showCents: false }))}</span></div>`,
    )
    .join("");
}

/** Sum a list of money lines. Every total this page prints goes through here
 *  (or `launchTemplateTotalCents`) — a total is never typed. */
function sumMoneyLines(lines: readonly { amountCents: number }[]): number {
  return lines.reduce((total, l) => total + l.amountCents, 0);
}

/** `formatCents` without cents, escaped — the only way money reaches the markup
 *  in this file. */
function money(cents: number): string {
  return esc(formatCents(cents, { showCents: false }));
}

// ── Head ─────────────────────────────────────────────────────────────────────

/**
 * The head, mirroring `givePage.ts`'s `ogHead` (same tags, same order) minus
 * the `imageUrl` and `noindex` branches this page has no use for.
 *
 * NO `noindex`, and that is the point of the page. `/give/<slug>` stays out of
 * search because it pairs donor display names with amounts; this page contains
 * no person at all — a cost model, a tier ladder and a roles table — and it is
 * precisely the page we want a stranger to find when they search whether the
 * org is worth giving to.
 */
function howItWorksHead(title: string, description: string, url: string): string {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Public Worship">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="theme-color" content="#FDF6F6">
${FAVICON}
${FONTS}`;
}

// ── Sections ─────────────────────────────────────────────────────────────────

/**
 * How one gift splits: 85% local / 15% City Launch Fund, in percent AND in
 * dollars at the first tier, because "15%" and "$150 of the $1,000 a
 * twenty-backer chapter raises" are read by different people.
 *
 * Both percentages are derived from `CENTRAL_SKIM_PCT` — the same constant the
 * internal affordability model skims with — so the promise on this page and the
 * arithmetic in `chapterAffordability` cannot disagree.
 */
function splitSectionHtml(): string {
  const localPct = Math.round((1 - CENTRAL_SKIM_PCT) * 100);
  const skimPct = Math.round(CENTRAL_SKIM_PCT * 100);
  const tierFloor = PUBLIC_BACKER_TIERS[0];
  const skimAtFloor = Math.round(tierFloor.monthlyCents * CENTRAL_SKIM_PCT);
  const localAtFloor = tierFloor.monthlyCents - skimAtFloor;

  return `<section class="moneybox">
  <h2 class="sectionhead">How one gift splits</h2>
  <p class="lead">${localPct}% of what a chapter raises stays with that chapter and pays for the worship it puts on. ${skimPct}% goes to the City Launch Fund — the pot that buys the equipment and pays for the training that starts the next city. Give to a chapter and it stays with that chapter; the ${skimPct}% is the only thing that leaves, and it leaves to become somebody else's first month.</p>
  <div class="mt-split">
    <div class="fact"><div class="k">${money(localAtFloor)}/mo</div><div class="v">stays with the local team at ${tierFloor.minBackers} backers (${localPct}%).</div></div>
    <div class="fact"><div class="k">${money(skimAtFloor)}/mo</div><div class="v">seeds the next city's launch fund (${skimPct}%).</div></div>
  </div>
</section>`;
}

/**
 * What a chapter costs to run for a month — the ~$670 operating floor, itemised.
 *
 * Rendered EXPANDED (`<details open>`), unlike the collapsed version that used
 * to sit on `/give`. There it was a footnote on a page with a different job;
 * here it is the page's job, and a reader who navigated to "how it works" and
 * found the numbers hidden behind a disclosure triangle would be entitled to
 * wonder why. `.mt-detail` styles a `<details>`, so this reuses the class with
 * the opposite default rather than inventing a second look.
 */
function monthlyCostSectionHtml(): string {
  const operatingTotal = sumMoneyLines(MONTHLY_OPERATING_LINES);
  return `<section class="moneybox">
  <h2 class="sectionhead">What a chapter costs each month</h2>
  <p class="lead">This is the whole monthly floor for a five-person chapter — every recurring line, nothing rolled up into an "other". It is small on purpose: the cost of showing up every month should never be the reason a city can't.</p>
  <details class="mt-detail" open>
    <summary>Monthly operating — ${money(operatingTotal)}/mo</summary>
    <div class="mt-lines">${moneyLineRowsHtml(MONTHLY_OPERATING_LINES)}</div>
    <div class="mt-total"><span>Total</span><span>${money(operatingTotal)}/mo</span></div>
  </details>
</section>`;
}

/**
 * The backer ladder — 20 / 30 / 50 and what each headcount GUARANTEES.
 *
 * FRAMED AS A FLOOR, not a target. Spec **D2** killed the backer-count number
 * in the `/give` hero for exactly this reason: pinning the story to twenty
 * undersells every rung above it, so the ladder has to do the counting and it
 * has to be obvious that twenty is where a chapter becomes viable rather than
 * where it is finished. The first rung is marked `.next` — used here purely as
 * emphasis on the floor, since this page has no live backer count and therefore
 * no rung is literally "unlocked".
 *
 * Every figure is read off `PUBLIC_BACKER_TIERS`, including the step between
 * rungs (computed from the tier below rather than restated), so adding a fourth
 * tier to the shared constant renders correctly here with no edit.
 */
function ladderSectionHtml(): string {
  const unit = money(BACKER_UNIT_CENTS);
  const rungs = PUBLIC_BACKER_TIERS.map((tier, i) => {
    const previous = i > 0 ? PUBLIC_BACKER_TIERS[i - 1] : null;
    const step = previous ? tier.monthlyCents - previous.monthlyCents : 0;
    const detail = previous
      ? `${tier.minBackers - previous.minBackers} more backers — ${money(step)}/mo more — and this is guaranteed on top of everything below it.`
      : `The floor. ${tier.minBackers} backers at ${unit}/mo is the point at which a chapter covers its own month and stops depending on one-time gifts to keep going.`;
    return `<div class="rung${i === 0 ? " next" : ""}">
  <div class="badge">${tier.minBackers}</div>
  <div class="rt">
    <div class="lb">${tier.minBackers} backers — ${money(tier.monthlyCents)}/mo</div>
    <div class="cm">${esc(tier.commitment)}</div>
    <div class="ds">${detail}</div>
  </div>
</div>`;
  }).join("\n");

  return `<section class="ladder">
  <h2 class="sectionhead">What backing a city guarantees</h2>
  <p class="mt-backer-def">A backer gives ${unit} or more a month to one city. Each rung is a promise the chapter makes at that headcount, and it keeps everything below it — the ladder only ever adds. One person is one backer no matter how much more they give, and the core team sits outside every count, so nobody can move a chapter up a rung by counting themselves.</p>
  ${rungs}
</section>`;
}

/**
 * What starting a new city costs: the ~$8,000 one-time launch budget, then the
 * two shopping lists it pays for.
 *
 * THE HEADLINE AND THE LISTS COME FROM DIFFERENT CONSTANTS, and the copy says
 * so rather than papering over it. `LAUNCH_BUDGET_TEMPLATE` (via
 * `launchTemplateTotalCents`) is the BUDGETED grant — the four round lines
 * central actually commits to a new chapter, and the same number a territory's
 * public launch pot counts up to. `LAUNCH_EQUIPMENT_LINES` +
 * `LAUNCH_TRAINING_TRIP_LINES` are the ITEMISED estimate of what that grant
 * buys, which prices out a little under the budget. Showing the budget without
 * the list would be unauditable; showing the list as though it were the budget
 * would quietly restate a planned number as a spent one. So both are here, with
 * the difference named and computed rather than hidden — and the difference is
 * derived, so it stays correct when either constant moves.
 */
function launchCostSectionHtml(): string {
  const budgetTotal = launchTemplateTotalCents();
  const equipmentTotal = sumMoneyLines(LAUNCH_EQUIPMENT_LINES);
  const trainingTotal = sumMoneyLines(LAUNCH_TRAINING_TRIP_LINES);
  const itemisedTotal = equipmentTotal + trainingTotal;
  const headroom = budgetTotal - itemisedTotal;

  const headroomLine =
    headroom > 0
      ? `The itemised estimate below comes to ${money(itemisedTotal)}; the budget carries ${money(budgetTotal)} so a price that moved between the estimate and the purchase doesn't stall a launch.`
      : `The itemised estimate below comes to ${money(itemisedTotal)} against a budgeted ${money(budgetTotal)}.`;

  return `<section class="moneybox">
  <h2 class="sectionhead">What it costs to start a new city</h2>
  <p class="lead">A city starts once, and it costs about ${money(budgetTotal)}: the production kit the chapter will own for years, and a training trip to New York for the five people who will run it. ${headroomLine} It is a one-time cost — after that the chapter is carried by its own backers.</p>

  <details class="mt-detail" open>
    <summary>The launch budget — ${money(budgetTotal)}</summary>
    <div class="mt-lines">${moneyLineRowsHtml(LAUNCH_BUDGET_TEMPLATE)}</div>
    <div class="mt-total mt-total-grand"><span>Total</span><span>${money(budgetTotal)}</span></div>
  </details>

  <details class="mt-detail">
    <summary>What that buys, line by line — ${money(itemisedTotal)} estimated</summary>
    <div class="mt-sub">Equipment the chapter keeps</div>
    <div class="mt-lines">${moneyLineRowsHtml(LAUNCH_EQUIPMENT_LINES)}</div>
    <div class="mt-total"><span>Equipment</span><span>${money(equipmentTotal)}</span></div>
    <div class="mt-sub">Training trip to New York</div>
    <div class="mt-lines">${moneyLineRowsHtml(LAUNCH_TRAINING_TRIP_LINES)}</div>
    <div class="mt-total"><span>Training trip</span><span>${money(trainingTotal)}</span></div>
    <div class="mt-total mt-total-grand"><span>Estimated total</span><span>${money(itemisedTotal)}</span></div>
  </details>
</section>`;
}

/**
 * The five people who run a chapter — role and what each one owns, straight
 * from `CHAPTER_CORE_ROLES` so this table, the founding-team role picker on
 * `/give` and the internal affordability model all name the same five jobs.
 *
 * **D3 applies here more than anywhere else on the page.** The version this
 * replaces was headed "The 5-person volunteer core team" and the section it
 * sat in opened with a compensation claim. This one says what the roles are,
 * what they own, and how long a term runs — and nothing about pay, in either
 * direction. If that ever changes, it changes on `/finances`, where
 * `COMPENSATION_DISCLOSURE` states the org's actual position against actual
 * published rows, rather than as an adjective on a marketing page.
 */
function coreTeamSectionHtml(): string {
  const roleRows = CHAPTER_CORE_ROLES.map(
    (r) => `<tr><td>${esc(r.role)}</td><td>${esc(r.owns)}</td></tr>`,
  ).join("");

  return `<section class="moneybox">
  <h2 class="sectionhead">The five people who run a chapter</h2>
  <p class="lead">Every chapter is run by the same five roles, and each one mirrors a director at central who trains and backs them. Five is the number that makes a month of worship happen without any one person carrying it; it grows to about ten as a chapter takes on Eden and Love Thy Neighbor.</p>
  <div class="mt-table-wrap"><table class="mt-table">
    <thead><tr><th>Role</th><th>Owns</th></tr></thead>
    <tbody>${roleRows}</tbody>
  </table></div>
  <p class="mt-backer-def">Each position is a one-year term with the option to renew for one more — long enough to build something real, with a natural moment to hand off the baton.</p>
</section>`;
}

/**
 * "Who we're looking for" — the team-philosophy block relocated from
 * `givePageSections.ts#teamPhilosophyHtml` (spec §"Page composition", removed
 * from both give pages).
 *
 * RELOCATED, NOT COPIED. The original opened "Every Public Worship team —
 * central and every chapter — is volunteer," which **D3** forbids; that clause
 * is gone and the paragraph now opens on what it was actually about, which is
 * the kind of person we recruit. What remains — a commitment of time, a
 * connection to a local church, alignment with the statement of beliefs — is a
 * description of an ASK, not a claim about anybody's compensation, and the two
 * must not be allowed to blur back together in a future copy edit.
 *
 * Static copy with no interpolation, so no `esc()` calls appear here — the
 * house rule escapes interpolated values, and this template has none.
 */
function whoWeLookForSectionHtml(): string {
  return `<section class="teamphilo">
  <h2 class="sectionhead">Who we're looking for</h2>
  <p>We're looking for people who want real leadership experience and carry a genuine passion and heart for worship: people already committed to serving a local church community, who align with our statement of beliefs, and who understand sacrifice — already serving at their church and wanting to do more.</p>
  <p class="teamphilo-quote">Serving your church is your tithes and offerings; Public Worship is your sacrificial giving.</p>
  <p>We're looking for people willing to give sacrificially with their time. God has blessed Public Worship with more than enough candidates ready to answer the call, and it's central's duty to train them from the ground up so they have everything they need: resources, mentorship, discipleship, and custom in-house software that makes doing this well easier for everyone.</p>
</section>`;
}

/**
 * The closing hand-off: everything above is a plan; `/finances` is what
 * happened.
 *
 * This is the most important section on the page and the reason it isn't just
 * a spec sheet. A model is a promise, and a promise is worth exactly as much as
 * the record behind it — so the page ends by saying its own numbers are only a
 * plan, and pointing at the ledger where every transaction is published month
 * by month, INCLUDING the rows we can't produce a receipt for, marked as such.
 * Naming the ugly rows here rather than letting a reader discover them is the
 * same argument `publicLedgerPage.ts` makes about disclosure: a ledger that
 * quietly presents rebuilt history as if it had been watched reads as less
 * credible, not more.
 *
 * TWO EXITS, deliberately (both required by the task's "loop, not a dead end"):
 * `/finances` for the reader who wants the evidence, and `/give` for the reader
 * this page just convinced. A transparency page whose only exit is the Back
 * button converts nobody.
 */
function booksSectionHtml(): string {
  return `<section class="moneyteaser">
  <h2>The plan, and then the receipts</h2>
  <p class="mt-lead">Everything above is a <span class="sharp">model</span> — what a chapter is built to cost, what a backer's month buys, what it takes to start a city. It is how we plan. It is not evidence.</p>
  <p class="mt-lead">The evidence is the books. We publish our finances month by month: <span class="sharp">every transaction</span>, across every chapter, what it was for, and whether we can produce the receipt. The rows with no receipt are published too, marked as exactly that — a ledger that only shows the tidy lines isn't a ledger.</p>
  <div class="booklink">
    <div class="bl-ic">📕</div>
    <div>
      <div class="bl-t">Read the books</div>
      <div class="bl-s">Every transaction, every month, including the ones we can't document. Nothing summarised away.</div>
    </div>
  </div>
  <div class="mt-links">
    <a class="ctabtn primary" href="${ledgerPath()}">Read our books →</a>
    <a class="ctabtn secondary" href="${givePagePath()}">Back a city →</a>
  </div>
</section>`;
}

// ── /give/how-it-works ───────────────────────────────────────────────────────

/**
 * The whole page. Takes only the site's base URL (for the canonical/OG url) —
 * there is no dynamic data on this page by design: it renders the MODEL, and
 * the model is a set of shared constants, so this renderer stays a pure
 * function of `finance.ts` and can never be stale-cached against a database
 * read. Live numbers belong on `/give` (the wall, the backer counts) and real
 * numbers belong on `/finances`.
 */
export function renderGiveHowItWorksPage(siteUrl: string): string {
  const title = "How the money works · Public Worship";
  const description =
    "What a Public Worship chapter costs to run, what backing a city guarantees, what it costs to start a new one, and how every gift splits between the local chapter and the City Launch Fund.";
  const url = `${siteUrl}${giveHowItWorksPath()}`;

  return `<!doctype html>
<html lang="en">
<head>
${howItWorksHead(title, description, url)}
<style>
${BASE_CSS}${GIVE_CSS}
</style>
</head>
<body>
<main class="give">
  <div class="give-topbar">
    <div class="wordmark">✦ PUBLIC WORSHIP ✦</div>
    <div class="give-topnav">
      <a class="give-navlink" href="${givePagePath()}">Back a city →</a>
      <a class="give-navlink" href="${ledgerPath()}">Read our books →</a>
    </div>
  </div>

  <div class="give-hero">
    <h1 class="serif">Where the money goes</h1>
    <p>Every number on this page comes from the same place our own budgets do. Here is what a chapter costs, what your backing guarantees, what it takes to start a city, and where each gift splits.</p>
  </div>

  ${splitSectionHtml()}

  ${monthlyCostSectionHtml()}

  ${ladderSectionHtml()}

  ${launchCostSectionHtml()}

  ${coreTeamSectionHtml()}

  ${whoWeLookForSectionHtml()}

  ${booksSectionHtml()}

  <footer style="margin-top:20px;text-align:center;font-size:12.5px;color:var(--faint)">Made with <span class="hearts">♥</span> by Public Worship</footer>
</main>
</body>
</html>`;
}
