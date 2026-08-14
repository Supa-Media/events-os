/**
 * The public finances page — server-rendered HTML from a Convex `httpAction`,
 * the same house pattern as `givePage.ts` and `landingPage.ts`: self-contained
 * inline CSS/JS, OG tags, no external assets. Served by `http.ts` at
 * `/finances` (the latest published month) and `/finances/<YYYY-MM>`.
 *
 * ── WHAT THIS PAGE IS FOR ────────────────────────────────────────────────────
 * The owner's framing, and the thing every layout decision here answers to: a
 * giver reading an annual report sees "$3.9M staff cost" and feels like a drop
 * in a bucket. A giver reading a LINE — "$47.83, Costco, water and cups for
 * the setup team at a Worship With Strangers night, 12 people" — can see
 * their own $5 in it. So the page
 * is built to get from the headline to the individual line in as few moves as
 * possible, and the line is the point, not the summary.
 *
 * The order is deliberate:
 *   1. the three numbers (in, out, difference)
 *   2. where it came from
 *   3. where it went — by category AND by what it was actually for
 *   4. EVERY line, searchable
 *   5. the anonymous giving roll — "find the minute you gave"
 *   6. amendments, then how to read all of it
 *
 * ── DISCLOSURE IS NOT A FOOTNOTE ─────────────────────────────────────────────
 * Reconstructed rows, undocumented rows and rows with no approved explanation
 * are surfaced as their own callouts and as per-row chips, not buried. A
 * ledger that quietly presents rebuilt-from-a-spreadsheet history as if it had
 * been watched is overclaiming, and overclaiming reads as less credible, not
 * more — the argument `publishability.ts` already makes, applied to the
 * surface a stranger actually sees.
 *
 * ── NO NAMES ─────────────────────────────────────────────────────────────────
 * No donor name, no attendee name, ever. The data reaching this renderer
 * never contained them (`schema/publicLedger.ts`), so this is a property of
 * the pipeline rather than a rule this file has to remember.
 */
import { BASE_CSS, FAVICON, FONTS } from "./landingPageStyles";
import { LEDGER_CSS, LEDGER_SCRIPT } from "./publicLedgerPageStyles";
import { escapeHtml as esc } from "./html";
import { siteUrl } from "./siteUrl";
import {
  AMENDMENT_REASON_LABELS,
  ATTENDEE_AFFILIATION_LABELS,
  COMPENSATION_DISCLOSURE,
  compensationGroupSummary,
  compensationTable,
  POSITION_GLYPH,
  positionPayLabel,
  type CompensationRow,
  type PositionHeadcount,
  DOCUMENTATION_STATE_LABELS,
  DOCUMENTATION_EXEMPTIONS,
  DOCUMENTATION_EXEMPTION_LABELS,
  documentationExemptionLine,
  type DocumentationExemption,
  EXPENSE_TYPE_LABELS,
  formatAffiliationMix,
  contactMailto,
  formatCents,
  INCOME_STREAM_BLURBS,
  INCOME_STREAM_LABELS,
  monthName,
  monthsOfYear,
  periodLabel,
  PUBLIC_CONTACT_EMAIL,
  type AmendmentReason,
  type DocumentationState,
  type ExpenseType,
  type IncomeStream,
} from "@events-os/shared";

const TZ = "America/New_York";

export const LEDGER_PATH = "finances";

export function ledgerPath(periodKey?: string): string {
  return periodKey ? `/${LEDGER_PATH}/${periodKey}` : `/${LEDGER_PATH}`;
}

// ── Public data shapes (mirror `publicLedger.publicStatement`) ───────────────

export type PublicLedgerEntry = {
  occurredAt: number;
  amountCents: number;
  direction: "in" | "out" | "internal";
  countsInTotals: boolean;
  bookLabel: string;
  counterparty: string | null;
  purpose: string | null;
  categoryLabel: string | null;
  fundLabel: string | null;
  budgetLabel: string | null;
  projectLabel: string | null;
  eventLabel: string | null;
  expenseType: ExpenseType | null;
  travelFrom: string | null;
  travelTo: string | null;
  headcount: number | null;
  affiliationMix: Record<string, number> | null;
  groupDescription: string | null;
  documentation: DocumentationState | null;
  /** Why this row owed no document, or null when it owed one. A plain string
   *  rather than the `DocumentationExemption` union: a published revision is
   *  frozen evidence that must keep validating after a key is retired, so the
   *  page resolves the label through the shared list and prints nothing for a
   *  key it no longer recognises. */
  documentationExempt: string | null;
  reconstructed: boolean;
  nonDiscretionaryFee: boolean;
};

export type PublicLedgerGift = {
  occurredAt: number;
  amountCents: number;
  method: string | null;
  designation: string | null;
  bookLabel: string;
};

export type BudgetRow = {
  label: string;
  allocatedCents: number | null;
  spentCents: number;
  count: number;
};

/** Everything a month and a year have in common — which is everything except
 *  how the period is named. The two renderers share every section below. */
export type StatementCore = {
  incomeCents: number;
  expenseCents: number;
  netCents: number;
  incomeByStream: { stream: IncomeStream; cents: number; count: number }[];
  expenseByCategory: { label: string; cents: number; count: number }[];
  expenseByProject: { label: string; cents: number; count: number }[];
  spendByBudget: BudgetRow[];
  reconstructedCount: number;
  reconstructedCents: number;
  undocumentedCount: number;
  undocumentedCents: number;
  uncodedCount: number;
  uncodedCents: number;
  unexplainedCount: number;
  unexplainedCents: number;
  entryCount: number;
  giftCount: number;
  giverCount: number;
  backerCount: number;
  entriesTruncated: boolean;
  books: {
    bookLabel: string;
    periodKey: string;
    label: string;
    revision: number;
    publishedAt: number;
    amendments: {
      revision: number;
      publishedAt: number;
      reason: string | null;
      note: string | null;
    }[];
  }[];
  entries: PublicLedgerEntry[];
  gifts: PublicLedgerGift[];
};

export type PublicStatement = StatementCore & {
  periodKey: string;
  label: string;
};

export type PublicYearStatement = StatementCore & {
  year: string;
  label: string;
  /** The `YYYY-MM` keys that contributed, oldest first. */
  months: string[];
};

export type PublishedMonth = {
  periodKey: string;
  label: string;
  publishedAt: number;
  bookCount: number;
};

export type PublishedYear = { year: string; monthCount: number };

// ── Formatting ───────────────────────────────────────────────────────────────

function shortDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
  });
}

function longDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    timeZone: TZ,
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function timeOfDay(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Cash amounts show cents everywhere on this page, deliberately. Rounding to
 *  the dollar is the small dishonesty that makes a published total stop
 *  reconciling against the CSV a reader downloads. */
const money = (cents: number) => formatCents(cents, { showCents: true });

// ── Page shell ───────────────────────────────────────────────────────────────

/** The banner text a preview render is required to carry, unmodified — the
 *  test suite pins this exact string. */
export const PREVIEW_BANNER_TEXT =
  "PREVIEW — not published. This is what the page will look like; numbers reflect the books right now.";

function shell(opts: {
  title: string;
  description: string;
  body: string;
  canonicalPath: string;
  /** Draft-preview mode (`renderLedgerPage`'s `opts.preview`): stamps
   *  `noindex` and a fixed banner, and is the ONLY thing this function
   *  changes about its output — absent, the page is byte-identical to before
   *  this option existed. */
  preview?: boolean;
}): string {
  const url = `${siteUrl()}${opts.canonicalPath}`;
  const robots = opts.preview
    ? `\n<meta name="robots" content="noindex">`
    : "";
  const banner = opts.preview
    ? `<div class="previewbanner">${esc(PREVIEW_BANNER_TEXT)}</div>`
    : "";
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(opts.title)}">
<meta property="og:description" content="${esc(opts.description)}">
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary">${robots}
${FAVICON}${FONTS}
<style>${BASE_CSS}${LEDGER_CSS}</style>
</head><body>
<main${opts.preview ? ` class="haspreview"` : ""}>
${banner}<div class="topbar">
  <a class="wordmark" href="/">PUBLIC WORSHIP</a>
  <nav class="topnav">
    <a href="/give">Give</a>
    <a href="${esc(ledgerPath())}">Finances</a>
  </nav>
</div>
${opts.body}
</main>
<script>${LEDGER_SCRIPT}</script>
</body></html>`;
}

// ── Sections ─────────────────────────────────────────────────────────────────

/**
 * The period picker: a YEAR dropdown and a MONTH dropdown whose first option
 * is "All months" — which is what a yearly rollup is.
 *
 * A plain `<form method="get">` posting to `/finances`, which redirects to the
 * canonical path (`/finances/2026-08` or `/finances/2026`). Three properties
 * fall out of doing it that way and none of them are free if you wire the
 * selects straight to `location.href`:
 *
 *  - It works with JavaScript disabled. A transparency page that needs JS to
 *    let you change the year is not one an auditor can rely on.
 *  - The URL a reader ends up on, and therefore shares, names the period.
 *    A query-string page would leave `?year=&month=` in circulation and mean
 *    something different next year.
 *  - The browser's back button behaves.
 *
 * The inline script auto-submits on change so it still feels immediate; the
 * View button is left visible rather than hidden by JS, because a control
 * that vanishes depending on how the page loaded is worse than a redundant
 * one.
 *
 * UNPUBLISHED MONTHS ARE LISTED AND DISABLED, not omitted. "September isn't
 * in the dropdown" and "September hasn't been published" are different facts,
 * and only the second one is true — so the option says so.
 */
function periodPickerHtml(opts: {
  years: PublishedYear[];
  months: PublishedMonth[];
  selectedYear: string;
  /** `""` when the whole year is selected. */
  selectedMonth: string;
}): string {
  const { years, months, selectedYear, selectedMonth } = opts;
  if (years.length === 0) return "";
  const published = new Set(months.map((m) => m.periodKey));

  const yearOptions = years
    .map(
      (y) =>
        `<option value="${esc(y.year)}"${y.year === selectedYear ? " selected" : ""}>${esc(y.year)} · ${y.monthCount} month${y.monthCount === 1 ? "" : "s"}</option>`,
    )
    .join("");

  const monthOptions = [
    `<option value=""${selectedMonth === "" ? " selected" : ""}>All months (year total)</option>`,
    ...monthsOfYear(Number(selectedYear)).map((key, i) => {
      const mm = String(i + 1).padStart(2, "0");
      const isPublished = published.has(key);
      return `<option value="${mm}"${mm === selectedMonth ? " selected" : ""}${
        isPublished ? "" : " disabled"
      }>${esc(monthName(i + 1))}${isPublished ? "" : " — not published"}</option>`;
    }),
  ].join("");

  return `<form class="picker" action="${esc(ledgerPath())}" method="get">
  <label class="pickerlabel" for="year">Year</label>
  <select id="year" name="year">${yearOptions}</select>
  <label class="pickerlabel" for="month">Month</label>
  <select id="month" name="month">${monthOptions}</select>
  <button type="submit" class="pickerbtn">View</button>
</form>`;
}

/**
 * THE FOUR NUMBERS — raised, spent, givers, backers.
 *
 * The owner's ask, and the right four: two about the money and two about the
 * people, because "we spent $377,000" and "412 people made that possible" are
 * different claims and a page that made only the first one would read as an
 * accounting exercise rather than an account of a community.
 *
 * "Difference" rides along under Total spent rather than taking a fifth tile.
 * It is genuinely useful and genuinely secondary — and it is called
 * "Difference," not "Surplus" or "Profit," because a deliberate month of
 * spending down reserves has not lost anything and a month that ends up ahead
 * has not earned a profit. It is the only word true in both directions.
 *
 * GIVERS AND BACKERS ARE DISTINCT PEOPLE, unioned across every month being
 * shown (`publicLedger.ts#mergeLive`) — never the sum of monthly counts, which
 * would report someone who gives every month as twelve people. The tiles are
 * omitted entirely, rather than printed as 0, on a statement published before
 * those figures existed: a confident zero is worse than a missing tile.
 */
function statsHtml(s: StatementCore): string {
  const netLabel = s.netCents >= 0 ? "more in than out" : "more out than in";
  const hasPeople = s.giverCount > 0 || s.backerCount > 0;
  const peopleTiles = hasPeople
    ? `<div class="stat people"><div class="k">Givers</div><div class="v">${s.giverCount.toLocaleString()}</div>
    <div class="sub">${s.giftCount.toLocaleString()} gift${s.giftCount === 1 ? "" : "s"} between them</div></div>
  <div class="stat people"><div class="k">Backers</div><div class="v">${s.backerCount.toLocaleString()}</div>
    <div class="sub">giving on a recurring basis</div></div>`
    : "";
  return `<div class="stats${hasPeople ? " four" : ""}">
  <div class="stat in"><div class="k">Total raised</div><div class="v">${esc(money(s.incomeCents))}</div>
    <div class="sub">gifts, tickets, merch and program fees</div></div>
  <div class="stat out"><div class="k">Total spent</div><div class="v">${esc(money(s.expenseCents))}</div>
    <div class="sub">${esc(money(Math.abs(s.netCents)))} ${esc(netLabel)}</div></div>
  ${peopleTiles}
</div>`;
}

/**
 * One position: a circle with a person in it, a count on the circle's rim, the
 * position's name, and what it pays.
 *
 * ── THE COUNT RIDES THE RIM; IT NEVER REPLACES THE GLYPH ─────────────────────
 * The obvious compaction — put the number INSIDE the circle and drop the
 * person — was tried and is wrong. A circle containing "7" stops reading as
 * people and starts reading as a quantity of something unstated; the tile
 * needs a person in it for the number beside it to mean people at all. So the
 * glyph stays and the badge sits on the rim, which is also the arrangement
 * every reader has already learned from a notification dot.
 *
 * ── A VACANCY IS NOT AN ERROR ────────────────────────────────────────────────
 * A position nobody holds shows a plain `0` and still reads "Volunteer", with
 * no dimming, no dashed border, no "vacant" label. That is what the position
 * pays whether or not somebody is in it, and a page that styled empty seats as
 * a problem would be making a claim about our staffing that this section is
 * not making.
 *
 * ── NO SECOND TREATMENT FOR A PAID POSITION ──────────────────────────────────
 * The paid tile gets no colour, no border, no fill and no extra class — it is
 * `paytile` exactly like its neighbours. Red would read as an alarm and a
 * salary is not one; any accent at all would editorialise about a figure we
 * publish precisely because paying people is normal and defensible. The whole
 * difference is the last line: a word, or a figure. The figure carries the
 * page's ink colour and the word sits back a shade (`.paypay.volunteer`) —
 * enough that a reader scanning for numbers finds them, not enough to make one
 * tile the story of the section. Note which of the two carries the modifier
 * class: the DEFAULT is the figure, so a paid tile is the one with nothing
 * special on it.
 */
function payTileHtml(row: CompensationRow): string {
  const held =
    row.peopleCount === 0
      ? "Nobody holds this position right now"
      : `${row.peopleCount} ${row.peopleCount === 1 ? "person holds" : "people hold"} this position`;
  const paid = row.payCents > 0;
  return `<div class="paytile">
      <span class="paydisc" title="${esc(held)}"><span class="payglyph" aria-hidden="true">${esc(POSITION_GLYPH)}</span><span class="paycount">${row.peopleCount}</span></span>
      <span class="payposition">${esc(row.title)}</span>
      <span class="paypay${paid ? "" : " volunteer"}">${esc(positionPayLabel(row.payCents))}</span>
    </div>`;
}

/**
 * WHO GETS PAID — stated up front, not buried in an accordion.
 *
 * This sat inside the "Why are there no names?" FAQ, which is exactly the
 * wrong place for it: "nobody here is paid" is one of the strongest things
 * this organization can say about itself, and it was three clicks deep behind
 * a question about something else.
 *
 * It renders immediately under the stat tiles because that is where the
 * question arises — a reader who has just seen "Total spent" is entitled to
 * know how much of it went to the people spending it, and the answer is
 * currently none.
 *
 * ── THE GRID IS THE PROMISE, KEPT EARLY ──────────────────────────────────────
 * The prose here used to say we WOULD one day publish pay by position rather
 * than by person. It now does it: every position in the org chart, banded
 * org-wide then chapter, each with its pay under it — and today every one of
 * them reads "Volunteer." Publishing the format before there is a figure in it
 * means the day one appears, the reader meets a number on a tile they already
 * know how to read, rather than a new section that arrived with the salary.
 *
 * ── WHY A GRID AND NOT A LIST ────────────────────────────────────────────────
 * The list this replaced was 26 rows in two tall columns, every one of them
 * ending in the same word. Length was doing the work of emphasis: a reader
 * scrolling that far learned "there are a lot of positions" long before they
 * learned "none of them are paid." The grid states the same facts in a third
 * of the height, which is the only form in which the pay line is legible AS a
 * repeated answer rather than as a wall.
 *
 * ── NO LEGEND ────────────────────────────────────────────────────────────────
 * There is no key explaining the badge or the pay line, deliberately.
 * "Volunteer" and "$48,000/yr" say themselves, and a legend would be the page
 * teaching a notation it doesn't actually use.
 *
 * The two things this renderer deliberately does NOT do are enforced upstream
 * by `compensationTable()` (see `COMPENSATION_DISCLOSURE`'s doc for the full
 * reasoning): tiles are seat DEFS plus an integer count, so there is no path
 * from here to a person's name; and no pay string is hardcoded, so stating a
 * real figure for one position is a one-line data edit that never reaches this
 * file.
 *
 * It renders on EVERY published month, backdated ones included — pay and
 * headcount alike are read live rather than frozen into a publication, because
 * this is a statement about the org right now, not a fact about a month's
 * transactions.
 */
function compensationHtml(headcount: PositionHeadcount): string {
  const c = COMPENSATION_DISCLOSURE;
  const bands = compensationTable(headcount)
    .map(
      (g) => `<div class="payband">
    <div class="paybandhead">${esc(g.heading)}<span class="paybandcount">${esc(compensationGroupSummary(g))}</span></div>
    <div class="paygrid">${g.rows.map(payTileHtml).join("")}</div>
  </div>`,
    )
    .join("");

  return `<section id="pay">
  <h2 class="sectionhead">Who gets paid</h2>
  <p class="sectionsub">${esc(c.intro)}</p>
  ${bands}
  <p class="paypolicy">${esc(c.policy)}</p>
</section>`;
}

function barRowsHtml(
  rows: { label: string; cents: number; count: number; blurb?: string }[],
  inflow: boolean,
): string {
  const max = rows.reduce((m, r) => Math.max(m, r.cents), 0) || 1;
  return rows
    .map((r) => {
      const pct = Math.max(1, Math.round((r.cents / max) * 100));
      return `<div class="barrow">
  <div class="barhead">
    <span class="barlabel">${esc(r.label)} <span class="barnote">${r.count.toLocaleString()}&nbsp;${r.count === 1 ? "entry" : "entries"}</span></span>
    <span class="baramt">${esc(money(r.cents))}</span>
  </div>
  <div class="bartrack"><div class="barfill${inflow ? " inflow" : ""}" style="width:${pct}%"></div></div>
  ${r.blurb ? `<p class="barblurb">${esc(r.blurb)}</p>` : ""}
</div>`;
    })
    .join("");
}

function incomeHtml(s: StatementCore): string {
  if (s.incomeByStream.length === 0) return "";
  const rows = s.incomeByStream.map((r) => ({
    label: INCOME_STREAM_LABELS[r.stream],
    cents: r.cents,
    count: r.count,
    blurb: INCOME_STREAM_BLURBS[r.stream],
  }));
  return `<section>
  <h2 class="sectionhead">Where it came from</h2>
  <p class="sectionsub">Counted when the money was given, not when it reached the bank — so a gift on the last day of the month belongs to that month even if the deposit lands the following week.</p>
  <div class="bars">${barRowsHtml(rows, true)}</div>
</section>`;
}

function expenseHtml(s: StatementCore): string {
  if (s.expenseByCategory.length === 0 && s.expenseByProject.length === 0) {
    return "";
  }
  return `<section>
  <h2 class="sectionhead">Where it went</h2>
  <p class="sectionsub">The same money, grouped two ways. "By category" is the accounting view. "By what it was for" is the one most people actually want — it follows a dollar to the thing it paid for.</p>
  <div class="tabs">
    <button type="button" data-tab="cat" aria-pressed="true">By category</button>
    <button type="button" data-tab="proj" aria-pressed="false">By what it was for</button>
  </div>
  <div class="bars" data-panel="cat">${barRowsHtml(s.expenseByCategory, false)}</div>
  <div class="bars" data-panel="proj" style="display:none">${barRowsHtml(s.expenseByProject, false)}</div>
</section>`;
}

/**
 * Resolve a published exemption key to what the chip shows.
 *
 * TOLERANT OF A KEY IT NO LONGER KNOWS, on purpose. A published revision is
 * frozen evidence and keeps validating after a key is retired from
 * `DOCUMENTATION_EXEMPTIONS`, so a months-old page can carry one this build has
 * never heard of. It then renders as the plain documentation state it always
 * did — a chip missing its explanation, rather than a page that throws.
 */
function documentationExemptLabel(
  key: string | null,
): { label: string; line: string } | null {
  if (!key) return null;
  const known = (DOCUMENTATION_EXEMPTIONS as readonly string[]).includes(key);
  if (!known) return null;
  const typed = key as DocumentationExemption;
  return {
    label: DOCUMENTATION_EXEMPTION_LABELS[typed],
    line: documentationExemptionLine(typed),
  };
}

/** The per-row chips: documentation state, rebuilt history, charged-not-chosen
 *  fees, and internal movements. Each one exists so a reader can tell rows
 *  apart that would otherwise look identical and mean different things. */
function rowChipsHtml(e: PublicLedgerEntry): string {
  const chips: string[] = [];
  // ── A ROW THAT OWES NOTHING SAYS SO, RATHER THAN "UNDOCUMENTED" ───────────
  // Founder, on the published March page: some rows read undocumented that
  // "shouldn't need to be… it should automatically be a documented exception
  // or document not needed". A $3.00 fare marked as an accidental personal
  // charge and already paid back; a $7,000 deposit already recorded as giving,
  // badged "Undocumented" two lines under its own sentence explaining the
  // giving split.
  //
  // The exemption REPLACES the bare state rather than sitting beside it. Both
  // chips would say the row has no receipt twice, once as a failing and once
  // as a fact, and the reader would have to work out which one governs. The
  // sentence behind it goes in the `title`, so the short label stays scannable
  // and the full reasoning is a hover away — the same treatment every other
  // chip here gets.
  const exemptLabel = documentationExemptLabel(e.documentationExempt);
  if (exemptLabel) {
    chips.push(
      `<span class="chip exception" title="${esc(exemptLabel.line)}">${esc(exemptLabel.label)}</span>`,
    );
  } else if (e.documentation) {
    chips.push(
      `<span class="chip ${e.documentation}">${esc(DOCUMENTATION_STATE_LABELS[e.documentation])}</span>`,
    );
  }
  if (e.reconstructed) {
    chips.push(
      `<span class="chip rebuilt" title="Rebuilt from records after the fact, rather than captured as it happened">Rebuilt</span>`,
    );
  }
  if (e.nonDiscretionaryFee) {
    chips.push(
      `<span class="chip fee" title="A processor or bank fee — charged, not chosen">Fee</span>`,
    );
  }
  if (!e.countsInTotals) {
    chips.push(
      `<span class="chip internal" title="Money moving between our own accounts, or the bank arrival of income already counted above. Shown for completeness; not added to any total.">Not counted</span>`,
    );
  }
  return chips.join("");
}

/** The "who was there / where to where" line under a purpose. This is the
 *  §274(d) substantiation rendered for a stranger — the thing the owner
 *  learned from their accountant and wired into the system. */
function contextHtml(e: PublicLedgerEntry): string {
  const bits: string[] = [];
  if (e.travelFrom || e.travelTo) {
    bits.push(`${e.travelFrom ?? "—"} → ${e.travelTo ?? "—"}`);
  }
  if (e.headcount != null) {
    const mix = formatAffiliationMix(e.affiliationMix, ATTENDEE_AFFILIATION_LABELS);
    bits.push(
      `${e.headcount} ${e.headcount === 1 ? "person" : "people"}${mix ? ` — ${mix}` : ""}`,
    );
  } else {
    const mix = formatAffiliationMix(e.affiliationMix, ATTENDEE_AFFILIATION_LABELS);
    if (mix) bits.push(mix);
  }
  if (e.groupDescription) bits.push(e.groupDescription);
  if (e.expenseType && e.expenseType !== "general") {
    bits.push(EXPENSE_TYPE_LABELS[e.expenseType]);
  }
  return bits.length > 0 ? `<span class="detail">${esc(bits.join(" · "))}</span>` : "";
}

/**
 * BUDGETS — what was planned, and what was actually used.
 *
 * The owner's ask ("make sure the budgets are in there as well and how much
 * was spent in each budget"), and the section that turns the page from a
 * record into an account: a ledger says what happened, a plan-vs-actual says
 * whether it was what you meant to happen.
 *
 * ── ESTIMATED AND ACTUAL SIT SIDE BY SIDE, NEVER SUMMED ──────────────────────
 * The schema's third invariant is that budget money and transaction money are
 * never added together. They are not added here — they are two columns of one
 * row, which is exactly the comparison a reader is making. The bar shows
 * spend as a fraction of the allocation, and is deliberately allowed to run
 * past 100%: an over-budget line is the single most interesting row in the
 * table and clamping it would hide it.
 *
 * ── A MISSING ALLOCATION IS NOT A ZERO ───────────────────────────────────────
 * Two rows legitimately have no allocation: spend that carried no budget at
 * all ("Not attached to a budget"), and any row in a YEAR rollup whose months
 * didn't all carry one. Both render "—", never "$0.00", because "we did not
 * budget this" and "we budgeted nothing for this" are different statements and
 * only one of them is being made.
 */
function budgetsHtml(s: StatementCore, isYear: boolean): string {
  if (s.spendByBudget.length === 0) return "";
  const rows = s.spendByBudget
    .map((b) => {
      const pct =
        b.allocatedCents && b.allocatedCents > 0
          ? Math.round((b.spentCents / b.allocatedCents) * 100)
          : null;
      const over = pct != null && pct > 100;
      return `<div class="budgetrow">
  <div class="barhead">
    <span class="barlabel">${esc(b.label)} <span class="barnote">${b.count.toLocaleString()}&nbsp;${b.count === 1 ? "line" : "lines"}</span></span>
    <span class="baramt">${esc(money(b.spentCents))}${
      b.allocatedCents != null
        ? ` <span class="ofplan">of ${esc(money(b.allocatedCents))}</span>`
        : ` <span class="ofplan">— no budget set</span>`
    }</span>
  </div>
  ${
    pct == null
      ? ""
      : `<div class="bartrack"><div class="barfill${over ? " over" : ""}" style="width:${Math.min(pct, 100)}%"></div></div>
  <div class="barpct${over ? " over" : ""}">${pct}% of the plan${over ? ` — over by ${esc(money(b.spentCents - (b.allocatedCents ?? 0)))}` : ""}</div>`
  }
</div>`;
    })
    .join("");
  return `<section>
  <h2 class="sectionhead">Against the plan</h2>
  <p class="sectionsub">Every budget that money came out of this ${isYear ? "year" : "month"}, what it was allowed, and what it actually used. ${
    isYear
      ? "Allocations only show where every month behind the figure carried one — otherwise this reads as spend alone, and the month view has the full plan."
      : "Spending past a budget isn't hidden here; it's the row worth looking at."
  }</p>
  <div class="bars">${rows}</div>
</section>`;
}

function ledgerHtml(s: PublicStatement): string {
  const rows = s.entries
    .map((e) => {
      // Everything a reader might type into the search box, lowercased once at
      // render time so the client filter is a substring test rather than a
      // per-keystroke walk over several fields.
      const search = [
        shortDate(e.occurredAt),
        e.counterparty,
        e.purpose,
        e.categoryLabel,
        e.fundLabel,
        e.budgetLabel,
        e.projectLabel,
        e.eventLabel,
        e.bookLabel,
        e.travelFrom,
        e.travelTo,
        e.groupDescription,
        money(e.amountCents),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const sign = e.direction === "out" ? "−" : e.direction === "in" ? "+" : "";
      // The FILTER has to agree with the CHIP. A row the page badges "Bank
      // record only" must not still answer to "Undocumented" in the dropdown —
      // that is the same contradiction one layer down, and the reader who went
      // looking for missing paperwork is exactly the one who would find it.
      // An exempt row files under `exception`, which is what the founder asked
      // for in as many words: "it should automatically be a documented
      // exception or document not needed".
      const docFacet = documentationExemptLabel(e.documentationExempt)
        ? "exception"
        : (e.documentation ?? "");
      return `<tr data-row data-dir="${e.direction}" data-doc="${esc(docFacet)}" data-search="${esc(search)}">
  <td class="date">${esc(shortDate(e.occurredAt))}</td>
  <td class="chapter">${esc(e.bookLabel)}</td>
  <td class="amt ${e.direction}">${sign}${esc(money(e.amountCents))}</td>
  <td class="who">${esc(e.counterparty ?? "—")}</td>
  <td class="purpose">${
    e.purpose
      ? esc(e.purpose)
      : e.direction === "internal"
        ? // Not a documentation gap: money moving between our own accounts, or
          // income already counted above arriving in the bank. Rendering the
          // accusatory placeholder here made complete rows look broken.
          `<span class="nopurpose">Money moved between our own accounts — nothing earned or spent</span>`
        : `<span class="nopurpose">No published explanation for this line</span>`
  }${contextHtml(e)}</td>
  <td>${esc(e.categoryLabel ?? "—")}${
    e.projectLabel || e.eventLabel
      ? `<span class="detail">${esc(e.projectLabel ?? e.eventLabel ?? "")}</span>`
      : ""
  }</td>
  <td>${rowChipsHtml(e)}</td>
</tr>`;
    })
    .join("");

  return `<section>
  <h2 class="sectionhead">Every line</h2>
  <p class="sectionsub">Not a summary — the actual transactions, one row each. Search a vendor, a purpose, a project, or an amount. Money moving between our own accounts is shown too, marked "not counted" so it can't quietly inflate a total.</p>
  <div class="toolbar">
    <input id="q" type="search" placeholder="Search vendor, purpose, project, amount…" aria-label="Search the ledger">
    <select id="dir" aria-label="Filter by direction">
      <option value="">In and out</option>
      <option value="out">Money out</option>
      <option value="in">Money in</option>
      <option value="internal">Not counted</option>
    </select>
    <select id="doc" aria-label="Filter by documentation">
      <option value="">Any documentation</option>
      <option value="receipt">Receipt attached</option>
      <option value="exception">Documented exception</option>
      <option value="undocumented">Undocumented</option>
    </select>
    <span class="count" id="rowcount"></span>
  </div>
  <div class="ledgerwrap">
    <table class="ledger">
      <thead><tr>
        <th class="date">Date</th><th class="chapter">Chapter</th><th class="amt">Amount</th><th>Paid to / from</th>
        <th>What it was for</th><th>Category</th><th>Record</th>
      </tr></thead>
      <tbody id="ledgerbody">${rows}</tbody>
    </table>
    <div class="emptyrow hidden" id="noresults">Nothing matches that search.</div>
  </div>
  ${
    s.entriesTruncated
      ? `<div class="note"><strong>This month has more lines than one page shows.</strong> The complete set is in the CSV below — it is never truncated.</div>`
      : ""
  }
  <p style="margin-top:16px">
    <a class="dl" href="${esc(ledgerPath(s.periodKey))}.csv" download>⬇ Download this month (CSV)</a>
    <a class="dl" href="${esc(ledgerPath(s.periodKey))}/giving.csv" download>⬇ Download the giving roll (CSV)</a>
  </p>
</section>`;
}

/**
 * THE GIVING ROLL — "find the minute you gave."
 *
 * The owner's ask, and the thing that makes the page personal rather than
 * institutional: a giver should be able to locate their own gift in the
 * public record and see it counted, without any giver being named.
 *
 * ── AND A WAY TO SAY "MINE ISN'T HERE" ───────────────────────────────────────
 * An invitation to look yourself up is also an invitation to fail to find
 * yourself, and that is a much worse experience than never having looked —
 * it turns "they're transparent" into "they lost my money." So the roll ends
 * with the three benign explanations (wrong month, unpublished month, a
 * pledge that settles on its own date) and a real address to write to.
 *
 * The benign reasons come FIRST, deliberately. Most people who can't find a
 * gift are looking in the wrong month, and telling them that costs nothing
 * and resolves it instantly. The email is for whoever it doesn't resolve.
 */
function givingRollHtml(s: PublicStatement): string {
  if (s.gifts.length === 0) return "";
  const rows = s.gifts
    .map(
      (g) => `<div class="rollrow">
  <span class="rollwhen">${esc(shortDate(g.occurredAt))} · ${esc(timeOfDay(g.occurredAt))}</span>
  <span><span class="rollamt">${esc(money(g.amountCents))}</span>
  <span class="rollmeta">${esc([g.method, g.designation, g.bookLabel].filter(Boolean).join(" · "))}</span></span>
</div>`,
    )
    .join("");
  return `<section>
  <h2 class="sectionhead">The giving roll</h2>
  <p class="sectionsub">Every gift received in ${esc(s.label)}, by the minute it arrived — and nothing else. No names, no amounts tied to a person, no way to work backwards to one. If you gave, you can find your gift here and see it counted.</p>
  <div class="roll">${rows}</div>
  ${missingGiftHtml(s.label)}
</section>`;
}

/**
 * "Don't see your gift?" — the recovery path.
 *
 * Written to be actionable rather than reassuring. It names the specific
 * month being viewed, because "check another month" is useless advice without
 * saying which month you are currently in.
 */
function missingGiftHtml(periodLabelText: string): string {
  const mailto = contactMailto(`Gift missing from the ${periodLabelText} finances page`);
  return `<div class="note missing">
  <strong>Don't see your gift?</strong> Three things usually explain it, and they're worth checking first:
  <ul class="misslist">
    <li><strong>It landed in a different month.</strong> A gift counts in the month it was received. One given in the last days of a month — or a card that took a day to settle — can sit in the month either side of ${esc(periodLabelText)}.</li>
    <li><strong>That month isn't published yet.</strong> We publish a month only after it's closed and reviewed, so the most recent weeks are usually not up here yet.</li>
    <li><strong>Recurring gifts charge on their own date</strong>, which may not be the day you first set them up.</li>
  </ul>
  <p class="missfoot">Still can't find it? Email <a href="${esc(mailto)}">${esc(PUBLIC_CONTACT_EMAIL)}</a> with the date and amount and we'll go looking — a real person reads it, and if we got something wrong we'll publish the correction. We'd genuinely rather hear from you than have the record be quietly wrong.</p>
</div>`;
}

/**
 * The corrections log.
 *
 * On a YEAR the rows have to name their month — "Central · revision 2" is
 * ambiguous across twelve of them, and an amendment log a reader can't place
 * in time is barely a log. On a month the label would be the same on every
 * row, so it's dropped.
 */
function amendmentsHtml(s: StatementCore, isYear: boolean): string {
  const all = s.books.flatMap((b) =>
    b.amendments.map((a) => ({ ...a, bookLabel: b.bookLabel, periodLabel: b.label })),
  );
  if (all.length === 0) return "";
  all.sort((a, b) => b.publishedAt - a.publishedAt);
  const rows = all
    .map(
      (a) => `<div class="amendrow">
  <div class="amendtop">
    <span>${esc(a.bookLabel)}${isYear ? ` · ${esc(a.periodLabel)}` : ""} · revision ${a.revision}</span>
    <span>${esc(longDate(a.publishedAt))}</span>
    ${a.reason ? `<span class="amendreason">${esc(AMENDMENT_REASON_LABELS[a.reason as AmendmentReason] ?? a.reason)}</span>` : ""}
  </div>
  ${a.note ? `<p class="amendnote">${esc(a.note)}</p>` : ""}
</div>`,
    )
    .join("");
  const noun = isYear ? "year" : "month";
  return `<section>
  <div class="amendbanner">${
    isYear
      ? `Some months in this year have been corrected since they were first published. Here is every change, and why.`
      : `This ${noun} has been corrected since it was first published. Here is every change, and why.`
  }</div>
  <h2 class="sectionhead" style="margin-top:24px">Corrections</h2>
  <p class="sectionsub">We publish our mistakes. When a ${noun} changes after publication, the change is dated, attributed, and explained here — the earlier version is never quietly overwritten.</p>
  <div class="amendlist">${rows}</div>
</section>`;
}

/** "1 line" / "4 lines". A disclosure that reads "1 lines" undercuts the
 *  carefulness the disclosure is trying to demonstrate. */
function lines(n: number): string {
  return `${n} ${n === 1 ? "line" : "lines"}`;
}

function disclosuresHtml(s: StatementCore, totalBooks: number): string {
  const notes: string[] = [];
  if (s.reconstructedCount > 0) {
    const was = s.reconstructedCount === 1 ? "was" : "were";
    notes.push(
      `<div class="note"><strong>${lines(s.reconstructedCount)} (${esc(money(s.reconstructedCents))}) ${was} rebuilt from records after the fact</strong>, not captured as they happened. They're real transactions reconstructed from statements and receipts we still had, and they're marked "Rebuilt" in the table so you can tell them apart from money we watched move in real time.</div>`,
    );
  }
  if (s.undocumentedCount > 0) {
    const one = s.undocumentedCount === 1;
    notes.push(
      `<div class="note"><strong>${lines(s.undocumentedCount)} (${esc(money(s.undocumentedCents))}) ${one ? "has" : "have"} no receipt on file</strong> and no approved written explanation of why not. We're publishing ${one ? "it" : "them"} anyway. Hiding ${one ? "it" : "them"} until the paperwork caught up would mean publishing a version of the month that wasn't true.</div>`,
    );
  }
  // Reports `unexplainedCount`, NOT `uncodedCount`. The second is what our
  // policy required; the first is what a reader can see. On a pre-policy month
  // they differ completely — every row is grandfathered (uncoded 0) and every
  // row is unexplained — and reporting the policy number there would leave the
  // page silent about its most visible property.
  if (s.unexplainedCount > 0) {
    const one = s.unexplainedCount === 1;
    const most = s.entryCount > 0 && s.unexplainedCount / s.entryCount >= 0.5;
    notes.push(
      `<div class="note"><strong>${lines(s.unexplainedCount)} (${esc(money(s.unexplainedCents))}) publish${one ? "es" : ""} with no written explanation of what ${one ? "it was" : "they were"} for.</strong> ${one ? "That row shows" : "Those rows show"} the vendor, the amount and the category, and ${one ? "says" : "say"} so plainly rather than guessing at a reason after the fact.${
        most
          ? " That's most of this month, and it's because this period predates the rule: every charge is now required to carry a written purpose — who it was for and why — before it can be closed. Older months are the honest record of how we used to work."
          : " Every charge is now required to carry one before it can be closed."
      }</div>`,
    );
  }
  if (s.books.length < totalBooks) {
    // "Chapter," not "book" — a stranger doesn't know the accounting term
    // for what they're reading (founder directive, 2026-08-12). The value
    // (`bookLabel`) is unchanged; only the sentence around it is.
    const one = s.books.length === 1;
    const chapterNames = [...new Set(s.books.map((b) => b.bookLabel))].join(", ");
    notes.push(
      `<div class="note"><strong>${s.books.length} of our ${totalBooks} chapters ${one ? "has" : "have"} published</strong> (${esc(chapterNames)}) — the totals above cover ${one ? "that chapter" : "those chapters"} only.</div>`,
    );
  }
  return notes.join("");
}

function howToReadHtml(): string {
  return `<section>
  <h2 class="sectionhead">How to read this</h2>
  <p class="sectionsub">The honest answers to the questions this page should raise.</p>

  <details class="faq"><summary>Is this live?</summary>
  <p>No, and that's deliberate. Each month is closed, reviewed by someone who didn't prepare it, and then published. What you're reading is exactly what was approved — frozen, so it can't be edited afterwards without you seeing that it was.</p>
  <p>If we get something wrong, we don't quietly fix it. We publish a correction with a date, a reason, and an explanation, and the earlier version stays on the record. Those show up under "Corrections."</p></details>

  <details class="faq"><summary>Why don't the lines add up to the total?</summary>
  <p>They do — but only the lines marked as counting. Money moving between two of our own accounts, and the bank deposit that carries gifts you already see counted above, are shown for completeness and marked "Not counted." Adding them would count the same dollar twice.</p>
  <p>Income is counted when it's given, not when it clears. A gift on the 31st belongs to that month even if the deposit lands in the next one.</p></details>

  <details class="faq"><summary>Why are there no names?</summary>
  <p>Nobody is named on this page — not givers, not the people at a meal we paid for. Givers didn't sign up for a public financial record, and some of the people we feed are minors. So a meal publishes as "12 people — 5 team members, 7 community members," which answers who it was for without publishing a person.</p>
  <p>Compensation is the one place we name a role rather than hide behind the rule: "Who gets paid," near the top of this page, lists every position we have and what it's paid — by position, never by person.</p></details>

  <details class="faq"><summary>What has to be true before a line publishes?</summary>
  <p>For anything spent from here on: a receipt, and a written explanation of what it was for — who was at the meal and how many, where a trip went from and to. That's the IRS substantiation standard, and we hold ourselves to it because it's also just the answer a giver deserves.</p>
  <p>Older spending predates that policy. Where a line is missing a receipt or an explanation, this page says so on the line and in the notes above rather than leaving a blank you'd have to notice.</p></details>

  <details class="faq"><summary>Who decides what gets published?</summary>
  <p>One person prepares the month; a different person reviews and publishes it. The system refuses a self-approval unless a single named operator is running the org, and it records which of the two happened for every month published.</p></details>

  <details class="faq"><summary>I think something here is wrong. What do I do?</summary>
  <p>Tell us. Email <a href="${esc(contactMailto("Something looks wrong on the finances page"))}">${esc(PUBLIC_CONTACT_EMAIL)}</a> with what you're looking at and what looks off — a missing gift, a line that doesn't make sense, a number that doesn't add up.</p>
  <p>A real person reads it. If we got something wrong, the fix is a published correction with our explanation attached, not a quiet edit — so reporting it puts the record right in public, where the mistake was.</p></details>
</section>`;
}

// ── Pages ────────────────────────────────────────────────────────────────────

/**
 * The statement page for one month.
 *
 * `opts.preview` is the publish console's "see the full page before you
 * commit" mode (`http.ts`'s `?preview=<token>` route): it stamps the fixed
 * PREVIEW banner + `noindex` (via `shell`) and drops the period picker,
 * whose form would otherwise offer to navigate to a neighboring month that
 * likely isn't published yet — the simplest way to not invite a 404 rather
 * than teaching the picker a second, preview-aware mode. Omitted, this
 * function's output is byte-identical to before `opts` existed.
 *
 * `headcount` is required, not defaulted: a caller that forgot to wire it
 * would otherwise publish a confident grid of zero-holder positions, which is
 * a false statement about the org rather than a missing feature.
 */
export function renderLedgerPage(
  statement: PublicStatement,
  months: PublishedMonth[],
  years: PublishedYear[],
  totalBooks: number,
  headcount: PositionHeadcount,
  opts: { preview?: boolean } = {},
): string {
  const preview = opts.preview ?? false;
  const body = `
<div class="hero">
  <h1 class="title serif">Where the money goes</h1>
  <p class="lede">Every dollar Public Worship received and spent in <strong>${esc(statement.label)}</strong> — not a summary of it. Each line shows what we bought, who we bought it from, what it was for, and whether we can produce the receipt.</p>
</div>
${
  preview
    ? ""
    : periodPickerHtml({
        years,
        months,
        selectedYear: statement.periodKey.slice(0, 4),
        selectedMonth: statement.periodKey.slice(5, 7),
      })
}
${statsHtml(statement)}
${compensationHtml(headcount)}
${disclosuresHtml(statement, totalBooks)}
${amendmentsHtml(statement, false)}
${incomeHtml(statement)}
${expenseHtml(statement)}
${budgetsHtml(statement, false)}
${ledgerHtml(statement)}
${givingRollHtml(statement)}
${howToReadHtml()}
<footer>
  <p>Published ${esc(
    statement.books
      .map((b) => `${b.bookLabel} on ${longDate(b.publishedAt)}`)
      .join(" · "),
  )}.</p>
  <p style="margin-top:8px">Something here look wrong? Email <a href="${esc(contactMailto(`Question about the ${statement.label} finances page`))}">${esc(PUBLIC_CONTACT_EMAIL)}</a>. We'd rather publish a correction than be right by accident.</p>
</footer>`;

  return shell({
    title: `${statement.label} finances · Public Worship`,
    description: `Every transaction Public Worship made in ${statement.label}: ${money(statement.incomeCents)} in, ${money(statement.expenseCents)} out, published line by line.`,
    canonicalPath: ledgerPath(statement.periodKey),
    body,
    preview,
  });
}

/**
 * THE YEAR ROLLUP — the annual-report shape, built only from published months.
 *
 * Summary-level on purpose. A year is thousands of lines, and putting them all
 * into the most-shared URL on the site would make it the slowest page for a
 * table nobody scrolls to the end of. The lines are one click away in each
 * month, and complete in the year CSV — both of which this page says out loud
 * rather than leaving a reader to wonder where the detail went.
 *
 * The months that contributed are listed and linked. A year missing four
 * months must never read like a whole one, and the only reliable way to
 * prevent that is to show the reader which months they are looking at.
 */
export function renderLedgerYearPage(
  statement: PublicYearStatement,
  months: PublishedMonth[],
  years: PublishedYear[],
  totalBooks: number,
  headcount: PositionHeadcount,
): string {
  const monthLinks = statement.months
    .map(
      (key) =>
        `<a class="monthchip" href="${esc(ledgerPath(key))}">${esc(periodLabel(key))}</a>`,
    )
    .join("");
  const complete = statement.months.length === 12;

  const body = `
<div class="hero">
  <h1 class="title serif">Where the money goes</h1>
  <p class="lede">Everything Public Worship received and spent in <strong>${esc(statement.label)}</strong>, added up from the months we've published. Pick a month to read it transaction by transaction.</p>
</div>
${periodPickerHtml({ years, months, selectedYear: statement.year, selectedMonth: "" })}
${statsHtml(statement)}
${compensationHtml(headcount)}
<div class="note"><strong>${statement.months.length} of 12 months published for ${esc(statement.label)}.</strong> ${
    complete
      ? "This is the complete year."
      : "The totals above cover only those months — nothing here is estimated or filled in for the rest."
  }</div>
${disclosuresHtml(statement, totalBooks)}
${amendmentsHtml(statement, true)}
${incomeHtml(statement)}
${expenseHtml(statement)}
${budgetsHtml(statement, true)}
<section>
  <h2 class="sectionhead">Every line, month by month</h2>
  <p class="sectionsub">A year is thousands of transactions, so they live in the months rather than on one page. Open any month to search it line by line — or take the whole year as a spreadsheet.</p>
  <nav class="months">${monthLinks}</nav>
  <p style="margin-top:16px">
    <a class="dl" href="${esc(ledgerPath(statement.year))}.csv" download>⬇ Download all of ${esc(statement.label)} (CSV)</a>
  </p>
</section>
${howToReadHtml()}
<footer>
  <p>Built from ${statement.months.length} published month${statement.months.length === 1 ? "" : "s"}. Each one was reviewed and frozen on its own; this page only adds them up.</p>
  <p style="margin-top:8px">Something here look wrong? Email <a href="${esc(contactMailto(`Question about the ${statement.label} finances page`))}">${esc(PUBLIC_CONTACT_EMAIL)}</a>. We'd rather publish a correction than be right by accident.</p>
</footer>`;

  return shell({
    title: `${statement.label} finances · Public Worship`,
    description: `Public Worship's ${statement.label}: ${money(statement.incomeCents)} raised, ${money(statement.expenseCents)} spent, across ${statement.months.length} published months.`,
    canonicalPath: ledgerPath(statement.year),
    body,
  });
}

/** Shown when a month has nothing published — including `/finances` itself
 *  before the first month ever goes out. Says which months DO exist rather
 *  than dead-ending, and explains the process instead of apologising. */
export function renderLedgerEmpty(
  months: PublishedMonth[],
  years: PublishedYear[],
  requested?: string,
): string {
  const heading = requested
    ? `${requested.length === 4 ? requested : periodLabel(requested)} hasn't been published yet`
    : `Nothing published yet`;
  const body = `
<div class="hero">
  <h1 class="title serif">Where the money goes</h1>
  <p class="lede">We publish our finances month by month — every transaction, across every chapter, what it was for, and whether we can produce the receipt.</p>
</div>
${
  years.length > 0
    ? periodPickerHtml({
        years,
        months,
        selectedYear: (requested ?? years[0].year).slice(0, 4),
        selectedMonth: requested && requested.length === 7 ? requested.slice(5, 7) : "",
      })
    : ""
}
<div class="empty">
  <h2>${esc(heading)}</h2>
  <p>A month goes up once it's closed, reviewed by someone who didn't prepare it, and approved. ${
    months.length > 0
      ? "The months above are published and ready to read."
      : "The first month will appear here as soon as it clears that review."
  }</p>
</div>
${howToReadHtml()}`;
  return shell({
    title: "Finances · Public Worship",
    description:
      "Public Worship publishes its finances month by month — every transaction, across every chapter, what it was for, and whether there's a receipt.",
    canonicalPath: requested ? ledgerPath(requested) : ledgerPath(),
    body,
  });
}
