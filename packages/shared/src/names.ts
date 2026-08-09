/**
 * Name-formatting helpers shared by BOTH the Convex backend and the Expo app.
 *
 * `firstNameOf` centralizes the `name.split(/\s+/)[0]` idiom repeated across
 * `apps/convex/ticketingEmails.ts` (RSVP + donation + pledge receipts) and
 * `apps/convex/reminders.ts` — each site trims/falls-back slightly differently
 * today, which is exactly the kind of drift a shared helper exists to kill.
 *
 * The STRUCTURED-NAME rules below (split / compose / designate) live here for
 * the same reason, and they moved here from `apps/convex/lib/personName.ts`
 * the moment a second caller appeared: the People detail sheet needs to
 * predict, in the browser, exactly what `people.update` will store on the
 * server. Two copies of "which tokens are the surname" that disagreed would
 * be worse than the bug that motivated the rule.
 */

/**
 * The first token of a person's name, for salutations ("Hey, {firstName}").
 * Trims surrounding whitespace, collapses internal runs of whitespace, and
 * falls back to `fallback` ("friend" by default) when `fullName` is null,
 * undefined, or resolves to an empty string after trimming. A single-word
 * name returns that word unchanged.
 */
export function firstNameOf(
  fullName: string | null | undefined,
  fallback = "friend",
): string {
  const trimmed = fullName?.trim();
  if (!trimmed) return fallback;
  const first = trimmed.split(/\s+/)[0];
  return first || fallback;
}

/**
 * A presentable display name: the trimmed `name` when it's non-empty,
 * otherwise the local part of `email` (the bit before `@`) — still better
 * than showing nothing, or the raw address, for a guest who never gave a
 * name. Falls back to the untouched `email` if it has no `@` (or is itself
 * empty) so this never returns an empty string when `email` isn't.
 */
export function displayNameOf(
  name: string | null | undefined,
  email: string,
): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  const at = email.indexOf("@");
  if (at > 0) return email.slice(0, at);
  return email;
}

// ── Structured names: `people.name` ↔ `firstName`/`lastName` ─────────────────

/**
 * The ONE splitting rule, shared by migration 0043's backfill, every rename
 * write-through, and the imports — so the halves can never disagree about
 * what "splittable" means:
 *
 *   - exactly TWO whitespace-separated tokens → { first, last };
 *   - anything else — single-word names, three-plus tokens ("Ama (Gina)
 *     Oppong Asante", "Mary Jo Van Der Berg"), empty — → null. Guessing which
 *     middle tokens belong to which half mislabels real people's names; an
 *     absent split is honest, a wrong one isn't.
 *
 * `people.name` stays the canonical display string throughout; the halves are
 * derived, and are used for personalization and for pre-split imports.
 */
export function splitPersonName(name: string): { firstName: string; lastName: string } | null {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length !== 2) return null;
  return { firstName: tokens[0], lastName: tokens[1] };
}

/** The display string built from pre-split halves (imports that arrive
 *  structured, and every recompose after a half is edited), so the display
 *  convention ("First Last", single-spaced) lives in one place. */
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
