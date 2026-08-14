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
 * person at Public Worship draws a salary, an honorarium, or a fee, the
 * "everyone is a volunteer" half below becomes false — on a public page whose
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
 * ── THE PROMISE, AND THE TABLE THAT KEEPS IT ─────────────────────────────────
 * The page used to make the forward-looking promise in prose — "when that
 * changes, we'll publish what people are paid by position rather than by
 * person." A promise about a FORMAT is worth much less than the format itself:
 * published the day it first costs something, a compensation table reads as a
 * disclosure extracted under pressure, and a reader meets an unfamiliar layout
 * at the exact moment they are least inclined to be generous about it.
 *
 * So the table publishes NOW, while every row reads "Volunteer." The day
 * somebody is paid, the reader is not shown a new section — they are shown a
 * number in a row they have already read a dozen times, in a table they
 * already trust. That is the whole design: this becomes a DATA change, never a
 * page redesign.
 *
 * ── POSITIONS, NEVER PEOPLE ──────────────────────────────────────────────────
 * Rows come from `SEAT_DEFS` (`./seats`), which is exactly right for this: a
 * seat def IS a position, not an assignment. "Three event coordinators" is one
 * row by construction, and there is no code path from this table to
 * `seatHolders`/`seatAssignments` — the privacy property is structural, not a
 * rule a renderer has to remember. It is the same promise the rest of the page
 * makes about givers and attendees, applied to ourselves: we publish what a
 * POSITION is paid because the public is entitled to know what its money buys;
 * we do not publish what a named person earns, because that is theirs.
 *
 * `derived` seats are skipped. `chapter_directors` (central) is a rollup of
 * every chapter's `chapter_director` holder — a view of other seats, never
 * a position anybody is appointed to, so listing it would print the same
 * position twice under two names.
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
 * ── WHAT A POSITION'S PAY IS: ONE NUMBER, ANNUAL, IN CENTS ───────────────────
 * A position's pay is integer cents PER YEAR, and `0` means volunteer. Not a
 * union, not an amount-plus-period pair — one number, because that is what the
 * page has to print and every extra degree of freedom is a way for two rows to
 * disagree about what they mean.
 *
 * ANNUAL IS THE UNIT, AND IT IS A DELIBERATE CHOICE, NOT A DEFAULT. The policy
 * sentence below commits to publishing pay "the way public offices publish
 * theirs," and public offices publish an ANNUAL SALARY: it is the figure a
 * reader can compare against a city payroll, a 990, or another nonprofit,
 * without doing arithmetic that the page should have done for them. Storing an
 * amount plus a period would let one row say "$65.00 per hour" beside another
 * saying "$48,000.00 per year" and quietly leave the comparison to the reader
 * — which is the thing this table exists to spare them.
 *
 * So there is no period field to set, and no unit to get wrong. The cost of
 * that is real and worth stating plainly: an HOURLY or PER-ENGAGEMENT
 * arrangement — a session player, a mix engineer, a part-time coordinator — is
 * NOT expressible here, and must not be smuggled in by annualizing a guess at
 * the hours. When one of those arrives it needs a real product decision about
 * how the table presents it (a second column? a qualifier under the figure? a
 * separate "paid per engagement" list?), made in the open, and NOT a silent
 * change of what the number in this file means. A reader who learned to read
 * this column as a yearly salary must never be handed an hourly rate in the
 * same shape.
 *
 * ── WHAT A FUTURE EDITOR CHANGES ─────────────────────────────────────────────
 * The day the Music Director starts drawing $48,000 a year:
 *   1. `byPosition.music_director = 4_800_000` (cents, per year)
 *   2. `allVolunteer: false` (the headline sentence stops rendering; the table
 *      and the policy stay).
 *   3. Rewrite `present` if it still needs to say something true.
 * Nothing in the renderer, the CSS, or a test fixture moves — which is the
 * point of modelling "Volunteer" as a VALUE a position's pay can take (zero)
 * rather than as a string in the HTML.
 */

/**
 * The row icon. Exactly two, and chosen by whether there is a figure at all.
 *
 * A per-position icon table would be 26 emoji to invent, 26 more to argue
 * about, and one more to forget every time a seat is added — and it would
 * decorate the position, which is the half of the row that is already a word.
 * Keying it to the pay means the icon carries information: the day one row
 * turns paid, its glyph changes with it and the eye lands on the row that
 * changed. Emoji because the other public pages already use them as card icons
 * (`givePageSections.ts#PROGRAM_CARDS`, `landingPage.ts`).
 */
export const VOLUNTEER_PAY_ICON = "🤝";
export const PAID_PAY_ICON = "💵";

/** Whether a stated figure exists at all. One predicate, so the label, the
 *  icon and the `allVolunteer` cross-check can never disagree about where the
 *  line between "volunteer" and "paid" falls. */
function isPaidCents(cents: number): boolean {
  return cents > 0;
}

/** "Volunteer" for `0`, otherwise the yearly figure: "$48,000.00 per year".
 *  Cents show, matching the rest of the page — a figure that rounds is a
 *  figure a reader can't reconcile. The period is spelled out even though it
 *  is the only one there is, because a bare "$48,000.00" in a column of
 *  salaries is exactly the kind of number a reader silently assumes is
 *  monthly. */
export function positionPayLabel(cents: number): string {
  if (!isPaidCents(cents)) return "Volunteer";
  return `${formatCents(cents)} per year`;
}

export interface CompensationDisclosure {
  /** Set to `false` the day anybody starts being paid — this only governs the
   *  "everyone is a volunteer" SENTENCE. The table below is always published,
   *  and stays correct on its own through `byPosition`. */
  readonly allVolunteer: boolean;
  readonly headline: string;
  readonly present: string;
  readonly policy: string;
  /** The sentence above the table, stating what a row is (and isn't). */
  readonly tableIntro: string;
  /** Annual pay, in integer cents, for a position `byPosition` says nothing
   *  about. `0` — every position today — prints as "Volunteer". */
  readonly defaultPayCents: number;
  /** Per-position annual pay, in integer cents. Empty today; one entry the day
   *  one position is paid — never a full 26-row table anybody has to keep in
   *  sync with `SEAT_DEFS`. */
  readonly byPosition: Readonly<Partial<Record<SeatId, number>>>;
}

export const COMPENSATION_DISCLOSURE: CompensationDisclosure = {
  allVolunteer: true,
  headline: "Everyone here is a volunteer.",
  present:
    "Nobody at Public Worship draws a salary today — not the leadership, not the team. None of the money above was paid to any of us.",
  policy:
    "When that changes, we'll publish what people are paid by position rather than by person — the way public offices publish theirs — and positions at the same level will be paid the same. It will appear in the table above, and like everything else here, it will show up in the lines.",
  tableIntro:
    "Every position at Public Worship, and what it is paid. These are positions, not people: one row covers everyone holding it, nobody is named, and a position held by three people is still one row.",
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

/** The two group headings. Central and chapter are the split `SEAT_DEFS`
 *  already draws (`chart`), and it is the split a reader needs: one of these
 *  lists exists once, the other exists once per city. */
export const COMPENSATION_GROUP_HEADINGS: Record<SeatChart, string> = {
  central: "Org-wide positions",
  chapter: "Chapter positions",
};

export const COMPENSATION_GROUP_BLURBS: Record<SeatChart, string> = {
  central: "These serve the whole organization — one of each, across everything we do.",
  chapter:
    "Every chapter has these. A row covers the position in all of them, in every city.",
};

export interface CompensationRow {
  seatId: SeatId;
  /** The position's name. Never a holder's. */
  title: string;
  /** Annual pay in cents; `0` is a volunteer position. Named for its unit
   *  because a bare `pay: number` is a currency-and-period ambiguity waiting
   *  at every call site. */
  payCents: number;
  icon: string;
}

export interface CompensationGroup {
  chart: SeatChart;
  heading: string;
  blurb: string;
  rows: CompensationRow[];
}

/**
 * The published table: both charts, hierarchy order, positions only.
 *
 * Built here rather than in the renderer so the three rules that make it
 * honest — positions not people, no derived rollups, leadership first — live
 * beside the doc that explains them, and so a second surface (the publish
 * console's pre-publish preview, say) cannot render a subtly different table.
 */
export function compensationTable(): CompensationGroup[] {
  return SEAT_CHARTS.map((chart) => ({
    chart,
    heading: COMPENSATION_GROUP_HEADINGS[chart],
    blurb: COMPENSATION_GROUP_BLURBS[chart],
    rows: seatChartOrder(chart)
      .filter((def) => def.derived !== true)
      .map((def) => {
        const payCents = positionPay(def.id);
        return {
          seatId: def.id,
          title: def.title,
          payCents,
          icon: isPaidCents(payCents) ? PAID_PAY_ICON : VOLUNTEER_PAY_ICON,
        };
      }),
  }));
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
