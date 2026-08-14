/**
 * WHAT THE RECURRING SECTION ADDS UP TO — pure, so the headline the Budgets
 * tab prints above the standing buckets is testable without a `react-native`
 * import (same split as `recurringPeriodSummary`, next door).
 *
 * Founder, 2026-08-14: "does budgeted and spent take into consideration
 * recurring budgets? it doesn't seem like it — monthly spend and quarterly
 * spend, and monthly budget and quarterly budget are missing here."
 *
 * ── WHY THIS IS ITS OWN STRIP, BY WINDOW ────────────────────────────────────
 * The Events & projects strip must NOT absorb these numbers, and the reason is
 * the one already written at the top of `budgets.tsx`: a one-time budget's cap
 * is a LIFETIME plan for a thing that happens once, and a recurring bucket's
 * cap governs ONE cadence window. Adding a $4,000 event cap to a $500-a-month
 * coffee cap produces $4,500 of nothing — not a month, not a year, not a plan.
 * Summing them was removed on purpose; this file exists so the recurring half
 * gets a headline of its own rather than getting folded back in.
 *
 * So the frame is the WINDOW, one row per cadence: this month across every
 * monthly bucket, this quarter across every quarterly one. Within a row the
 * unit is identical for every budget in it, which is the whole test for
 * whether a sum means anything.
 *
 * ── WHERE THE NUMBERS COME FROM ─────────────────────────────────────────────
 * Straight off the rows — `capCents` / `spentCents` / `remainingCents` are
 * EXACTLY the three figures each `BudgetGlanceCard` prints in its header for
 * the current window ("$840.00 of $1,200.00 this month · $360.00 left"), so
 * the strip is the visible sum of the cards under it and cannot drift from
 * them. `remainingCents` is summed rather than recomputed as cap − spent for
 * the same reason: if the server ever changes what "left" means, the headline
 * changes with the cards instead of quietly contradicting them.
 *
 * This deliberately does NOT reuse `recurringPeriodSummary`. That one answers
 * a different question — what a single bucket's YEAR looks like window by
 * window, including a forecast for windows that haven't happened. Nothing
 * projected may ever reach this strip: these are current-window figures, all
 * of them money that has actually moved.
 */

/** The `budgetsGlance` recurring row, narrowed to what the totals need. */
export type RecurringRowLike = {
  cadence: string;
  capCents: number;
  spentCents: number;
  remainingCents: number;
};

export type RecurringWindowTotal = {
  cadence: string;
  /** Plain words for the window, matching what the cards below already say
   *  ("$X of $Y **this month**") — see `CADENCE_LABELS` in BudgetGlanceCard. */
  label: string;
  /** How many buckets are in this row, so the headline can say what it counted. */
  count: number;
  capCents: number;
  spentCents: number;
  remainingCents: number;
};

/**
 * The window each cadence reports against, in the order the strip renders.
 *
 * YEARLY GETS ITS OWN ROW rather than being folded into another or dropped.
 * Folding is the unit error above — a year's cap is not a month's. Dropping it
 * would hide money that IS rendered on a card immediately below the strip,
 * which is the same silence this whole change is fixing. And a yearly bucket's
 * window genuinely is the page ("for the yearly budgets it's fine because
 * obviously each page is a year"), so "This year" sits in the strip's frame
 * without bending it.
 */
const WINDOW_LABELS: { cadence: string; label: string }[] = [
  { cadence: "monthly", label: "This month" },
  { cadence: "quarterly", label: "This quarter" },
  { cadence: "yearly", label: "This year" },
];

/** Anything else on a RECURRING row is a data anomaly — `per_instance` and
 *  `one_off` don't repeat, so a budget typed `recurring` carrying one has no
 *  named window (the server scopes it to a month; the card prints no window
 *  either). Such rows are grouped under one honest, vague heading rather than
 *  being silently omitted from a strip that sits above their cards, and
 *  rather than being counted as months they aren't. */
const OTHER_KEY = "other";
const OTHER_LABEL = "This period";

/**
 * One total per cadence actually present, in `WINDOW_LABELS` order. A cadence
 * with no budgets produces NO row — an empty "This quarter · $0.00 of $0.00"
 * reads as a chapter that blew through nothing rather than as a chapter that
 * has no quarterly buckets.
 */
export function recurringWindowTotals(
  rows: RecurringRowLike[],
): RecurringWindowTotal[] {
  const known = new Set(WINDOW_LABELS.map((w) => w.cadence));
  const byCadence = new Map<string, RecurringWindowTotal>();

  for (const row of rows) {
    const key = known.has(row.cadence) ? row.cadence : OTHER_KEY;
    const existing = byCadence.get(key);
    if (existing) {
      existing.count += 1;
      existing.capCents += row.capCents;
      existing.spentCents += row.spentCents;
      existing.remainingCents += row.remainingCents;
      continue;
    }
    byCadence.set(key, {
      cadence: key,
      label:
        WINDOW_LABELS.find((w) => w.cadence === key)?.label ?? OTHER_LABEL,
      count: 1,
      capCents: row.capCents,
      spentCents: row.spentCents,
      remainingCents: row.remainingCents,
    });
  }

  const ordered = WINDOW_LABELS.map((w) => byCadence.get(w.cadence)).filter(
    (t): t is RecurringWindowTotal => t != null,
  );
  const other = byCadence.get(OTHER_KEY);
  return other ? [...ordered, other] : ordered;
}
