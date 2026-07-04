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
