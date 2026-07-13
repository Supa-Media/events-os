/**
 * App-layer access control for Events OS.
 *
 * Auth is framework-owned (email OTP via @supa-media/convex). There's no
 * framework hook to restrict the email domain, so the access rule lives here and
 * is enforced on every data function (see context.ts, which calls `requireAccess`
 * from both chapter resolvers).
 *
 * Two ways in:
 *   1. Any `@publicworship.life` address (`isAllowedEmail`).
 *   2. An individual email seeded into the allowlist (`isGuestAllowed`) — the
 *      guest-login path. Seeded from Convex only; see `accessAllowlist.ts`.
 *      Reads the `accessAllowlist` table only (the legacy `guestAllowlist` rows
 *      were folded in by the `copyGuestAllowlist` migration).
 */
import { getOptionalAuth } from "@supa-media/convex/auth";
import { ConvexError } from "convex/values";

/** Members' email domain. Any address here is allowed without seeding. */
export const ALLOWED_EMAIL_DOMAIN = "publicworship.life";

/** Trim + lowercase an email, or null if empty/absent. */
export function normalizeEmail(email?: string | null): string | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  return normalized.length ? normalized : null;
}

/** True iff the (lowercased) email ends with `@publicworship.life`. */
export function isAllowedEmail(email?: string | null): boolean {
  const normalized = normalizeEmail(email);
  return !!normalized && normalized.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);
}

/**
 * True iff the email has an active `accessAllowlist` row. The legacy
 * `guestAllowlist` rows were copied into `accessAllowlist` by the
 * `copyGuestAllowlist` migration, so this reads the new table ONLY. Needs
 * `ctx.db`, so it's only callable from queries/mutations (actions resolve
 * context through an internalQuery).
 */
export async function isGuestAllowed(
  ctx: any,
  email?: string | null,
): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const access = await ctx.db
    .query("accessAllowlist")
    .withIndex("by_email", (q: any) => q.eq("email", normalized))
    .first();
  return !!access && access.isActive !== false;
}

/**
 * True iff the email may use the app — a domain member OR a seeded guest.
 * The single source of truth for "is this account allowed in".
 */
export async function hasAccess(
  ctx: any,
  email?: string | null,
): Promise<boolean> {
  if (isAllowedEmail(email)) return true;
  return await isGuestAllowed(ctx, email);
}

/** The authenticated user's email, or null (does not throw on signed-out). */
export async function getUserEmail(ctx: any): Promise<string | null> {
  const user = await getOptionalAuth(ctx);
  return (user?.email as string | undefined) ?? null;
}

/**
 * Assert the caller is signed in AND allowed (domain member or seeded guest).
 * Throws a ConvexError (so the app's AuthErrorBoundary can surface it) otherwise.
 */
export async function requireAccess(ctx: any): Promise<void> {
  const email = await getUserEmail(ctx);
  if (!(await hasAccess(ctx, email))) {
    throw new ConvexError({
      code: "ACCESS_DENIED",
      message: "This account isn't approved for Events OS.",
    });
  }
}
