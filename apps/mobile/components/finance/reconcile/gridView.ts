/**
 * THE GRID'S VIEW STATE — sort, grouping, and which columns are on screen —
 * as pure functions, so the parts that can be wrong are the parts that are
 * tested.
 *
 * Dependency-free (no `react-native` import) so it runs directly under this
 * package's jest config — the same reason `compactCents.ts` / `panelNav.ts`
 * are shaped this way.
 *
 * Every piece of that state is URL-BACKED (`?sort=amount&dir=desc&group=month
 * &cols=cardholder,category`), following the rule this screen already applies
 * to `?filters=` and `?scope=`: a view somebody sorted, grouped or narrowed is
 * shareable, survives a refresh, and a screenshot of one can be reproduced.
 * Parsing is total — an unknown or
 * malformed param falls back to the default and never throws, which is this
 * screen's standing promise about deep links.
 */

export type ReconcileSortKey = "date" | "amount";
export type ReconcileSortDir = "asc" | "desc";
export type ReconcileGroupBy = "month" | "person";

/** `listReconcile`'s own defaults — newest first. Kept as constants so the
 *  screen can tell "the default" from "the user picked this", and drop the
 *  params from the URL in the former case rather than leaving noise in it. */
export const DEFAULT_SORT_KEY: ReconcileSortKey = "date";
export const DEFAULT_SORT_DIR: ReconcileSortDir = "desc";

export function parseSortKey(raw: string | undefined | null): ReconcileSortKey {
  return raw === "amount" ? "amount" : DEFAULT_SORT_KEY;
}

export function parseSortDir(raw: string | undefined | null): ReconcileSortDir {
  return raw === "asc" ? "asc" : DEFAULT_SORT_DIR;
}

export function parseGroupBy(
  raw: string | undefined | null,
): ReconcileGroupBy | null {
  return raw === "month" || raw === "person" ? raw : null;
}

/**
 * What pressing a column header does.
 *
 * Pressing the ACTIVE column flips its direction. Pressing the other column
 * switches to it at `desc` — the natural reading of both keys (newest first,
 * biggest first) and the direction each one already means when nobody has
 * asked, so a switch never lands on the surprising half of the toggle.
 */
export function nextSortState(
  current: { sort: ReconcileSortKey; dir: ReconcileSortDir },
  column: ReconcileSortKey,
): { sort: ReconcileSortKey; dir: ReconcileSortDir } {
  if (current.sort !== column) return { sort: column, dir: DEFAULT_SORT_DIR };
  return { sort: column, dir: current.dir === "desc" ? "asc" : "desc" };
}

/**
 * HOW FAR THROUGH THE EXPLAINING A SET OF ROWS IS, verbatim off the wire —
 * `listReconcile`'s `explainedProgress` (the whole selection) and every entry
 * of its `groups` (one month band, one person) carry exactly these fields, from
 * exactly the same server-side accumulator (`tallyExplainProgress`).
 *
 * Server-computed over the whole match set, never the loaded page, and NOT
 * derivable here: the denominator reads `feeOrigin`/`source`/`sourceCategory`
 * and both refund pointers off the transaction, and the live/backlog split
 * reads `source` and `importBatchId` — none of which `reconcileRow` ships.
 */
export type ExplainProgress = {
  explainableCount: number;
  explainableCents: number;
  explainedCount: number;
  explainedCents: number;
  /** Live rows only — the population observed as it happened, which is what
   *  "did I finish this month" is actually asking about. */
  liveExplainableCount: number;
  liveExplainableCents: number;
  liveExplainedCount: number;
  liveExplainedCents: number;
  /** Rows reconstructed from the org's imported 2024-25 records. Still owe a
   *  human explanation; just not counted against the same meter. */
  backlogExplainableCount: number;
  backlogExplainableCents: number;
  backlogExplainedCount: number;
  backlogExplainedCents: number;
};

// ── WHICH COLUMNS ARE ON SCREEN ──────────────────────────────────────────────
/**
 * Founder, on the deployed grid: "There are a lot of columns… if I don't want
 * to look at the cardholder and I don't want to look at the category, and I
 * just want to focus on adding things to budgets, then I could just narrow in
 * on that."
 *
 * TWO DIFFERENT QUESTIONS, KEPT APART. This is PREFERENCE — what one person
 * wants to look at right now. It is NOT the capability rule the grid already
 * applies (a central-book row has no category; the side panel renders
 * Cardholder / What it was for / Documentation itself, so the grid gives those
 * three back to pay for the panel's width). Preference only ever NARROWS what
 * capability already allows: un-ticking a column always hides it, ticking one
 * never conjures a column onto a scope that has none. See `offerableColumns` —
 * the menu is built from the columns this scope can render at all, so it never
 * offers a tick box that would do nothing.
 *
 * WHAT CANNOT BE HIDDEN, and why, is deliberately short:
 *   - the checkbox column — selection IS that column, and the bulk bar
 *     (categorize, set budget, mark closed, mark transfer) is how most of
 *     the work on this screen actually gets done. Hiding it would take the
 *     grid's main verb away, not just a fact.
 *   - Merchant — the row's identity. A grid of rows you cannot tell apart is
 *     not a condensed view of anything.
 *   - Actions — it holds the two things a row can never be without: the
 *     speech-bubble, the ONE affordance on every row in every frame that opens
 *     the charge's full record (Date/Amount only become a way in when the side
 *     panel is mounted, and "What it was for" is itself hideable), and the
 *     `⋯` menu, which after the 2026-08-14 split is the ONLY route to this
 *     row's verbs — correct it, mark it personal, un-mark a marking. Hiding it
 *     would strand a row's record behind nothing AND take every row-level act
 *     off the screen at once.
 * Everything else is the reader's business — including {@link rowMarkings}'
 * own column, which is new here and hideable precisely because it is a fact
 * about the row rather than a way to do anything to it.
 */
export type ReconcileColumnKey =
  | "book"
  | "date"
  | "amount"
  | "cardholder"
  | "explanation"
  | "category"
  | "forCol"
  | "receipt"
  | "status"
  | "marked";

/**
 * The hideable columns in GRID ORDER, with the header each one carries — so
 * the menu reads top-to-bottom exactly as the grid reads left-to-right, and
 * nobody has to translate between a checklist and a table.
 *
 * The key is the grid's OWN column key (`DEFAULT_COLS` in `ReconcileList`),
 * which is also what lands in `?cols=`. One name per column all the way
 * through — the width record, the URL, and the checkbox can't drift apart.
 * `ReconcileList` indexes its widths with these keys, so a key that stopped
 * naming a real column fails to compile there rather than silently hiding
 * nothing.
 */
export const HIDEABLE_COLUMNS: readonly {
  key: ReconcileColumnKey;
  label: string;
}[] = [
  { key: "book", label: "Book" },
  { key: "date", label: "Date" },
  { key: "amount", label: "Amount" },
  { key: "cardholder", label: "Cardholder" },
  { key: "explanation", label: "What it was for" },
  { key: "category", label: "Category" },
  { key: "forCol", label: "For" },
  { key: "receipt", label: "Documentation" },
  { key: "status", label: "Status" },
  { key: "marked", label: "Marked" },
];

const HIDEABLE_KEYS: readonly ReconcileColumnKey[] = HIDEABLE_COLUMNS.map(
  (c) => c.key,
);

/**
 * `?cols=cardholder,category` — the columns switched OFF, not the ones left on.
 *
 * Storing the HIDDEN set is what keeps the default free: a reader who never
 * touches the control carries no `cols=` at all, exactly as `?sort=`/`?dir=`
 * drop out at their defaults. It also ages better — a column added to the grid
 * next month is visible in every link written today, where a stored VISIBLE
 * set would silently hide it from all of them.
 *
 * TOTAL, like every other param this screen reads: unknown names, a
 * non-hideable one, blanks and outright garbage are dropped rather than
 * throwing or hiding something nobody asked to hide.
 */
export function parseHiddenColumns(
  raw: string | undefined | null,
): ReconcileColumnKey[] {
  if (!raw) return [];
  const asked = new Set(raw.split(",").map((part) => part.trim()));
  // Filtered THROUGH the canonical order rather than over the input, so the
  // result is deduped and ordered whatever the URL said.
  return HIDEABLE_KEYS.filter((key) => asked.has(key));
}

/** The inverse — `""` when nothing is hidden, so the screen can drop `cols=`
 *  from the URL rather than leave an empty `cols=` sitting in the bar. */
export function serializeHiddenColumns(
  hidden: readonly ReconcileColumnKey[],
): string {
  return HIDEABLE_KEYS.filter((key) => hidden.includes(key)).join(",");
}

/** Ticking / un-ticking one column, in canonical order so the URL is the same
 *  string whatever order the boxes were clicked in. */
export function toggleHiddenColumn(
  hidden: readonly ReconcileColumnKey[],
  key: ReconcileColumnKey,
): ReconcileColumnKey[] {
  return hidden.includes(key)
    ? hidden.filter((k) => k !== key)
    : HIDEABLE_KEYS.filter((k) => k === key || hidden.includes(k));
}

/*
 * GONE (2026-08-14): `showsCategoryColumn`.
 *
 * It answered "does this scope have a Category column at all?", and the answer
 * used to be genuinely no in a single-central scope — categories were
 * chapter-scoped, so a central row had none to show. It had already grown one
 * exception (a CROSS-BOOK row in central scope IS absorbed by a chapter's
 * budget, so hiding the column there took away the one control that spend
 * needed) and was data-driven for exactly that case.
 *
 * Categories are org-wide now. EVERY row in every book can carry one, so the
 * column is unconditional and there is no rule left to share between the grid
 * and the Columns menu. Whether it is on screen is now purely the reader's
 * preference (`hidden`), which is where it belonged all along.
 */

// ── WHAT A ROW HAS BEEN MARKED AS ────────────────────────────────────────────
/**
 * THE FOUR WAYS A ROW SAYS "THIS MONEY ISN'T WHAT IT LOOKS LIKE".
 *
 * Founder, on the deployed grid's last column: "it contains like a bunch of
 * different rows and information and things like that… it could be much
 * cleaner and have things broken down." The reason it read as a jumble is that
 * it held three different KINDS at once — the way IN to a record, the row's
 * STATE, and the ACTIONS you can take on it — and the eye has no way to sort
 * icons by kind. These are the STATE half, pulled out into their own column:
 *
 *   transfer — a bookkeeper marked this leg an internal transfer
 *              (`markAsTransfer`). Not spend; the same dollars moving between
 *              two of our own accounts.
 *   payout   — a donation-processor settlement deposit (`markAsPayout`). Not
 *              new revenue; money already counted at the donor records
 *              arriving in a batch.
 *   personal — flagged personal and NOT yet repaid. Somebody owes the chapter
 *              this money, and the row cannot be closed until they don't.
 *   repaid   — flagged personal and settled. Kept as its own marking rather
 *              than dropped, because "this was personal and has been paid
 *              back" is a different, publishable fact from "ordinary spend".
 *
 * AN ARRAY, not one value, and deliberately so: `isPersonal` is a FLAG that
 * sits beside the transfer/payout markings rather than replacing them (see the
 * Academy's "Personal is a flag, not a status"), so a row can honestly carry
 * two. The grid used to render exactly this pair in two unrelated places in
 * one cell; collapsing them to one would be losing a fact to tidy a column,
 * which is the wrong trade.
 *
 * Transfer and payout ARE mutually exclusive — `markAsPayout` refuses a
 * transfer leg and vice versa — but the ordering here is a `switch`-free
 * `if/else` for the same reason the grid's own JSX was: if the data ever
 * disagreed, printing one of them is better than printing a contradiction.
 *
 * Kinds, not labels: "Other processor" is presentation and lives with the
 * `Badge` that draws it, so this module stays dependency-free (no
 * `@events-os/shared` import) and keeps running under the package's jest
 * config, exactly as its header promises.
 */
export type RowMarking<P extends string = string> =
  | { kind: "transfer" }
  | { kind: "payout"; processor: P }
  | { kind: "personal" }
  | { kind: "repaid" }
  | { kind: "gift"; coveredCents: number; fullyCovered: boolean };

export function rowMarkings<P extends string>(row: {
  isMarkedTransfer: boolean;
  payoutProcessor: P | null;
  isPersonal: boolean;
  repaymentStatus: string | null;
  /** Optional so every caller that predates gift matching — and every test
   *  that builds the narrowest row that answers its own question — stays
   *  valid. Absent means uncovered, which is the truth for such a row. */
  amountCents?: number;
  giftCoveredCents?: number;
}): RowMarking<P>[] {
  const out: RowMarking<P>[] = [];
  if (row.isMarkedTransfer) out.push({ kind: "transfer" });
  else if (row.payoutProcessor != null) {
    out.push({ kind: "payout", processor: row.payoutProcessor });
  }
  // A credit the giving layer has already counted. Beside the markings above
  // rather than instead of them, for the same reason `personal` is: it is a
  // separate fact, and the pair is only ever contradictory if the data is.
  //
  // `fullyCovered` is the difference between "this row is settled" and "part
  // of it is". A wire matched to only one gift of a split is NOT finished, and
  // a badge that read the same either way would say it was.
  const covered = row.giftCoveredCents ?? 0;
  if (covered > 0) {
    out.push({
      kind: "gift",
      coveredCents: covered,
      fullyCovered: covered >= (row.amountCents ?? covered),
    });
  }
  if (row.isPersonal) {
    out.push({ kind: row.repaymentStatus === "paid" ? "repaid" : "personal" });
  }
  return out;
}

/**
 * DOES THE PAGE HAVE A "MARKED" COLUMN AT ALL? — capability, not preference,
 * and the answer to what a new column COSTS.
 *
 * A tenth column on a table already ~1776px wide has to earn its width, and
 * this one earns it by not being there most of the time: a month with no
 * transfers, no payouts and no personal charges renders no Marked column, and
 * the grid comes out NARROWER than before the split (Actions shrank from 112px
 * to 72px once it stopped holding badges). It only appears on the pages that
 * have something to put in it — and even then a reader can put it away, which
 * is the point of it being in {@link HIDEABLE_COLUMNS}.
 *
 * Data-driven, over the narrowest row shape that answers the question, and
 * read by BOTH the
 * grid (which renders the column) and the Columns menu (which decides whether
 * to offer a tick box for it), so the two can never answer differently.
 */
export function showsMarkedColumn(
  rows: readonly {
    isMarkedTransfer: boolean;
    payoutProcessor: string | null;
    isPersonal: boolean;
    repaymentStatus: string | null;
    amountCents?: number;
    giftCoveredCents?: number;
  }[],
): boolean {
  return rows.some((row) => rowMarkings(row).length > 0);
}

/**
 * WHICH COLUMNS THIS SCOPE CAN RENDER AT ALL — the menu's contents.
 *
 * A tick box for a column the scope has no room for is a dead control: Book
 * exists only in the merged all-books queue (and on a foreign chapter's desk),
 * Marked only where {@link showsMarkedColumn} does, and the panel's three
 * belong to the panel
 * while it is open. Offering them anyway would be the "affordance that can't
 * work" this screen keeps removing.
 *
 * A preference for a column that steps out stays RECORDED — it lives in the
 * URL, not in this list — so closing the panel or changing books brings back
 * exactly the view that was set.
 */
export function offerableColumns(scope: {
  showBook: boolean;
  /** Anything on this page is actually marked — see {@link showsMarkedColumn}.
   *  A grid of ordinary spend has no Marked column and so no tick box for one. */
  showMarked: boolean;
  /** The side panel is mounted, and renders Cardholder / What it was for /
   *  Documentation itself. */
  panelOpen: boolean;
}): ReconcileColumnKey[] {
  return HIDEABLE_KEYS.filter((key) => {
    if (key === "book") return scope.showBook;
    // No `category` case: every book's rows can carry an org-wide category, so
    // the tick box is always offered.
    if (key === "marked") return scope.showMarked;
    if (key === "cardholder" || key === "explanation" || key === "receipt") {
      return !scope.panelOpen;
    }
    return true;
  });
}

/**
 * DOES THE LIVE/BACKLOG SPLIT EARN A SECOND LINE?
 *
 * Only when BOTH populations actually have rows. When one is empty the combined
 * figure IS the other one by construction, so a second line reading "+ 0 of 0
 * reconstructed" under it would be noise — and a "0 of 0" is the same class of
 * dishonest number as the "3% explained" the split exists to prevent, pointing
 * the other way.
 *
 * The rule the Explain screen applied to its own meter (`hasBoth`), moved here
 * so the progress strip and the month band apply ONE rule rather than two
 * copies of it.
 */
export function showsBacklogSplit(progress: {
  liveExplainableCount: number;
  backlogExplainableCount: number;
}): boolean {
  return (
    progress.liveExplainableCount > 0 && progress.backlogExplainableCount > 0
  );
}

/** A `listReconcile` group header, verbatim off the wire. `count` and
 *  `totalCents` are over the WHOLE match set, never the loaded page — and so
 *  is the {@link ExplainProgress} tally it carries, which is what lets a month
 *  band carry the meter the Explain screen carried. */
export type GroupSummary = {
  /** `YYYY-MM` for a month band; for a person band the cardholder's OWN
   *  `personId`, or the `"unattributed"` sentinel — which is what lets the band
   *  offer a nudge without a second lookup. */
  key: string;
  label: string;
  /** The cardholder's avatar (person bands only). */
  imageUrl: string | null;
  count: number;
  totalCents: number;
  /** ── WHAT THE WHOLE MONTH IS, beside what the filter left ─────────────────
   *
   *  MONTH BANDS ONLY — `listReconcile` omits both for a person grouping,
   *  since a person is not a publishable unit and has no unfiltered baseline
   *  to be compared against.
   *
   *  `count`/`totalCents` describe the MATCH SET. These describe the month
   *  before any filter or search, which is the population Publish acts on, and
   *  they are what lets a filtered band carry Publish honestly instead of
   *  having it withheld. The band prints both figures only when they differ,
   *  so an unfiltered grid reads exactly as it always did. */
  unfilteredCount?: number;
  unfilteredTotalCents?: number;
} & ExplainProgress;

/** The person-band group key for rows that resolve to nobody — a bank
 *  transfer, a processor deposit, a genesis-imported row with no card. Mirrors
 *  the server's `UNATTRIBUTED_GROUP_KEY`; a band with this key names a debt
 *  that is owed to the books rather than by a person, so there is nobody to
 *  nudge and the button must not render. */
export const UNATTRIBUTED_GROUP_KEY = "unattributed";

/** Where one group's rows sit inside the loaded page. */
export type GroupSegment = {
  group: GroupSummary;
  /** Index into `rows` of this group's first row on THIS page. */
  startIndex: number;
  /** How many of this group's rows the page actually carries — `<
   *  group.count` for the group the page runs out inside of. The header
   *  prints `group.count` (the truthful whole-scope figure) and says
   *  "N shown" when the two differ, rather than quietly printing either one
   *  as if it were the other. */
  shownCount: number;
};

/**
 * SLICE THE PAGE INTO GROUPS WITHOUT RE-DERIVING THE GROUPING.
 *
 * `listReconcile` returns `groups` in render order and orders `rows` so each
 * group's rows are contiguous in that same order, so the page is a PREFIX of
 * the grouped match set and pure index arithmetic recovers the boundaries.
 *
 * Deliberately NOT "read each row's month/person and bucket it": the month key
 * is computed server-side in EASTERN time (`easternParts`), and a client
 * re-deriving it from `postedAt` in the device's own zone would silently move
 * every row posted near a month boundary into the wrong header — a grouping
 * that disagrees with the counts printed above it. The server already answered
 * this; the client's job is to walk it.
 *
 * Groups entirely past the end of the page are dropped (they have no rows to
 * head), which is what lets the grid page into a large book without inventing
 * empty headers.
 */
export function groupSegments(
  rowCount: number,
  groups: readonly GroupSummary[],
): GroupSegment[] {
  const segments: GroupSegment[] = [];
  let offset = 0;
  for (const group of groups) {
    if (offset >= rowCount) break;
    segments.push({
      group,
      startIndex: offset,
      shownCount: Math.min(group.count, rowCount - offset),
    });
    // The FULL count, not `shownCount`: offsets are positions in the whole
    // ordered match set, and the loop stops at the page's end anyway.
    offset += group.count;
  }
  return segments;
}
