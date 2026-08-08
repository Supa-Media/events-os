/**
 * Pure sign-in helpers for `app/(auth)/login.tsx`.
 *
 * These live OUTSIDE `app/` on purpose. Expo Router treats every `.ts`/`.tsx`
 * under the app root as a route — its `require.context` (expo-router/_ctx)
 * matches everything except `+api`/`+middleware`/`+html`/`+native-intent`, and
 * there is no exclusion setting. A non-route module colocated there becomes a
 * phantom route, and a colocated `*.test.ts` is worse than phantom: Metro
 * bundles it into the app, its `@jest/globals` import throws on load, and the
 * whole app dies at startup with "Do not import `@jest/globals` outside of the
 * Jest test environment". Keep `app/` to routes only; helpers, hooks and their
 * tests belong here.
 */

/** The members' email domain. Guests sign in with a full off-domain email. */
export const ALLOWED_DOMAIN = "publicworship.life";

/** Sign-in identity: a domain member (username) or an invited guest (email). */
export type Mode = "member" | "guest";

/**
 * Turn a username into the full email on the allowed domain.
 *
 * Accepts either a bare username ("jane") or a full address ("jane@…"); we
 * strip everything from the "@" on so a pasted full email still works, then
 * append the allowed domain.
 */
export function toEmail(username: string): string {
  const local = username.trim().split("@")[0].toLowerCase();
  return `${local}@${ALLOWED_DOMAIN}`;
}

/** Loose email sanity check for the guest field (server is the real gate). */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/** Derives the login screen's initial mode/email from a `?guestEmail=`
 *  deep link (what `guestSignInUrl` in the backend composes). A present,
 *  non-empty value means "arrive already in guest mode, pre-filled" —
 *  absent/empty preserves today's default (member mode, blank fields). */
export function initialGuestState(
  guestEmailParam: string | undefined,
): { mode: Mode; guestEmail: string } {
  const email = guestEmailParam?.trim() ?? "";
  return email ? { mode: "guest", guestEmail: email } : { mode: "member", guestEmail: "" };
}
