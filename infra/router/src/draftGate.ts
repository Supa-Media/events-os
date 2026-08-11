/**
 * The password gate in front of unpublished blog posts.
 *
 * A post with `draft: true` in its frontmatter builds to /blog/drafts/<slug>
 * instead of /blog/<slug> (apps/landing/src/pages/blog/), stays out of the
 * index, the RSS feed, and the sitemap, and carries `noindex`. None of that
 * stops somebody who guesses the URL — so pw-router holds this gate in front
 * of the whole prefix, and it is the only thing that actually keeps a draft
 * private. It exists so a work-in-progress can be SHARED (with an editor, a
 * pastor, a collaborator) before it is published, without shipping it to the
 * open web first.
 *
 * The shape is deliberately minimal: one shared password, exchanged for a
 * cookie. Not per-person, no audit trail — everyone with the link gets the
 * same password, and changing it revokes everyone at once.
 *
 * Know what this is worth today: `DRAFT_PASSWORD` is currently a plaintext
 * var in wrangler.jsonc, in a PUBLIC repository, so the password is public
 * too. What this gate actually buys in that configuration is keeping drafts
 * off guessable URLs and out of crawlers' reach — not secrecy from anyone
 * who thinks to read the config. Treat a draft as "not yet announced", never
 * as "confidential", and put nothing in one that would matter if read early.
 * wrangler.jsonc documents the two-step upgrade to a real Worker secret,
 * which is what makes it private for real.
 *
 * The cookie stores a SHA-256 of the password rather than the password
 * itself, so a stolen cookie can't be read back into the shared secret and
 * pasted into a group chat. Comparison is length-safe and time-independent
 * to keep the check from leaking the token a character at a time.
 *
 * Kept free of Workers-runtime types (Request/Response/fetch) like route.ts,
 * so the rules can be unit-tested under plain Node — `crypto.subtle` is
 * available in both runtimes.
 */

/** Cookie holding the derived token. Scoped to the drafts prefix, not "/". */
export const DRAFT_COOKIE = "pw_draft";

/** Namespaced so the digest can never collide with another hash of the same
 *  secret used elsewhere. Bump to invalidate every outstanding cookie. */
const TOKEN_NAMESPACE = "pw-draft-v1";

export type DraftDecision =
  /** Cookie (or a just-accepted password) checks out — serve the draft. */
  | { kind: "allow" }
  /** Correct password submitted: set the cookie, then redirect to a clean URL
   *  so the password stops riding along in the address bar and Referer. */
  | { kind: "grant"; token: string }
  /** Show the password form. `wrongPassword` distinguishes a fresh visit from
   *  a failed attempt so the form can say so. */
  | { kind: "challenge"; wrongPassword: boolean }
  /** No DRAFT_PASSWORD secret configured — fail CLOSED, never open. */
  | { kind: "unavailable" };

/** SHA-256 of the namespaced password, lowercase hex. */
export async function draftToken(password: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${TOKEN_NAMESPACE}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compare without leaking where two strings diverge. Length is compared
 * first and separately — that much is already public (the digest is a fixed
 * 64 hex chars), and it keeps the loop from running off the end.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Pull one cookie's value out of a raw `Cookie:` header. */
export function readCookie(
  cookieHeader: string | null,
  name: string,
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export interface DraftGateInput {
  /** The `DRAFT_PASSWORD` Worker secret, if it is configured at all. */
  password: string | undefined;
  /** Raw `Cookie:` request header. */
  cookieHeader: string | null;
  /** Password just submitted via the form (or `?pw=`), if any. */
  submitted: string | null;
}

/** Decide what to do with one request for a draft URL. */
export async function decideDraftAccess(
  input: DraftGateInput,
): Promise<DraftDecision> {
  const { password, cookieHeader, submitted } = input;

  // No secret configured → nobody gets in, including us. A gate that opens
  // when its config is missing is not a gate.
  if (!password) return { kind: "unavailable" };

  const expected = await draftToken(password);

  // A submitted password wins over the cookie, so a rotated secret can be
  // re-entered without the stale cookie having to be cleared first.
  if (submitted !== null && submitted !== "") {
    if (safeEqual(await draftToken(submitted), expected)) {
      return { kind: "grant", token: expected };
    }
    return { kind: "challenge", wrongPassword: true };
  }

  const cookie = readCookie(cookieHeader, DRAFT_COOKIE);
  if (cookie && safeEqual(cookie, expected)) return { kind: "allow" };

  return { kind: "challenge", wrongPassword: false };
}

/**
 * `Set-Cookie` for a granted token. HttpOnly (no script needs to read it),
 * SameSite=Lax (a shared link is a top-level navigation, which Lax allows),
 * and scoped to the drafts prefix so it is never attached to a public page.
 * `Secure` is caller-controlled only so `wrangler dev` works over http.
 */
export function draftCookieHeader(token: string, secure: boolean): string {
  const parts = [
    `${DRAFT_COOKIE}=${token}`,
    "Path=/blog/drafts",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=2592000", // 30 days
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
