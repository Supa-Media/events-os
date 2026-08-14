/**
 * FINANCES · EXPLAIN A MONTH — now a redirect into the Reconcile grid.
 *
 * ── WHAT THIS SCREEN WAS, AND WHY IT ISN'T ONE ANYMORE ───────────────────────
 * It existed because the grid could not ask the publishing question at all.
 * Four separate gaps, each of which has since been closed IN the grid:
 *
 *  - THE POPULATION. The grid's `uncoded` facet keys off `requiresCoding`,
 *    which grandfathers everything posted before the coding policy date, so the
 *    ~450 rows reconstructed from the org's imported 2024-25 records were exempt
 *    by calendar and unreachable. The `needs_explaining` filter is the
 *    PUBLISHING predicate (`explanationPopulation`, no policy date) — the same
 *    function `monthCodingWorklist` used, not a second copy of it.
 *  - BIGGEST FIRST. `sort=amount` orders by ABSOLUTE cents across the whole
 *    match set before paging, which is what made this screen's ordering
 *    honest and was the entire justification for it.
 *  - ONE MONTH AT A TIME, WITH A METER. `group=month` bands the grid by month,
 *    each band carrying that month's OWN progress — including the live/backlog
 *    split, so a month holding 450 reconstructed rows and 3 live ones does not
 *    read as "3% explained".
 *  - THE RECEIPT WHILE TYPING. The grid opens `CodingWorkbenchPanel` as a side
 *    panel, the same component this screen mounted.
 *
 * A redirect rather than a plain deletion, because the path is already out in
 * the world: the publish console links here from its unexplained-lines
 * disclosure, mail and bookmarks point at it, and both `?period=` and `?scope=`
 * deep links are shareable and get bookmarked. A 404 on any of those would be a
 * regression dressed as a cleanup.
 *
 * ── THE PARAMETER MAPPING ────────────────────────────────────────────────────
 * `?period=YYYY-MM` becomes the grid's own period narrowing (`year`/`month`/
 * `period=month`), which reads the SAME Eastern-time window this screen read —
 * so the redirected month holds exactly the rows the month stepper here held,
 * and the grid's own ← / → step it onwards.
 *
 * `?scope=` needs TRANSLATING rather than forwarding, because the two screens
 * speak different scope vocabularies. This screen took ONE book
 * (`Id<"chapters"> | "central"`); the grid takes `scope: "central" | "all" |
 * "chapter"` with the chapter named separately in `chapterId`. A chapter id
 * handed to the grid's `?scope=` matches none of its three words, falls back to
 * the caller's desk, and silently shows a different book than the link
 * promised — the same class of failure `bookScope.ts` exists to prevent, just
 * pointing the other way. So a chapter id goes to `?chapterId=`, and only the
 * literal `central` goes to `?scope=`.
 *
 * An absent or unparseable param is DROPPED rather than guessed, landing on the
 * unscoped view of the caller's own desk — exactly what this screen did when it
 * was handed the same thing.
 */
import { Redirect, useLocalSearchParams } from "expo-router";
import { parsePeriodKey } from "@events-os/shared";
import { byMonthHref } from "../../../components/finance/byMonthHref";

export default function ExplainRedirect() {
  const params = useLocalSearchParams<{ period?: string; scope?: string }>();
  // `parsePeriodKey` is the same validator this screen used to decide whether
  // to honour `?period=` at all, so a malformed one is dropped here exactly as
  // it was ignored there. `byMonthHref` owns the rest — including the scope
  // translation described above, which the publish console's own link needs
  // done identically.
  return (
    <Redirect
      href={byMonthHref({
        period: params.period ? parsePeriodKey(params.period) : null,
        scope: params.scope,
      })}
    />
  );
}
