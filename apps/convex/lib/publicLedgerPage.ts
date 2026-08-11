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
 * the Sunday setup team, 12 people" — can see their own $5 in it. So the page
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
  DOCUMENTATION_STATE_LABELS,
  EXPENSE_TYPE_LABELS,
  formatAffiliationMix,
  formatCents,
  INCOME_STREAM_BLURBS,
  INCOME_STREAM_LABELS,
  periodLabel,
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

export type PublicStatement = {
  periodKey: string;
  label: string;
  incomeCents: number;
  expenseCents: number;
  netCents: number;
  incomeByStream: { stream: IncomeStream; cents: number; count: number }[];
  expenseByCategory: { label: string; cents: number; count: number }[];
  expenseByProject: { label: string; cents: number; count: number }[];
  reconstructedCount: number;
  reconstructedCents: number;
  undocumentedCount: number;
  undocumentedCents: number;
  uncodedCount: number;
  uncodedCents: number;
  entryCount: number;
  giftCount: number;
  entriesTruncated: boolean;
  books: {
    bookLabel: string;
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

export type PublishedMonth = {
  periodKey: string;
  label: string;
  publishedAt: number;
  bookCount: number;
};

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

function shell(opts: {
  title: string;
  description: string;
  body: string;
  canonicalPath: string;
}): string {
  const url = `${siteUrl()}${opts.canonicalPath}`;
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
<meta name="twitter:card" content="summary">
${FAVICON}${FONTS}
<style>${BASE_CSS}${LEDGER_CSS}</style>
</head><body>
<main>
<div class="topbar">
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

function monthPickerHtml(months: PublishedMonth[], current: string): string {
  if (months.length === 0) return "";
  const chips = months
    .map(
      (m) =>
        `<a class="monthchip${m.periodKey === current ? " on" : ""}" href="${esc(
          ledgerPath(m.periodKey),
        )}">${esc(m.label)}</a>`,
    )
    .join("");
  return `<nav class="months" aria-label="Published months">${chips}</nav>`;
}

function statsHtml(s: PublicStatement): string {
  // The third figure is called "Difference," not "Surplus" or "Profit." A
  // church running a deliberate deficit out of reserves in a given month has
  // not lost anything, and a month that happens to end up ahead has not
  // earned a profit. "Difference" is the only word that is true in both
  // directions without editorializing.
  const netLabel = s.netCents >= 0 ? "More in than out" : "More out than in";
  return `<div class="stats">
  <div class="stat in"><div class="k">Money in</div><div class="v">${esc(money(s.incomeCents))}</div>
    <div class="sub">${s.giftCount.toLocaleString()} gift${s.giftCount === 1 ? "" : "s"} and other income</div></div>
  <div class="stat out"><div class="k">Money out</div><div class="v">${esc(money(s.expenseCents))}</div>
    <div class="sub">${s.entryCount.toLocaleString()} line${s.entryCount === 1 ? "" : "s"} published</div></div>
  <div class="stat net"><div class="k">Difference</div><div class="v">${esc(money(Math.abs(s.netCents)))}</div>
    <div class="sub">${esc(netLabel)}</div></div>
</div>`;
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

function incomeHtml(s: PublicStatement): string {
  if (s.incomeByStream.length === 0) return "";
  const rows = s.incomeByStream.map((r) => ({
    label: INCOME_STREAM_LABELS[r.stream],
    cents: r.cents,
    count: r.count,
    blurb: INCOME_STREAM_BLURBS[r.stream],
  }));
  return `<section>
  <h2 class="sectionhead">Where it came from</h2>
  <p class="sectionsub">Counted when the money was given, not when it reached the bank — so a gift on the last Sunday of the month belongs to that month even if the deposit lands the following week.</p>
  <div class="bars">${barRowsHtml(rows, true)}</div>
</section>`;
}

function expenseHtml(s: PublicStatement): string {
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

/** The per-row chips: documentation state, rebuilt history, charged-not-chosen
 *  fees, and internal movements. Each one exists so a reader can tell rows
 *  apart that would otherwise look identical and mean different things. */
function rowChipsHtml(e: PublicLedgerEntry): string {
  const chips: string[] = [];
  if (e.documentation) {
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
      return `<tr data-row data-dir="${e.direction}" data-doc="${esc(e.documentation ?? "")}" data-search="${esc(search)}">
  <td class="date">${esc(shortDate(e.occurredAt))}</td>
  <td class="amt ${e.direction}">${sign}${esc(money(e.amountCents))}</td>
  <td class="who">${esc(e.counterparty ?? "—")}<span class="detail">${esc(e.bookLabel)}</span></td>
  <td class="purpose">${
    e.purpose
      ? esc(e.purpose)
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
        <th class="date">Date</th><th class="amt">Amount</th><th>Paid to / from</th>
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
  <p class="sectionsub">Every gift received this month, by the minute it arrived — and nothing else. No names, no amounts tied to a person, no way to work backwards to one. If you gave, you can find your gift here and see it counted.</p>
  <div class="roll">${rows}</div>
</section>`;
}

function amendmentsHtml(s: PublicStatement): string {
  const all = s.books.flatMap((b) =>
    b.amendments.map((a) => ({ ...a, bookLabel: b.bookLabel })),
  );
  if (all.length === 0) return "";
  all.sort((a, b) => b.publishedAt - a.publishedAt);
  const rows = all
    .map(
      (a) => `<div class="amendrow">
  <div class="amendtop">
    <span>${esc(a.bookLabel)} · revision ${a.revision}</span>
    <span>${esc(longDate(a.publishedAt))}</span>
    ${a.reason ? `<span class="amendreason">${esc(AMENDMENT_REASON_LABELS[a.reason as AmendmentReason] ?? a.reason)}</span>` : ""}
  </div>
  ${a.note ? `<p class="amendnote">${esc(a.note)}</p>` : ""}
</div>`,
    )
    .join("");
  return `<section>
  <div class="amendbanner">This month has been corrected since it was first published. Here is every change, and why.</div>
  <h2 class="sectionhead" style="margin-top:24px">Corrections</h2>
  <p class="sectionsub">We publish our mistakes. When a month changes after publication, the change is dated, attributed, and explained here — the earlier version is never quietly overwritten.</p>
  <div class="amendlist">${rows}</div>
</section>`;
}

/** "1 line" / "4 lines". A disclosure that reads "1 lines" undercuts the
 *  carefulness the disclosure is trying to demonstrate. */
function lines(n: number): string {
  return `${n} ${n === 1 ? "line" : "lines"}`;
}

function disclosuresHtml(s: PublicStatement, totalBooks: number): string {
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
  if (s.uncodedCount > 0) {
    const one = s.uncodedCount === 1;
    notes.push(
      `<div class="note"><strong>${lines(s.uncodedCount)} (${esc(money(s.uncodedCents))}) ${one ? "has" : "have"} no approved explanation of what ${one ? "it was" : "they were"} for.</strong> ${one ? "That row shows" : "Those rows show"} the vendor and the amount and ${one ? "says" : "say"} so plainly rather than guessing. Every charge from here on is required to carry an explanation before it can be closed.</div>`,
    );
  }
  if (s.books.length < totalBooks) {
    notes.push(
      `<div class="note"><strong>${s.books.length} of our ${totalBooks} books have published this month</strong> (${esc(s.books.map((b) => b.bookLabel).join(", "))}). The totals above cover those books only.</div>`,
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
  <p>Salaries are a different question, and the answer is that we intend to publish them by position rather than by person — the same way public offices publish theirs. Today nobody at Public Worship is paid.</p></details>

  <details class="faq"><summary>What has to be true before a line publishes?</summary>
  <p>For anything spent from here on: a receipt, and a written explanation of what it was for — who was at the meal and how many, where a trip went from and to. That's the IRS substantiation standard, and we hold ourselves to it because it's also just the answer a giver deserves.</p>
  <p>Older spending predates that policy. Where a line is missing a receipt or an explanation, this page says so on the line and in the notes above rather than leaving a blank you'd have to notice.</p></details>

  <details class="faq"><summary>Who decides what gets published?</summary>
  <p>One person prepares the month; a different person reviews and publishes it. The system refuses a self-approval unless a single named operator is running the org, and it records which of the two happened for every month published.</p></details>
</section>`;
}

// ── Pages ────────────────────────────────────────────────────────────────────

/** The statement page for one month. */
export function renderLedgerPage(
  statement: PublicStatement,
  months: PublishedMonth[],
  totalBooks: number,
): string {
  const body = `
<div class="hero">
  <h1 class="title serif">Where the money goes</h1>
  <p class="lede">Every dollar Public Worship received and spent in <strong>${esc(statement.label)}</strong> — not a summary of it. Each line shows what we bought, who we bought it from, what it was for, and whether we can produce the receipt.</p>
</div>
${monthPickerHtml(months, statement.periodKey)}
${statsHtml(statement)}
${disclosuresHtml(statement, totalBooks)}
${amendmentsHtml(statement)}
${incomeHtml(statement)}
${expenseHtml(statement)}
${ledgerHtml(statement)}
${givingRollHtml(statement)}
${howToReadHtml()}
<footer>
  <p>Published ${esc(
    statement.books
      .map((b) => `${b.bookLabel} on ${longDate(b.publishedAt)}`)
      .join(" · "),
  )}.</p>
  <p style="margin-top:8px">Something here look wrong? Tell us — <a href="/give">get in touch</a>. We'd rather publish a correction than be right by accident.</p>
</footer>`;

  return shell({
    title: `${statement.label} finances · Public Worship`,
    description: `Every transaction Public Worship made in ${statement.label}: ${money(statement.incomeCents)} in, ${money(statement.expenseCents)} out, published line by line.`,
    canonicalPath: ledgerPath(statement.periodKey),
    body,
  });
}

/** Shown when a month has nothing published — including `/finances` itself
 *  before the first month ever goes out. Says which months DO exist rather
 *  than dead-ending, and explains the process instead of apologising. */
export function renderLedgerEmpty(
  months: PublishedMonth[],
  requested?: string,
): string {
  const heading = requested
    ? `${periodLabel(requested)} hasn't been published yet`
    : `Nothing published yet`;
  const body = `
<div class="hero">
  <h1 class="title serif">Where the money goes</h1>
  <p class="lede">We publish our books month by month — every transaction, what it was for, and whether we can produce the receipt.</p>
</div>
${monthPickerHtml(months, requested ?? "")}
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
      "Public Worship publishes its books month by month — every transaction, what it was for, and whether there's a receipt.",
    canonicalPath: requested ? ledgerPath(requested) : ledgerPath(),
    body,
  });
}
