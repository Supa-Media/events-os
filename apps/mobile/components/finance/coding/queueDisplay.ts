/**
 * Pure display logic for the Coding tab's review queue.
 *
 * Split out of `ReviewQueue.tsx` because that file imports React Native and
 * this repo's mobile tests run in a node environment with no renderer — the
 * house pattern is to keep the decidable part dependency-free and test it
 * here (see `myTransactions/chargeTodo.ts`, same split, same reason).
 *
 * What's decidable, and worth pinning: the one line that tells a reviewer WHO
 * WAS INVOLVED without them opening the row. Getting it wrong is not cosmetic
 * — it is the §274(d) business-relationship element, and a reviewer who can't
 * see it is approving a claim they haven't read.
 */

/** The substantiation elements a coding carries beyond its purpose, rendered
 *  as one line. `null` when the expense type owes none (a general charge is
 *  fully described by its purpose). */
export function substantiationLine(
  coding: {
    /** FINDING 2 (UX audit, 2026-08-12): lodging asks ONE place, not a
     *  route — optional so every pre-existing travel-only caller/test keeps
     *  working unchanged; only `"lodging"` takes the one-place branch. */
    expenseType?: string | null;
    travelFrom: string | null;
    travelTo: string | null;
    headcount: number | null;
    attendees: { name: string }[] | null;
    groupDescription: string | null;
    affiliationBreakdown: Record<string, number>;
  },
  /** Affiliation display labels, injected so this file stays free of the
   *  shared package's import graph. */
  affiliationLabels: Record<string, string> = {},
): string | null {
  // Lodging: one place, not a route — "Boston → New York" reads as a route
  // for a stay that never had a departure city. `null` (not "? → City") when
  // the place is genuinely missing; "?" belongs to travel's half-known
  // route, not to a field lodging never asked for.
  if (coding.expenseType === "lodging") {
    return coding.travelTo ? `Stayed in ${coding.travelTo}` : null;
  }
  // Travel: the route. A half-known route still renders — "?" is more
  // useful to a reviewer than silence, because a missing leg is exactly the
  // kind of thing they should send back.
  if (coding.travelFrom || coding.travelTo) {
    return `${coding.travelFrom ?? "?"} → ${coding.travelTo ?? "?"}`;
  }
  // Meals: headcount always, plus whoever it can name. Names when the caller
  // may see them and there are any; otherwise the group description the
  // over-threshold rule requires; otherwise the affiliation breakdown, which
  // is what the public ledger would print.
  if (coding.headcount != null) {
    const who =
      coding.attendees && coding.attendees.length > 0
        ? coding.attendees.map((a) => a.name).join(", ")
        : (coding.groupDescription ??
          breakdownLine(coding.affiliationBreakdown, affiliationLabels));
    return who
      ? `${coding.headcount} people — ${who}`
      : `${coding.headcount} people`;
  }
  return null;
}

/** "5 volunteers, 3 community members" — the redacted rendering, and the one
 *  the public ledger uses. `labels` is injected so this stays free of the
 *  shared package's import graph. */
export function breakdownLine(
  breakdown: Record<string, number>,
  labels: Record<string, string> = {},
): string {
  return Object.entries(breakdown)
    .map(([affiliation, count]) => {
      const label = labels[affiliation] ?? affiliation;
      return `${count} ${label.toLowerCase()}${count === 1 ? "" : "s"}`;
    })
    .join(", ");
}

/** Whole days a coding has been sitting in review. Never negative — a clock
 *  skew shouldn't render "waiting -1 days". */
export function daysWaiting(submittedAt: number, now = Date.now()): number {
  return Math.max(0, Math.floor((now - submittedAt) / 86_400_000));
}

/** Every distinct book present in a page of rows, in first-seen order — the
 *  Book column's filter options. */
export function booksInRows(
  rows: { book: { id: string; name: string } }[],
): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const r of rows) seen.set(r.book.id, r.book.name);
  return [...seen].map(([id, name]) => ({ id, name }));
}
