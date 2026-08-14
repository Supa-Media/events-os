/**
 * WHERE "EXPLAIN THIS MONTH" GOES — one URL builder, two callers.
 *
 * The Explain screen (`/finances/explain`) was retired into the Reconcile grid:
 * the grid can now ask the publishing question (`needs_explaining`, which
 * carries no policy date and so reaches the reconstructed 2024-25 history),
 * sort by absolute amount across the whole match set, and band itself by month
 * with each band carrying that month's own progress. "By month" is those three
 * axes, not a destination.
 *
 * ── WHY A FUNCTION AND NOT A TEMPLATE LITERAL AT EACH CALL SITE ──────────────
 * Because there are two callers that must not drift: the publish console's
 * "Explain them now" button (the ONLY path from a "61 lines will publish blank"
 * disclosure to fixing them) and the `/finances/explain` redirect that keeps
 * every existing bookmark and mail link working. If those two ever pointed at
 * different filters, half the org would be working a different list from the
 * other half and nothing on either screen would say so.
 *
 * The Book view menu's "By month" entry sets the same three axes as grid state
 * rather than by navigating — it is already on this screen — but reads from the
 * same three constants below, so all three surfaces are one definition.
 *
 * ── THE SCOPE TRANSLATION IS THE PART THAT'S EASY TO GET WRONG ───────────────
 * A single-book scope (`Id<"chapters"> | "central"`, what the publish console
 * and `monthCodingWorklist` speak) is NOT what the grid's `?scope=` accepts:
 * that takes `"central" | "all" | "chapter"` and names the chapter separately in
 * `?chapterId=`. A chapter id handed to `?scope=` matches none of the three
 * words, falls back to the caller's own desk, and silently shows a different
 * book than the link promised — the same class of failure `bookScope.ts` exists
 * to prevent, pointing the other way. So: only the literal `central` becomes
 * `?scope=`; a chapter id becomes `?chapterId=`, which the grid re-validates
 * against the chapters the caller can actually name.
 */

/** The publishing population — no policy date, so it reaches the reconstructed
 *  2024-25 rows the `uncoded` facet grandfathers out. */
export const BY_MONTH_FILTER = "needs_explaining";
/** Biggest money first (ABSOLUTE cents, whole match set before paging) — the
 *  ordering that made the Explain screen's list worth working top-down. */
export const BY_MONTH_SORT = "amount";
export const BY_MONTH_DIR = "desc";
/** One band per month, each carrying that month's own progress. */
export const BY_MONTH_GROUP = "month";

/** The three axes as a query fragment, without any scope or period. */
export const BY_MONTH_VIEW_QUERY = `filters=${BY_MONTH_FILTER}&sort=${BY_MONTH_SORT}&dir=${BY_MONTH_DIR}&group=${BY_MONTH_GROUP}`;

export function byMonthHref(opts: {
  /** `{ year, month }` to narrow to one month, or null for every month at once
   *  (the bands then carry the whole book, newest month first). */
  period?: { year: number; month: number } | null;
  /** A single book — `"central"`, a chapter id, or null/undefined for "leave it
   *  to the caller's own desk", which is what an unscoped link always meant. */
  scope?: string | null;
}): string {
  const query = [BY_MONTH_VIEW_QUERY];
  if (opts.period) {
    query.push(
      `year=${opts.period.year}`,
      `month=${opts.period.month}`,
      // `period=month` rather than the default: without it the grid reads the
      // WHOLE year (`ytd`), which is a different question with a much larger
      // answer.
      "period=month",
    );
  }
  if (opts.scope === "central") query.push("scope=central");
  else if (opts.scope) query.push(`chapterId=${encodeURIComponent(opts.scope)}`);
  return `/finances/reconcile?${query.join("&")}`;
}
