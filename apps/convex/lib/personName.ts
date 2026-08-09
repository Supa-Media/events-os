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

/**
 * The `firstName` half implied by giving an UNSPLIT person a last name.
 *
 * A person whose display name never split (`splitPersonName` returns null for
 * a mononym or a 3+-token name) stores NO halves at all, so the roster grid's
 * Last Name cell has nothing to edit. Letting it be edited anyway needs an
 * answer for the OTHER half, and there are exactly two honest readings of
 * what the typist meant:
 *
 *   - the surname they typed is already the TAIL of the display name
 *     ("Van Der Berg" of "Mary Jo Van Der Berg") → they are DESIGNATING which
 *     tokens are the surname. The first half is the remainder, and the
 *     recomposed display name is byte-for-byte what it already was.
 *   - it isn't ("Smith" for "Cher") → they are ADDING a surname the record
 *     never had. The whole existing display name becomes the first half and
 *     the composed name grows by that surname.
 *
 * Matching is case-insensitive but TOKEN-ALIGNED, so "Berg" can't eat the tail
 * of "Vanderberg" and silently leave a first name of "Vander".
 */
export function firstNameForDesignatedLast(name: string, lastName: string): string {
  const nameTokens = name.trim().split(/\s+/).filter(Boolean);
  const lastTokens = lastName.trim().split(/\s+/).filter(Boolean);
  // Nothing to strip, or the surname is the whole name — treat it as an
  // addition, never as a designation that would leave an empty first half.
  if (lastTokens.length === 0 || lastTokens.length >= nameTokens.length) {
    return name.trim();
  }
  const head = nameTokens.slice(0, nameTokens.length - lastTokens.length);
  const tail = nameTokens.slice(nameTokens.length - lastTokens.length);
  const isDesignation = tail.every(
    (token, i) => token.toLowerCase() === lastTokens[i].toLowerCase(),
  );
  return isDesignation ? head.join(" ") : name.trim();
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
