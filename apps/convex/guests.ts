/**
 * Guest allowlist management.
 *
 * These are the ONLY way a non-`publicworship.life` email gets access. They're
 * registered as INTERNAL functions on purpose: a guest's ability to log in must
 * be seeded from Convex (the dashboard function runner or a seed script), never
 * self-service from the app. To grant access, run `guests:allow` with the
 * guest's email; they then log in through the normal email-OTP flow.
 *
 * Access is enforced downstream by `requireAccess` / `hasAccess` (see
 * lib/access.ts), which check this table for any email off the member domain.
 */
import { internalMutation, internalQuery, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { hasAccess, isAllowedEmail, normalizeEmail } from "./lib/access";
import { Doc } from "./_generated/dataModel";

/**
 * Pre-flight access check for the login screen. Public + unauthenticated so the
 * app can tell a non-approved email "you don't have access" BEFORE sending an
 * OTP, instead of letting them verify and bounce off the access-denied screen.
 *
 * This is purely UX — `requireAccess` (see lib/access.ts) is still the real gate
 * enforced on every data function. Returns `{ allowed }` for the typed email.
 */
export const checkEmail = query({
  args: { email: v.string() },
  handler: async (ctx, { email }): Promise<{ allowed: boolean }> => {
    return { allowed: await hasAccess(ctx, email) };
  },
});

/**
 * Grant a guest email access (idempotent). Re-activates a revoked row and
 * refreshes the note. No-ops for domain members — they already have access.
 */
export const allow = internalMutation({
  args: { email: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, { email, note }) => {
    const normalized = normalizeEmail(email);
    if (!normalized) {
      throw new ConvexError({
        code: "INVALID_EMAIL",
        message: "Provide a non-empty email to allow.",
      });
    }
    if (isAllowedEmail(normalized)) {
      throw new ConvexError({
        code: "ALREADY_A_MEMBER",
        message: `${normalized} is a publicworship.life member and already has access.`,
      });
    }

    const existing = await ctx.db
      .query("guestAllowlist")
      .withIndex("by_email", (q) => q.eq("email", normalized))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        isActive: true,
        ...(note !== undefined ? { note } : {}),
      });
      return existing._id;
    }

    return await ctx.db.insert("guestAllowlist", {
      email: normalized,
      note,
      isActive: true,
      createdAt: Date.now(),
    });
  },
});

/**
 * Revoke a guest's access. Keeps the row (isActive=false) so the note/audit
 * trail survives. No-ops if the email was never allowed.
 */
export const revoke = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    const existing = await ctx.db
      .query("guestAllowlist")
      .withIndex("by_email", (q) => q.eq("email", normalized))
      .first();
    if (existing) await ctx.db.patch(existing._id, { isActive: false });
    return null;
  },
});

/** All guest allowlist rows (for inspection from the dashboard). */
export const list = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"guestAllowlist">[]> => {
    return await ctx.db.query("guestAllowlist").collect();
  },
});
