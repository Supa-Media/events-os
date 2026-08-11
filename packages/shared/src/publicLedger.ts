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
  "Book",
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
  "Book",
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
 * What the page says about who gets paid.
 *
 * ⚠ THIS IS A CLAIM ABOUT THE PRESENT AND IT CAN GO STALE. ⚠ The moment one
 * person at Public Worship draws a salary, an honorarium, or a fee, the first
 * sentence below becomes false — on a public page whose entire argument is
 * that it does not say false things. There is no way to derive this from the
 * ledger (the schema has no notion of compensation, and matching on category
 * names would be a guess), so it is a stated fact with a human behind it.
 *
 * Two guards, since a constant can't check reality:
 *  - The publish console shows this line back to the publisher every month,
 *    beside the other disclosures, BEFORE the button. Re-affirming it is part
 *    of publishing a month.
 *  - The Academy lesson lists it in the pre-publish checklist.
 *
 * The FORWARD-LOOKING half is the org's stated policy, not a status, so it
 * does not go stale: compensation publishes by POSITION, never by person, and
 * positions at the same level are paid the same (the founder's model,
 * explicitly modelled on how public offices publish theirs). Keeping that
 * promise here — visible before there is anything to disclose — is the point.
 * Announcing it later, once there is a salary to explain, would read as a
 * defence rather than a commitment.
 */
export const COMPENSATION_DISCLOSURE = {
  /** Set to `false` the day anybody starts being paid, and say so here. */
  allVolunteer: true,
  headline: "Everyone here is a volunteer.",
  present:
    "Nobody at Public Worship draws a salary today — not the leadership, not the team. None of the money above was paid to any of us.",
  policy:
    "When that changes, we'll publish what people are paid by position rather than by person — the way public offices publish theirs — and positions at the same level will be paid the same. Like everything else here, it will show up in the lines.",
} as const;

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
