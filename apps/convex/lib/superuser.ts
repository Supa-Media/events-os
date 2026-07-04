/**
 * Superuser allowlist.
 *
 * Superusers are a fixed set of emails (MVP). They're the only accounts allowed
 * to change deployment-wide AI settings (e.g. the active model) and to manage
 * the guest allowlist (grant/revoke guest access) from the app. Enforced on the
 * server — UI hiding is purely cosmetic.
 */
import { ConvexError } from "convex/values";
import { Id } from "../_generated/dataModel";
import { requireUserId } from "./context";

export const SUPERUSER_EMAILS = [
  "lkupo@publicworship.life",
  "seyi@publicworship.life",
  "seyi@events.com",
  "test@events.com",
  "seyi@events.test",
];

/** True iff the (lowercased) email is in the superuser allowlist. */
export function isSuperuserEmail(email?: string | null): boolean {
  return !!email && SUPERUSER_EMAILS.includes(email.trim().toLowerCase());
}

/** True iff the authenticated caller's email is in the superuser allowlist. */
export async function isSuperuser(ctx: any): Promise<boolean> {
  try {
    const userId = await requireUserId(ctx);
    const user = await ctx.db.get(userId as Id<"users">);
    return isSuperuserEmail(user?.email);
  } catch {
    // Unauthenticated (or no user row) → not a superuser.
    return false;
  }
}

/** Assert the caller is a superuser, else throw a ConvexError the app can show. */
export async function requireSuperuser(ctx: any): Promise<void> {
  if (!(await isSuperuser(ctx))) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "Only super admins can manage guest access.",
    });
  }
}
