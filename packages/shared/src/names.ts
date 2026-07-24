/**
 * Name-formatting helpers shared by BOTH the Convex backend and the Expo app.
 *
 * `firstNameOf` centralizes the `name.split(/\s+/)[0]` idiom repeated across
 * `apps/convex/ticketingEmails.ts` (RSVP + donation + pledge receipts) and
 * `apps/convex/reminders.ts` — each site trims/falls-back slightly differently
 * today, which is exactly the kind of drift a shared helper exists to kill.
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
