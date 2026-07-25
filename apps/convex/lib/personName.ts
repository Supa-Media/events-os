/**
 * Structured-name split (founder ask, 2026-07-25): `people.name` stays the
 * canonical display string; `firstName`/`lastName` are derived halves used
 * for personalization and pre-split imports. ONE splitting rule, used by
 * migration 0043's backfill and every rename write-through, so the halves
 * can never disagree about what "splittable" means:
 *
 *   - exactly TWO whitespace-separated tokens → { first, last };
 *   - anything else — single-word names, three-plus tokens ("Ama (Gina)
 *     Oppong Asante", "Mary Jo Van Der Berg"), empty — → null. Guessing
 *     which middle tokens belong to which half mislabels real people's
 *     names; an absent split is honest, a wrong one isn't. ("When we can" —
 *     the founder's own scoping.)
 *
 * Composition goes the other way too: `composeName` builds the display
 * string from pre-split halves (imports that arrive structured), so the
 * display convention ("First Last", single-spaced) lives here once.
 */

export function splitPersonName(name: string): { firstName: string; lastName: string } | null {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length !== 2) return null;
  return { firstName: tokens[0], lastName: tokens[1] };
}

export function composeName(firstName?: string | null, lastName?: string | null): string {
  return [firstName?.trim(), lastName?.trim()].filter(Boolean).join(" ");
}

/** The patch a rename write-through applies alongside `name` itself: fresh
 *  halves on a clean split, EXPLICIT clears on an ambiguous one (leaving
 *  stale halves from the old name would be wrong data, not missing data). */
export function nameHalvesPatch(name: string): {
  firstName: string | undefined;
  lastName: string | undefined;
} {
  const split = splitPersonName(name);
  return { firstName: split?.firstName, lastName: split?.lastName };
}
