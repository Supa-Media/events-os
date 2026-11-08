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

/**
 * The order a reviewer works the queue in: every row they can DECIDE first,
 * then the rows that are waiting on somebody else (in practice, their own
 * codings — separation of duties). Each half keeps the server's order, which
 * is oldest submission first: the queue is a clock, not an inbox.
 *
 * Why split at all: a reviewer's own coding mixed into the list is a card they
 * open, read, and then find they can't act on. Putting them last, under their
 * own heading, keeps "the next thing I can clear" always at the top.
 */
export function reviewOrder<T extends { canReview: boolean }>(
  rows: readonly T[],
): { decidable: T[]; waitingOnOthers: T[] } {
  return {
    decidable: rows.filter((r) => r.canReview),
    waitingOnOthers: rows.filter((r) => !r.canReview),
  };
}

/** The queue's reviewer filter: the codings assigned to the caller, or every
 *  coding they have authority over. */
export type ReviewerFilter = "me" | "all";

type Routed = {
  assignedToMe: boolean;
  reviewer: {
    seatTitle: string;
    scopeName: string;
    names: string[];
    why: "default" | "coded_by_bookkeeper" | "chapter_has_no_reviewer";
  } | null;
};

/**
 * Which filter the queue opens on. An explicit `?who=` wins (the digest
 * email links `who=me`). Otherwise "For me" when anything is assigned to the
 * caller, and "Everyone" when nothing is — a backup reviewer with nothing of
 * their own should not land on an empty list.
 */
export function initialReviewerFilter(
  rows: readonly Routed[],
  param: string | undefined,
): ReviewerFilter {
  if (param === "me" || param === "all") return param;
  return rows.some((r) => r.assignedToMe) ? "me" : "all";
}

export function filterByReviewer<T extends Routed>(
  rows: readonly T[],
  who: ReviewerFilter,
): T[] {
  return who === "me" ? rows.filter((r) => r.assignedToMe) : [...rows];
}

/**
 * The card's "who reviews this" line: "For you · New York Treasurer", or
 * "For Kansi Udochukwu · Financial Manager", plus why when it isn't the
 * normal route. `null` when no seat is assigned.
 */
export function reviewerLine(row: Routed): string | null {
  const r = row.reviewer;
  if (!r) return null;
  const seat =
    r.scopeName === "Central" ? r.seatTitle : `${r.scopeName} ${r.seatTitle}`;
  const who = row.assignedToMe ? "you" : r.names.join(", ");
  const why =
    r.why === "coded_by_bookkeeper"
      ? " (second reviewer: the usual reviewer coded it)"
      : r.why === "chapter_has_no_reviewer"
        ? " (no chapter reviewer free)"
        : "";
  return `For ${who} · ${seat}${why}`;
}

/**
 * One-tap reasons on the send-back sheet. Each fills the note with a sentence
 * that says what would make the coding approvable, because that is the bar
 * the queue sets ("send it back with a note saying exactly what would make it
 * approvable") and a bare "receipt" is not that. The reviewer can edit the
 * text before sending.
 */
export const SEND_BACK_REASONS: readonly { label: string; note: string }[] = [
  {
    label: "Receipt doesn't match",
    note: "The receipt doesn't match the charge amount. Please attach the right one, or explain the difference.",
  },
  {
    label: "Receipt unreadable",
    note: "I can't read the receipt. Please attach a clearer copy.",
  },
  {
    label: "Purpose too vague",
    note: "The purpose is too vague for the public ledger. Say what it bought and which event or work it served.",
  },
  {
    label: "Who was there?",
    note: "Please list who was there and how each person is connected to Public Worship.",
  },
];

/** Picking a reason replaces a note that is empty or is itself an untouched
 *  reason, and is appended to anything the reviewer typed — tapping a chip
 *  must never throw away their own words. */
export function applySendBackReason(current: string, reasonNote: string): string {
  const trimmed = current.trim();
  if (trimmed === "" || SEND_BACK_REASONS.some((r) => r.note === trimmed)) {
    return reasonNote;
  }
  if (trimmed.includes(reasonNote)) return current;
  return `${trimmed} ${reasonNote}`;
}
