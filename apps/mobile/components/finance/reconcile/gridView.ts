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

/** A `listReconcile` group header, verbatim off the wire. `count` and
 *  `totalCents` are over the WHOLE match set, never the loaded page. */
export type GroupSummary = {
  key: string;
  label: string;
  count: number;
  totalCents: number;
  /** The group's OWN explaining progress, server-computed over the whole
   *  match set in the same loop that built the group — never the loaded page,
   *  and not derivable here (the denominator reads transaction fields
   *  `reconcileRow` doesn't ship). This is what lets a month band carry the
   *  meter the Explain screen carries. */
  explainableCount: number;
  explainableCents: number;
  explainedCount: number;
  explainedCents: number;
};

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
