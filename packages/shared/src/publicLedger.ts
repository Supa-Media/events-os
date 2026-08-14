/**
 * The public ledger's vocabulary — the shared half of "publish the books."
 *
 * Public Worship publishes every transaction. The pieces that make that
 * possible already existed before this module did: `transactionCodings`
 * carries the §274(d) substantiation and an approver's `publicPurpose`
 * rewrite, `historicalImportBatch` marks rows rebuilt from spreadsheets
 * rather than watched, and `publishability.report` counts what still stands
 * between a period and publication. What was missing was the ACT of
 * publishing — and the promise that comes with it.
 *
 * ── THE PROMISE: WHAT IS PUBLISHED IS WHAT WAS APPROVED ──────────────────────
 * The public page does NOT read the live books. A period is FROZEN at the
 * moment it is published (`financePublicationEntries`), and that frozen copy
 * is what the world sees, forever. This is the single most important decision
 * in the design, and it is not a caching strategy:
 *
 *   - A live page means an edit made after approval silently rewrites the
 *     public record. Nobody outside can tell it happened. That is precisely
 *     the property a transparency page exists to deny.
 *   - A frozen page means a correction has to be PUBLISHED, as revision N+1,
 *     with a stated reason — and revision N stays readable beside it.
 *
 * So "we made a mistake" becomes a visible, dated, attributed amendment
 * instead of a silent diff. An org that shows its corrections is more
 * believable than one that has never appeared to make any.
 *
 * ── WHY MONTHLY ──────────────────────────────────────────────────────────────
 * A month is the unit the close already runs on (`publishability.report`
 * buckets by month, budgets bucket by month, the reconcile queue is worked
 * monthly). Publishing on any other cadence would mean inventing a second
 * period concept that drifts from the first one.
 *
 * Vocabulary lives here rather than in `apps/convex` so the Convex schema,
 * the server-rendered public page, the mobile publish console, and the tests
 * cannot drift on what a status means or what a column is called.
 */
import { formatCents } from "./finance";
import {
  SEAT_CHARTS,
  seatChartOrder,
  type SeatChart,
  type SeatId,
} from "./seats";

// ── Period keys ──────────────────────────────────────────────────────────────
// A publication is identified by `YYYY-MM` in the finance timezone
// (America/New_York — `FINANCE_TIMEZONE` in `./finance`). Stored as a string
// rather than a (year, month) pair because it is a URL segment
// (`/finances/2026-08`), a sort key, and a dedup key, and a string is all
// three without a composite index or a zero-padding bug at every call site.

/** `2026-08` for (2026, 8). Month is 1-based. */
export function periodKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** The (year, month) a `YYYY-MM` key names, or `null` if it isn't one.
 *  Strict on purpose: this parses URL input, so `2026-13` and `2026-8` are
 *  both rejected rather than coerced into something plausible. */
export function parsePeriodKey(
  key: string,
): { year: number; month: number } | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(key);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]) };
}

/** "August 2026" — the human name of a period key. Returns the key unchanged
 *  if it isn't parseable, so a display path can never throw on bad data. */
export function periodLabel(key: string): string {
  const parsed = parsePeriodKey(key);
  if (!parsed) return key;
  const name = new Date(Date.UTC(parsed.year, parsed.month - 1, 1)).toLocaleString(
    "en-US",
    { month: "long", timeZone: "UTC" },
  );
  return `${name} ${parsed.year}`;
}

// ── Year keys ────────────────────────────────────────────────────────────────
// The public page also rolls a whole YEAR up (`/finances/2026`), which is the
// shape an annual report takes. A year is NOT its own publication — it is the
// published months of that year, added together, and the page says which
// months those were. Nothing is ever published at year granularity, so there
// is no way for a year total to claim more than the months behind it.

/** The 4-digit year a key names, or `null`. Strict, for the same reason
 *  `parsePeriodKey` is: this parses public URL input. The window is
 *  deliberately narrow — a "year" outside it is a typo or a probe, not a
 *  period anyone is asking about. */
export function parseYearKey(key: string): number | null {
  if (!/^\d{4}$/.test(key)) return null;
  const year = Number(key);
  return year >= 2000 && year <= 2200 ? year : null;
}

/** The `YYYY-MM` keys of a year, January first. Drives the month dropdown. */
export function monthsOfYear(year: number): string[] {
  return Array.from({ length: 12 }, (_v, i) => periodKey(year, i + 1));
}

/** "August" — the month name alone, for the month dropdown (the year is
 *  already chosen in the dropdown beside it). */
export function monthName(month: number): string {
  return new Date(Date.UTC(2000, month - 1, 1)).toLocaleString("en-US", {
    month: "long",
    timeZone: "UTC",
  });
}

/** The period key immediately before `key`, or `null` if unparseable. Used to
 *  find the prior published month for the opening-balance line. */
export function previousPeriodKey(key: string): string | null {
  const parsed = parsePeriodKey(key);
  if (!parsed) return null;
  return parsed.month === 1
    ? periodKey(parsed.year - 1, 12)
    : periodKey(parsed.year, parsed.month - 1);
}

// ── Publication lifecycle ────────────────────────────────────────────────────
/**
 * Where a period's statement sits.
 *
 * The unusual member is `amending`, and it is the reason this is one enum
 * rather than a boolean pair. While a correction is being prepared, the
 * ALREADY-PUBLISHED revision stays live — the public keeps seeing the last
 * approved numbers, not a half-edited draft and not a gap. `liveRevision` on
 * the publication row is what the page reads; this status describes the
 * WORKING copy, which is a different question.
 *
 *   draft             → being assembled. Never public.
 *   in_review         → submitted; waiting on a `finance.publish` holder.
 *   changes_requested → sent back with a note. Same "never public" as draft.
 *   published         → the working copy IS the live copy. Nothing in flight.
 *   amending          → a correction is being prepared; revision N stays live.
 *
 * A publication that has never been published has no `liveRevision`, so
 * `draft`/`in_review`/`changes_requested` mean "not yet public." The same
 * three statuses on a publication WITH a `liveRevision` mean "a correction is
 * in flight," which is why `amending` exists to start that loop explicitly
 * rather than being inferred from a status that would otherwise be ambiguous
 * about whether anything is currently visible.
 */
export const PUBLICATION_STATUSES = [
  "draft",
  "in_review",
  "changes_requested",
  "published",
  "amending",
] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

export const PUBLICATION_STATUS_LABELS: Record<PublicationStatus, string> = {
  draft: "Draft",
  in_review: "In review",
  changes_requested: "Changes requested",
  published: "Published",
  amending: "Amending",
};

/** The statuses from which a preparer may (re)build the working snapshot. A
 *  `published` period is frozen — starting an amendment is what unfreezes it,
 *  and that is a deliberate, logged act. */
export const REBUILDABLE_STATUSES: readonly PublicationStatus[] = [
  "draft",
  "changes_requested",
  "amending",
];

/** The statuses a preparer may submit for review from. */
export const SUBMITTABLE_STATUSES: readonly PublicationStatus[] = [
  "draft",
  "changes_requested",
  "amending",
];

/** True iff the public page has something to show for this publication. Note
 *  this is about `liveRevision`, NOT about `status` — an `amending` period is
 *  still publicly visible at its last approved revision. */
export function hasLiveRevision(pub: {
  liveRevision?: number | null;
}): boolean {
  return (pub.liveRevision ?? 0) > 0;
}

// ── Income streams ───────────────────────────────────────────────────────────
/**
 * How money came IN, in the public breakdown's own words.
 *
 * These mirror the book-value revenue model exactly
 * (`reconciliation.ts#computeBookBalances` phase 1) so the public page and the
 * internal accounts page can never quote different totals for the same month:
 * gifts, in-person sales, ticket orders, project registrations — each counted
 * ONCE at the layer that earned it — plus the ledger inflows that aren't the
 * bank arrival of any of those.
 *
 * `other` is deliberately last and deliberately vague-sounding: it is the
 * honest bucket for interest, refunds of prior-period spend, and miscellaneous
 * credits, and a page that invented a confident-sounding label for it would be
 * overclaiming.
 */
export const INCOME_STREAMS = [
  "giving",
  "tickets",
  "sales",
  "registrations",
  "other",
] as const;
export type IncomeStream = (typeof INCOME_STREAMS)[number];

/**
 * PUBLIC WORSHIP IS NOT A CHURCH, and these labels are the place that is
 * easiest to get wrong (owner correction, 2026-08-11). No "tithes," no
 * "offerings," no "congregation" — money that was given is a GIFT, and money
 * that was paid for something is a SALE. The distinction the streams draw is
 * what was sold, not who we are.
 */
export const INCOME_STREAM_LABELS: Record<IncomeStream, string> = {
  giving: "Gifts",
  tickets: "Ticket sales",
  // The `sales` table holds merch alongside snacks, drinks and books, so the
  // label has to cover all of it — "Merch sales" alone would silently
  // misattribute the rest.
  sales: "Merch & other sales",
  registrations: "Program registrations",
  other: "Other income",
};

export const INCOME_STREAM_BLURBS: Record<IncomeStream, string> = {
  giving:
    "Money given to support the work — recurring, one-time, and in-kind. Counted when the gift is received, not when the money reaches the bank.",
  tickets: "Paid tickets to events we hosted.",
  sales: "Merch, books, coffee — anything sold in person.",
  registrations: "Fees for classes, cohorts and courses.",
  other:
    "Interest, refunds of money spent in an earlier month, and credits that don't belong to any stream above.",
};

// ── Documentation state ──────────────────────────────────────────────────────
// Deliberately NOT redefined here. A published row's documentation state is
// `DOCUMENTATION_STATES` from `./finance` — the same three values the
// reconcile grid, the receipt chase and `publishability.report` already speak
// (`receipt` / `exception` / `undocumented`). A public-only copy of that
// vocabulary would be a second place for "does an approved exception count as
// documented?" to be answered, and the two would eventually disagree in
// public.

// ── The published row's columns ──────────────────────────────────────────────
/**
 * The CSV header, in order — and by construction the table's columns too.
 *
 * One list, because the owner's ask was explicit: the download and the page
 * are "literally just the same thing as the CSV." A second list would drift
 * the first time a column was added to one of them.
 *
 * ATTENDEE NAMES ARE NOT HERE AND NEVER WILL BE. Members and guests did not
 * consent to a public financial record, and some are minors (owner decision,
 * 2026-08-08 — see `schema/finances.ts#transactionCodings`). The public row
 * carries the headcount and the affiliation mix instead: "12 people — 5 team,
 * 7 community members" answers the accountability question ("who was this
 * for?") without publishing a person.
 */
export const PUBLIC_LEDGER_COLUMNS = [
  "Date",
  "Direction",
  "Amount",
  "Paid to / received from",
  "Purpose",
  "Category",
  "Fund",
  "Budget",
  "Project",
  "Event",
  // Renamed from "Book" 2026-08-12 (founder directive): a stranger reads
  // "chapter," not the internal accounting term for a set of books. The
  // value underneath is unchanged — every `financePublicationEntries` row
  // has carried a frozen `bookLabel` ("Central" / chapter name) since the
  // table's inception, so this is a header rename only, no data migration.
  "Chapter",
  "Expense type",
  "Travel from",
  "Travel to",
  "People",
  "Who was there",
  "Documentation",
  "Record type",
] as const;

/** The gift roll's CSV header. A separate, much narrower list — the roll is
 *  anonymous by construction and has no donor-bearing column to forget to
 *  remove. */
export const PUBLIC_GIFT_COLUMNS = [
  "Date",
  "Amount",
  "Method",
  "Designation",
  // Renamed from "Book" 2026-08-12 — see `PUBLIC_LEDGER_COLUMNS` above.
  "Chapter",
] as const;

/** Render an affiliation mix as the sentence the public row prints:
 *  `{team: 5, community_member: 7}` → "5 team members, 7 community members".
 *  Empty/absent → `null`, so a caller can tell "nobody recorded" from "zero". */
export function formatAffiliationMix(
  mix: Record<string, number> | null | undefined,
  labels: Record<string, string>,
): string | null {
  if (!mix) return null;
  const parts = Object.entries(mix)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => {
      const label = (labels[key] ?? key).toLowerCase();
      return `${n} ${n === 1 ? label : pluralizeAffiliation(label)}`;
    });
  return parts.length > 0 ? parts.join(", ") : null;
}

/** "team member" → "team members". Only ever sees the fixed
 *  `ATTENDEE_AFFILIATION_LABELS` values, none of which are irregular. */
function pluralizeAffiliation(label: string): string {
  return label.endsWith("s") ? label : `${label}s`;
}

// ── Gift methods, in public words ────────────────────────────────────────────
/**
 * How a gift arrived, as the public roll prints it.
 *
 * Keyed by `string` rather than by `GIFT_METHODS` because that tuple lives in
 * `apps/convex/schema/givingPlatform.ts`, which this package cannot import
 * (shared is the leaf). `publicGiftMethodLabel` falls back to the raw literal,
 * so a method added there and forgotten here degrades to a slightly ugly label
 * instead of an empty cell — and a published row keeps rendering forever
 * regardless of what that tuple does later.
 *
 * The labels are the GIVER's-eye view, not the processor's: "Card" rather
 * than "stripe", because a reader of these books is being told how the money
 * came in, not which vendor cleared it.
 */
export const PUBLIC_GIFT_METHOD_LABELS: Record<string, string> = {
  stripe: "Card",
  givebutter: "Card",
  cash: "Cash",
  check: "Check",
  wire: "Bank transfer",
  zelle: "Zelle",
  venmo: "Venmo",
  cash_app: "Cash App",
  in_kind: "In-kind",
  other: "Other",
};

/** `PUBLIC_GIFT_METHOD_LABELS` with a readable fallback. */
export function publicGiftMethodLabel(method: string): string {
  return (
    PUBLIC_GIFT_METHOD_LABELS[method] ??
    method.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())
  );
}

// ── Compensation ─────────────────────────────────────────────────────────────
/**
 * What the page says about who gets paid — and the SHAPE it says it in.
 *
 * ⚠ THIS IS A CLAIM ABOUT THE PRESENT AND IT CAN GO STALE. ⚠ The moment one
 * person at Public Worship draws a salary, an honorarium, or a fee, every tile
 * still reading "Volunteer" is a false statement — on a public page whose
 * entire argument is that it does not say false things. There is no way to
 * derive this from the ledger (the schema has no notion of compensation, and
 * matching on category names would be a guess), so it is a stated fact with a
 * human behind it.
 *
 * Two guards, since a constant can't check reality:
 *  - The publish console shows this back to the publisher every month, beside
 *    the other disclosures, BEFORE the button. Re-affirming it is part of
 *    publishing a month.
 *  - The Academy lesson lists it in the pre-publish checklist.
 *
 * ── THE PROMISE, AND THE GRID THAT KEEPS IT ──────────────────────────────────
 * The page used to make the forward-looking promise in prose — "when that
 * changes, we'll publish what people are paid by position rather than by
 * person." A promise about a FORMAT is worth much less than the format itself:
 * published the day it first costs something, a compensation disclosure reads
 * as something extracted under pressure, and a reader meets an unfamiliar
 * layout at the exact moment they are least inclined to be generous about it.
 *
 * So the grid publishes NOW, while every tile reads "Volunteer." The day
 * somebody is paid, the reader is not shown a new section — they are shown a
 * figure on a tile they have already read a dozen times, in a grid they
 * already trust. That is the whole design: this becomes a DATA change, never a
 * page redesign.
 *
 * ── POSITIONS, NEVER PEOPLE ──────────────────────────────────────────────────
 * Tiles come from `SEAT_DEFS` (`./seats`), which is exactly right for this: a
 * seat def IS a position, not an assignment. "Three event coordinators" is one
 * tile by construction: we publish what a POSITION is paid because the public
 * is entitled to know what its money buys; we do not publish what a named
 * person earns, because that is theirs. It is the same promise the rest of the
 * page makes about givers and attendees, applied to ourselves.
 *
 * ⚠ ONE COUNT IS THE ONLY THING THAT CROSSES FROM PEOPLE TO THE PAGE. ⚠ Each
 * tile carries a headcount badge — a `3` on the rim of the Chapter Director
 * circle — because a reader being shown a pay figure is entitled to know
 * whether it is paid once or thirty times. That number is the ONLY fact about
 * holders this section has ever published, and it is deliberately contained:
 *
 *   - `compensationTable()` takes a `PositionHeadcount` — a map of NUMBERS.
 *     It has no ctx, no db, and no way to reach a holder record even if a
 *     future editor wanted one, so nothing downstream of here can widen.
 *   - The counting itself happens in exactly one place
 *     (`apps/convex/lib/positionHeadcount.ts`), which reads holder rows and
 *     returns integers. Its doc says so in as many words.
 *
 * Before this existed the privacy property was STRUCTURAL — there was no path
 * from this module to `seatAssignments` at all. It is now DISCIPLINED: one
 * narrow path exists, it carries integers, and the page test asserts that no
 * assigned holder's name appears anywhere in the rendered HTML. Widening that
 * path is the thing to refuse.
 *
 * `derived` seats are skipped. `chapter_directors` (central) is a rollup of
 * every chapter's `chapter_director` holder — a view of other seats, never
 * a position anybody is appointed to, so listing it would print the same
 * position twice under two names, and count the same people twice with it.
 *
 * ── WHY IT RENDERS ON EVERY MONTH, INCLUDING BACKDATED ONES ──────────────────
 * This is deliberately NOT part of a publication's frozen snapshot, which is
 * the one place this page departs from "what is published is what was
 * approved" — so it is worth being explicit about why. A frozen figure is
 * evidence about a month's TRANSACTIONS. This is not a transaction and not a
 * fact about any month: it is a standing statement of the org's compensation
 * policy, which is either true of us right now or is not true at all. Storing
 * a copy per publication would mean a reader of March saw one answer and a
 * reader of April another, with no way to tell which one describes today —
 * and it would mean twelve rows to correct the day the answer changes, eleven
 * of which nobody would remember. Rendering it from this constant makes every
 * published month, backdated ones included, say the same true thing at once.
 *
 * THE HEADCOUNTS ARE LIVE FOR THE SAME REASON, and the consequence is worth
 * stating plainly: a reader opening a backdated month sees TODAY'S team, not
 * the team that month had. That is the honest reading of what this section
 * claims — "these are our positions and this is what they pay, right now" —
 * and a per-month frozen headcount would quietly turn it into a historical
 * staffing record nobody reviewed, published under a heading about pay.
 *
 * ── WHAT A POSITION'S PAY IS: ONE NUMBER, ANNUAL, IN CENTS ───────────────────
 * A position's pay is integer cents PER YEAR, and `0` means volunteer. Not a
 * union, not an amount-plus-period pair — one number, because that is what the
 * page has to print and every extra degree of freedom is a way for two tiles to
 * disagree about what they mean.
 *
 * ANNUAL IS THE UNIT, AND IT IS A DELIBERATE CHOICE, NOT A DEFAULT. Public
 * offices publish an ANNUAL SALARY: it is the figure a reader can compare
 * against a city payroll, a 990, or another nonprofit, without doing
 * arithmetic that the page should have done for them. Storing an amount plus a
 * period would let one tile say "$65/hr" beside another saying "$48,000/yr"
 * and quietly leave the comparison to the reader — which is the thing this
 * grid exists to spare them.
 *
 * So there is no period field to set, and no unit to get wrong. The cost of
 * that is real and worth stating plainly: an HOURLY or PER-ENGAGEMENT
 * arrangement — a session player, a mix engineer, a part-time coordinator — is
 * NOT expressible here, and must not be smuggled in by annualizing a guess at
 * the hours. When one of those arrives it needs a real product decision about
 * how the grid presents it (a qualifier under the figure? a separate "paid per
 * engagement" band?), made in the open, and NOT a silent change of what the
 * number in this file means. A reader who learned to read this line as a
 * yearly salary must never be handed an hourly rate in the same shape.
 *
 * ── WHAT A FUTURE EDITOR CHANGES ─────────────────────────────────────────────
 * The day the Music Director starts drawing $48,000 a year:
 *   1. `byPosition.music_director = 4_800_000` (cents, per year)
 *   2. `allVolunteer: false` — the authored claim the publish console makes a
 *      human re-affirm every month, and the one `everyPositionIsVolunteer()`
 *      cross-checks against the data.
 * Nothing in the renderer, the CSS, the copy or a test fixture moves — which
 * is the point of modelling "Volunteer" as a VALUE a position's pay can take
 * (zero) rather than as a string in the HTML.
 */

/**
 * The glyph inside every tile's circle. ONE glyph, for every position, paid or
 * not.
 *
 * This replaced a two-icon scheme (a handshake for volunteers, a banknote for
 * anyone paid), and the replacement is the whole design argument in miniature:
 * a paid position gets NO distinct treatment here — no second glyph, no
 * colour, no border. A page that visually flags the paid tile is editorialising
 * about a salary it publishes precisely because a salary is a normal, defensible
 * thing for an org to have. The only difference between a paid tile and a
 * volunteer one is the last line: a word, or a figure.
 *
 * A person, rather than a job-shaped icon, because the badge on its rim counts
 * PEOPLE — and because a per-position icon table would be 26 emoji to invent,
 * 26 more to argue about, and one more to forget every time a seat is added.
 * Emoji because the other public pages already use them as card icons
 * (`givePageSections.ts#PROGRAM_CARDS`, `landingPage.ts`).
 */
export const POSITION_GLYPH = "👤";

/** Whether a stated figure exists at all. One predicate, so the label and the
 *  `allVolunteer` cross-check can never disagree about where the line between
 *  "volunteer" and "paid" falls. */
function isPaidCents(cents: number): boolean {
  return cents > 0;
}

/**
 * "Volunteer" for `0`, otherwise the annual figure: "$48,000/yr".
 *
 * SHORT, BECAUSE IT SITS UNDER AN 80px TILE. "$48,000.00 per year" wrapped
 * onto three lines there and pushed the one word every neighbouring tile
 * prints out of alignment with it. The unit is still stated — an abbreviation
 * a reader resolves instantly is not the same as the bare "$48,000.00" this
 * has always refused to print, which in a grid of salaries is exactly the
 * number somebody reads as monthly.
 *
 * CENTS SHOW ONLY WHEN THERE ARE CENTS. Everywhere else on this page a figure
 * is evidence about a transaction and must reconcile against the CSV to the
 * penny; a salary is a stated policy figure, and "$48,000.00/yr" spends four
 * characters saying nothing. But a rounded figure would be a figure a reader
 * can't check, so a salary that genuinely isn't a whole number of dollars
 * prints its cents rather than being tidied into a lie.
 */
export function positionPayLabel(cents: number): string {
  if (!isPaidCents(cents)) return "Volunteer";
  return `${formatCents(cents, { showCents: cents % 100 !== 0 })}/yr`;
}

export interface CompensationDisclosure {
  /**
   * The authored "nobody here is paid" claim.
   *
   * It renders NOTHING on the public page — the grid says it, tile by tile,
   * better than a sentence could, and a sentence beside 26 tiles all reading
   * "Volunteer" was the page repeating itself. It survives because it is the
   * thing a human re-affirms in the publish console every month
   * (`PublishMonth.tsx`), and because `everyPositionIsVolunteer()` cross-checks
   * it against `byPosition` — a paid position added without clearing this flag
   * fails a test rather than reaching the page.
   */
  readonly allVolunteer: boolean;
  /** The ONE line above the grid. One line, deliberately: the grid's own
   *  vocabulary — a name, a badge, a pay line — is legible without being
   *  narrated, and the paragraph that used to sit here explained three times
   *  over what a reader gets in one pass. */
  readonly intro: string;
  /** The forward-looking policy, in one sentence, under the grid. */
  readonly policy: string;
  /** Annual pay, in integer cents, for a position `byPosition` says nothing
   *  about. `0` — every position today — prints as "Volunteer". */
  readonly defaultPayCents: number;
  /** Per-position annual pay, in integer cents. Empty today; one entry the day
   *  one position is paid — never a full 26-entry table anybody has to keep in
   *  sync with `SEAT_DEFS`. */
  readonly byPosition: Readonly<Partial<Record<SeatId, number>>>;
}

export const COMPENSATION_DISCLOSURE: CompensationDisclosure = {
  allVolunteer: true,
  intro: "Positions, not people. The badge is how many hold each one.",
  policy:
    "Pay is published by position, never by person, and positions at the same level are paid the same.",
  defaultPayCents: 0,
  byPosition: {},
};

/** What `seatId` is paid a year, in cents. The ONLY way the page resolves a
 *  position's pay, so a future override lands everywhere at once. */
export function positionPay(seatId: SeatId): number {
  return (
    COMPENSATION_DISCLOSURE.byPosition[seatId] ??
    COMPENSATION_DISCLOSURE.defaultPayCents
  );
}

/** The `allVolunteer` claim, read off the DATA instead of the flag. The flag
 *  is what a human authored; this is what the table will actually print, and
 *  a test pins that the two agree — so the headline sentence can never
 *  survive a paid position being added underneath it. */
export function everyPositionIsVolunteer(): boolean {
  return (
    !isPaidCents(COMPENSATION_DISCLOSURE.defaultPayCents) &&
    Object.values(COMPENSATION_DISCLOSURE.byPosition).every(
      (cents) => !isPaidCents(cents),
    )
  );
}

/** The two band headings. Central and chapter are the split `SEAT_DEFS`
 *  already draws (`chart`), and it is the split a reader needs: one of these
 *  lists exists once, the other exists once per city. Two words, because the
 *  rest of each band's header is the count line beside it. */
export const COMPENSATION_GROUP_HEADINGS: Record<SeatChart, string> = {
  central: "Org-wide",
  chapter: "Chapter",
};

/**
 * How many people hold each position right now — COUNTS AND NOTHING ELSE.
 *
 * This is the only shape in which holder data is allowed to reach the public
 * page (see `COMPENSATION_DISCLOSURE`'s containment note). It is a map of
 * integers with no document, id, name or scope in it, and it must stay that
 * way: the moment this type can carry a holder, every renderer downstream can
 * print one.
 *
 * A missing key means zero, so a chart the counter has never heard of (a
 * brand-new seat, a fresh install with nothing assigned) reads as an honest
 * "nobody holds this yet" rather than dropping the tile.
 */
export type PositionHeadcount = {
  readonly byPosition: Readonly<Partial<Record<SeatId, number>>>;
  /** How many chapters the CHAPTER counts are summed across — "3 cities". A
   *  chapter position's count is the total across every chapter, so without
   *  this a reader can't tell nine Chapter Directors in nine cities from nine
   *  in one. */
  readonly chapterCount: number;
};

export interface CompensationRow {
  seatId: SeatId;
  /** The position's name. Never a holder's. */
  title: string;
  /** Annual pay in cents; `0` is a volunteer position. Named for its unit
   *  because a bare `pay: number` is a currency-and-period ambiguity waiting
   *  at every call site. */
  payCents: number;
  /** How many people hold it right now, summed across chapters for a chapter
   *  position. `0` is a real answer and renders as one — a vacancy is not an
   *  error state and gets no styling of its own, because the pay line under it
   *  is what the position pays whether or not anybody is in it. */
  peopleCount: number;
}

export interface CompensationGroup {
  chart: SeatChart;
  heading: string;
  rows: CompensationRow[];
  /** Tiles in this band. */
  positionCount: number;
  /** People across those tiles. */
  peopleCount: number;
  /** Chapters the counts span, or `null` for the org-wide band, where the
   *  question doesn't arise. */
  chapterCount: number | null;
}

/**
 * The published grid: both charts, hierarchy order, positions only.
 *
 * Built here rather than in the renderer so the rules that make it honest —
 * positions not people, no derived rollups, leadership first, counts as
 * integers — live beside the doc that explains them, and so a second surface
 * (the publish console's pre-publish preview, say) cannot render a subtly
 * different grid.
 *
 * `headcount` is a required argument rather than an optional one with a `{}`
 * default on purpose: a caller that forgot to wire the counter would otherwise
 * publish a confident grid of zeroes, which is a false statement about the org
 * rather than a missing feature.
 */
export function compensationTable(
  headcount: PositionHeadcount,
): CompensationGroup[] {
  return SEAT_CHARTS.map((chart) => {
    const rows = seatChartOrder(chart)
      .filter((def) => def.derived !== true)
      .map((def) => ({
        seatId: def.id,
        title: def.title,
        payCents: positionPay(def.id),
        peopleCount: headcount.byPosition[def.id] ?? 0,
      }));
    return {
      chart,
      heading: COMPENSATION_GROUP_HEADINGS[chart],
      rows,
      positionCount: rows.length,
      peopleCount: rows.reduce((total, row) => total + row.peopleCount, 0),
      chapterCount: chart === "chapter" ? headcount.chapterCount : null,
    };
  });
}

/** `n` with a noun that agrees with it. The band header is four numbers in a
 *  row; "1 positions · 1 people" in the middle of a disclosure about care is
 *  the kind of detail that costs more than it saves. */
function countOf(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "17 positions · 31 people", or "9 positions · 27 people across 3 cities"
 *  for the chapter band. The whole band header — a reader needs the scale of
 *  each list, not a sentence explaining what a band is.
 *
 *  The cities clause is dropped rather than printed as "across 0 cities" when
 *  there are no chapters yet: a true zero here is a fresh install, and the
 *  clause would be the only wrong-sounding thing on the page. */
export function compensationGroupSummary(group: CompensationGroup): string {
  const counts = `${countOf(group.positionCount, "position", "positions")} · ${countOf(
    group.peopleCount,
    "person",
    "people",
  )}`;
  return group.chapterCount ? `${counts} across ${countOf(group.chapterCount, "city", "cities")}` : counts;
}

// ── Where a reader goes when the page is wrong ───────────────────────────────
/**
 * The address the public finances page tells people to write to.
 *
 * `hello@publicworship.life` because that is already the org's public contact
 * everywhere else — the site header, the collaborate page, the songs page,
 * the newsletter footer. Inventing a `giving@` or `finance@` alias for this
 * one page would create an address that has to be monitored by someone, and
 * an unmonitored address on a "tell us if this is wrong" prompt is worse than
 * no prompt at all: it converts a person willing to help into a person who
 * was ignored.
 *
 * (The marketing site — `apps/landing`, a separate Astro build — hardcodes
 * the same address in about ten places. Consolidating those is a cleanup
 * worth doing on its own; this constant is the server-rendered side's single
 * source, so at least the pages Convex renders move together.)
 */
export const PUBLIC_CONTACT_EMAIL = "hello@publicworship.life";

/** A `mailto:` with the subject pre-filled, so a report arrives already
 *  triaged instead of as an untitled email somebody has to categorize. */
export function contactMailto(subject: string): string {
  return `mailto:${PUBLIC_CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`;
}

// ── Amendment reasons ────────────────────────────────────────────────────────
/**
 * Why a published month was revised. A free-text note is required alongside
 * this (`financePublicationRevisions.note`) — the taxonomy exists so the
 * public amendment log can be SKIMMED, not to spare anyone from explaining.
 */
export const AMENDMENT_REASONS = [
  "recategorized",
  "late_transaction",
  "corrected_amount",
  "added_documentation",
  "clarified_purpose",
  "other",
] as const;
export type AmendmentReason = (typeof AMENDMENT_REASONS)[number];

export const AMENDMENT_REASON_LABELS: Record<AmendmentReason, string> = {
  recategorized: "Recategorized",
  late_transaction: "Late transaction added",
  corrected_amount: "Amount corrected",
  added_documentation: "Documentation added",
  clarified_purpose: "Purpose clarified",
  other: "Other",
};

/** The shortest an amendment note may be. A one-word "fixed" is not a reason,
 *  and the whole value of an amendment log is that it reads like an
 *  explanation. Mirrors `MIN_PURPOSE_LENGTH`'s reasoning on codings. */
export const MIN_AMENDMENT_NOTE_LENGTH = 12;

/** The most rows one published revision may carry. A month at this size runs
 *  in the hundreds; this is a guardrail against a mis-scoped period
 *  freezing tens of thousands of rows in one mutation, not a product limit.
 *  A period that exceeds it fails loudly at publish time rather than
 *  publishing a silently truncated ledger — an incomplete ledger presented as
 *  complete is the one outcome worse than not publishing. */
export const MAX_PUBLISHED_ENTRIES = 4000;
