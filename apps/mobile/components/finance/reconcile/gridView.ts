/**
 * THE GRID'S VIEW STATE — sort, grouping, and the progress strip's honesty
 * rule — as pure functions, so the parts that can be wrong are the parts that
 * are tested.
 *
 * Dependency-free (no `react-native` import) so it runs directly under this
 * package's jest config — the same reason `compactCents.ts` / `panelNav.ts`
 * are shaped this way.
 *
 * All three pieces of state are URL-BACKED (`?sort=amount&dir=desc&group=month`),
 * following the rule this screen already applies to `?filters=` and `?scope=`:
 * a view somebody sorted or grouped is shareable, survives a refresh, and a
 * screenshot of one can be reproduced. Parsing is total — an unknown or
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
