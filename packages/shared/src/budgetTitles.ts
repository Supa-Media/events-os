/**
 * WHAT A BUDGET IS CALLED.
 *
 * Founder, 2026-08-14: "when a budget is based on an Event template, it should
 * get its title from the event template — if there are multiple use the year to
 * distinguish, and if multiple in the year use month and year."
 *
 * A budget linked to an event used to inherit that event's own name, which is
 * whatever somebody typed when they created it: "Genesis LTN", "genesis night
 * 3", "Genesis (FINAL)". Three budgets for the same recurring event read as
 * three unrelated things, and the list can't be scanned. The TEMPLATE name is
 * the stable one — it's the thing the org actually says out loud — so that's
 * the title, and the date is used only as much as it needs to be.
 *
 * ── PRECISION IS ADDED ONLY WHERE IT'S EARNED ───────────────────────────────
 * The rule is deliberately not "always show the date". A chapter with one
 * Genesis budget should see "Genesis", not "Genesis Oct 2026" — the date is
 * noise until there is something to tell apart. So:
 *
 *   one budget on a template          → "Genesis"
 *   several, in different years       → "Genesis 2025", "Genesis 2026"
 *   several within one year           → "Genesis Mar 2026", "Genesis Oct 2026"
 *
 * Mixed cases resolve per YEAR, not per template: if a template has one budget
 * in 2025 and three in 2026, the 2025 one is "Genesis 2025" and the 2026 ones
 * carry months. Disambiguation is a property of the collision, and a year with
 * no collision shouldn't pay for one somewhere else.
 *
 * ── WHAT IT REFUSES TO GUESS ────────────────────────────────────────────────
 * A budget with no template (a project, a standalone label) keeps its own
 * name — this function never invents one. And a template-linked budget with NO
 * date that needs disambiguating falls back to its own name too, because
 * "Genesis" twice in a list is worse than one "Genesis" and one "genesis night
 * 3": at least the second pair can be told apart.
 *
 * Pure and total, so the rule is testable without a database and identical on
 * every surface that renders a budget name.
 */

/** Eastern — the timezone every date in this codebase is bucketed by. */
const TZ = "America/New_York";

export interface BudgetTitleInput {
  /** Stable identity for the row; the returned map is keyed by it. */
  key: string;
  /**
   * The event TEMPLATE's name ("Genesis"), when this budget is linked to a
   * live event. `null` for a project budget, a recurring bucket, a budget
   * whose event was deleted, or an event with no resolvable template — all of
   * which keep `fallbackName`.
   */
  templateName: string | null;
  /** What to call it when there's no template, or when a template-linked
   *  budget can't be disambiguated for lack of a date. */
  fallbackName: string;
  /** The linked event's date. Only ever used to break a tie. */
  date: number | null;
}

/** `{ year, month }` in Eastern. Local to this module so the rule stays pure
 *  (the finance helpers that do this live in the Convex package). */
function easternYearMonth(ts: number): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(ts));
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  return { year, month };
}

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Resolve every budget's display title at once — as a set, because "is this
 * name ambiguous?" is a question about the whole list and cannot be answered
 * one row at a time.
 *
 * Returns a map from `key` to title. Every input key is present in the output.
 */
export function resolveBudgetTitles(
  rows: readonly BudgetTitleInput[],
): Map<string, string> {
  const out = new Map<string, string>();

  // Templated rows, grouped by template name. Everything else takes its own
  // name and needs no further thought.
  const byTemplate = new Map<string, BudgetTitleInput[]>();
  for (const row of rows) {
    const name = row.templateName?.trim();
    if (!name) {
      out.set(row.key, row.fallbackName);
      continue;
    }
    const list = byTemplate.get(name) ?? [];
    list.push(row);
    byTemplate.set(name, list);
  }

  for (const [templateName, group] of byTemplate) {
    // The common case: this template has exactly one budget, so the template
    // name IS the title and no date is shown.
    if (group.length === 1) {
      out.set(group[0].key, templateName);
      continue;
    }

    // Several budgets share a template. Split by year, and let each year
    // decide for itself how much precision it needs.
    const byYear = new Map<number, BudgetTitleInput[]>();
    const dateless: BudgetTitleInput[] = [];
    for (const row of group) {
      if (row.date == null) {
        dateless.push(row);
        continue;
      }
      const { year } = easternYearMonth(row.date);
      const list = byYear.get(year) ?? [];
      list.push(row);
      byYear.set(year, list);
    }

    // A dateless sibling took its OWN name above, so it is no longer
    // competing for "Genesis" — and if that leaves exactly one dated row in
    // the whole group, there is nothing left to tell apart and it gets the
    // bare template name. Precision is earned by an actual collision among the
    // rows that will carry a template-derived title, not by group size.
    const dated = [...byYear.values()].flat();
    if (dated.length <= 1) {
      // Zero dated rows is a real case (a group where nothing has a date), and
      // indexing into an empty group would throw — so this covers both it and
      // the single-dated case with the same line.
      if (dated.length === 1) out.set(dated[0].key, templateName);
      for (const row of dateless) out.set(row.key, row.fallbackName);
      continue;
    }

    for (const [year, yearRows] of byYear) {
      if (yearRows.length === 1) {
        out.set(yearRows[0].key, `${templateName} ${year}`);
        continue;
      }
      for (const row of yearRows) {
        const { month } = easternYearMonth(row.date!);
        out.set(row.key, `${templateName} ${MONTH_ABBR[month - 1]} ${year}`);
      }
    }

    // No date to disambiguate with. Its own name is worse-looking and more
    // useful than a second identical "Genesis" — see this module's header.
    for (const row of dateless) out.set(row.key, row.fallbackName);
  }

  return out;
}
