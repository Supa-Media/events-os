/**
 * People-roster ↔ user-account coupling helpers.
 *
 * Backend access is gated to @publicworship.life accounts (see lib/access.ts),
 * so a signed-in user's email is ALWAYS their publicworship address. A roster
 * person, however, may carry a personal email on `email` and the publicworship
 * address on `pwEmail` (core team are imported that way). To keep User and
 * People tightly coupled — one person row per human, claimed via `userId` — any
 * place that links an account to the roster must match on EITHER address before
 * inserting a fresh row, or it will silently duplicate the person on first
 * sign-in / first event creation.
 */

/**
 * Find a roster person in `chapterId` not yet linked to a user account whose
 * personal `email` OR publicworship `pwEmail` matches `email` (case-insensitive).
 * Returns the person doc, or null when there's no unlinked match.
 */
export async function findUnlinkedPersonByLoginEmail(
  ctx: any,
  chapterId: string,
  email?: string | null,
): Promise<any | null> {
  const target = email?.trim().toLowerCase();
  if (!target) return null;
  const roster = await ctx.db
    .query("people")
    .withIndex("by_chapter", (q: any) => q.eq("chapterId", chapterId))
    .collect();
  return (
    roster.find(
      (p: any) =>
        p.userId == null &&
        (p.email?.trim().toLowerCase() === target ||
          p.pwEmail?.trim().toLowerCase() === target),
    ) ?? null
  );
}

/**
 * Fields to claim an unlinked roster row for `userId` on sign-in. Records the
 * publicworship login address as `pwEmail` (the canonical backend identity) and
 * only fills the personal `email` when the row has none — never clobbering an
 * existing personal address with the login email.
 */
export function claimFields(
  existing: { email?: string; pwEmail?: string },
  userId: string,
  loginEmail?: string | null,
): Record<string, unknown> {
  const fields: Record<string, unknown> = { userId, isTeamMember: true };
  const login = loginEmail?.trim() || undefined;
  if (login) {
    fields.pwEmail = existing.pwEmail ?? login;
    if (!existing.email) fields.email = login;
  }
  return fields;
}
