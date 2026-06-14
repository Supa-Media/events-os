/**
 * App-layer access control for Events OS.
 *
 * Auth is framework-owned (email OTP via @supa-media/convex). There's no
 * framework hook to restrict the email domain, so the "publicworship.life only"
 * rule lives here and is enforced on every data function (see context.ts, which
 * calls `requireAccess` from both chapter resolvers).
 */
import { getOptionalAuth } from "@supa-media/convex/auth";
import { ConvexError } from "convex/values";

/** Only emails on this domain may use the app. No exceptions. */
export const ALLOWED_EMAIL_DOMAIN = "publicworship.life";

/** True iff the (lowercased) email ends with `@publicworship.life`. */
export function isAllowedEmail(email?: string | null): boolean {
  if (!email) return false;
  return email.trim().toLowerCase().endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);
}

/** The authenticated user's email, or null (does not throw on signed-out). */
export async function getUserEmail(ctx: any): Promise<string | null> {
  const user = await getOptionalAuth(ctx);
  return (user?.email as string | undefined) ?? null;
}

/**
 * Assert the caller is signed in AND on an allowed email domain. Throws a
 * ConvexError (so the app's AuthErrorBoundary can surface it) otherwise.
 */
export async function requireAccess(ctx: any): Promise<void> {
  const email = await getUserEmail(ctx);
  if (!isAllowedEmail(email)) {
    throw new ConvexError({
      code: "ACCESS_DENIED",
      message: "Only publicworship.life accounts can access Events OS.",
    });
  }
}
