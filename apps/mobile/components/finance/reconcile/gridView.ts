/**
 * THE GRID'S VIEW STATE — sort, grouping, which columns are on screen, and the
 * progress strip's honesty rule — as pure functions, so the parts that can be
 * wrong are the parts that are tested.
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
 *     (categorize, set budget, mark reconciled, mark transfer) is how most of
 *     the work on this screen actually gets done. Hiding it would take the
 *     grid's main verb away, not just a fact.
 *   - Merchant — the row's identity. A grid of rows you cannot tell apart is
 *     not a condensed view of anything.
 *   - Actions — the speech-bubble there is the ONE affordance on every row, in
 *     every frame, that opens the charge's full record (Date/Amount only
 *     become a way in when the side panel is mounted, and "What it was for" is
 *     itself hideable). Hiding it could strand a row's record behind nothing.
 * Everything else is the reader's business.
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
  | "status";

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

/**
 * DOES THIS SCOPE HAVE A CATEGORY COLUMN AT ALL? — capability, not preference.
 *
 * The Category column is chapter-only, so a single-central scope normally
 * drops it — but a CROSS-BOOK row in that scope is absorbed by a chapter's
 * budget and DOES take that chapter's category, so hiding the column there
 * would put the one control that spend needs on a screen it isn't on.
 * Data-driven: the column appears in central scope exactly when there's
 * something in it.
 *
 * Lives here, over the narrowest row shape that answers it, so the GRID (which
 * renders the column) and the COLUMNS MENU (which decides whether to offer a
 * tick box for it) read one rule instead of two copies of it.
 */
export function showsCategoryColumn(
  centralScope: boolean,
  rows: readonly { book: { id: string }; chargedTo: { id: string } | null }[],
): boolean {
  if (!centralScope) return true;
  return rows.some((r) => r.chargedTo != null && r.chargedTo.id !== r.book.id);
}

/**
 * WHICH COLUMNS THIS SCOPE CAN RENDER AT ALL — the menu's contents.
 *
 * A tick box for a column the scope has no room for is a dead control: Book
 * exists only in the merged all-books queue (and on a foreign chapter's desk),
 * Category only where {@link showsCategoryColumn} says so, and the panel's
 * three belong to the panel while it is open. Offering them anyway would be
 * the "affordance that can't work" this screen keeps removing.
 *
 * A preference for a column that steps out stays RECORDED — it lives in the
 * URL, not in this list — so closing the panel or changing books brings back
 * exactly the view that was set.
 */
export function offerableColumns(scope: {
  showBook: boolean;
  showCategory: boolean;
  /** The side panel is mounted, and renders Cardholder / What it was for /
   *  Documentation itself. */
  panelOpen: boolean;
}): ReconcileColumnKey[] {
  return HIDEABLE_KEYS.filter((key) => {
    if (key === "book") return scope.showBook;
    if (key === "category") return scope.showCategory;
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

/** What the explained-progress strip is allowed to say. */
export type ExplainedStripMode = "progress" | "remaining" | "hidden";

/**
 * THE HONESTY RULE FOR THE PROGRESS STRIP.
 *
 * `explainedProgress` describes the MATCH SET. That is correct, and it means
 * selecting `needs_explaining` — a filter whose whole predicate is "not yet
 * explained" — removes every explained row from the denominator, so the strip
 * reads "0 of N explained · $0 of $X" BY CONSTRUCTION. The figure is right and
 * the sentence is a lie: it reads as "nobody has explained anything", which is
 * exactly backwards from the state that produced it (the explained rows are
 * missing because they're DONE).
 *
 * This is pinned server-side on purpose (`reconcileGridConsolidation.test.ts`,
 * "selecting needs_explaining makes the meter read 0 of N"), so the fix belongs
 * here. It is a RELABEL, not a suppression: the same numbers describe the same
 * rows, but as what they actually are — the work left ("N still to explain ·
 * $X"), which is the true and useful reading of a match set that is by
 * definition entirely unexplained.
 *
 * `hidden` covers the other case a progress figure has nothing to say about: a
 * selection with nothing explainable in it at all (a transfers-only view, an
 * inflow-only search). "0 of 0" is not progress, it's noise.
 */
export function explainedStripMode(
  progress: { explainableCount: number },
  activeFilters: readonly string[],
): ExplainedStripMode {
  if (progress.explainableCount <= 0) return "hidden";
  if (activeFilters.includes("needs_explaining")) return "remaining";
  return "progress";
}
