/**
 * Superuser allowlist.
 *
 * Superusers are a fixed set of emails (MVP). They're the only accounts allowed
 * to change deployment-wide AI settings (e.g. the active model). Enforced on the
 * server — UI hiding is purely cosmetic.
 */
import { Id } from "../_generated/dataModel";
import { requireUserId } from "./context";

export const SUPERUSER_EMAILS = [
  "seyi@events.com",
  "test@events.com",
  "seyi@events.test",
];

/** True iff the authenticated caller's email is in the superuser allowlist. */
export async function isSuperuser(ctx: any): Promise<boolean> {
  try {
    const userId = await requireUserId(ctx);
    const user = await ctx.db.get(userId as Id<"users">);
    return !!user?.email && SUPERUSER_EMAILS.includes(user.email);
  } catch {
    // Unauthenticated (or no user row) → not a superuser.
    return false;
  }
}
