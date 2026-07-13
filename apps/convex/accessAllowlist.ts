/**
 * Access allowlist (Chapter-OS canonical name; formerly `guests`).
 *
 * The ONLY way a non-`publicworship.life` email gets access. This is the API
 * module — functions are exposed as `api.accessAllowlist.*`; a thin `guests.ts`
 * re-export shim keeps `api.guests.*` resolving for OTA-lagged mobile clients.
 *
 * Three surfaces, one shared core:
 *   - `checkEmail`         public pre-flight for the login screen (UX only).
 *   - `allow`/`revoke`/`list`   internal, run from Convex (dashboard / seeds).
 *   - `grantAccess`/`revokeAccess`/`listGuests`   public but superuser-gated,
 *     for the in-app admin screen.
 *
 * READS and WRITES both target the `accessAllowlist` table only. The legacy
 * `guestAllowlist` rows were copied in by `copyGuestAllowlist` (Deploy A) and
 * are emptied by `purgeGuestAllowlist` (Deploy B); the table itself is dropped
 * in a later Deploy C.
 *
 * A fresh grant (new row or a re-activation) emails the guest to tell them they
 * can sign in. Access is enforced downstream by `requireAccess` / `hasAccess`
 * (see lib/access.ts) on every data function.
 */
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { hasAccess, isAllowedEmail, normalizeEmail } from "./lib/access";
import { requireSuperuser } from "./lib/superuser";

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

// ── Shared allowlist core ────────────────────────────────────────────────────

/**
 * Upsert an active allowlist row. Returns `newlyGranted: true` when this call
 * actually turned access on (fresh row, or re-activating a revoked one) so the
 * caller can decide whether to email the guest. No-ops for domain members.
 */
async function grantGuest(
  ctx: MutationCtx,
  email: string,
  note?: string,
): Promise<{ id: Id<"accessAllowlist">; newlyGranted: boolean }> {
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
    .query("accessAllowlist")
    .withIndex("by_email", (q) => q.eq("email", normalized))
    .first();

  if (existing) {
    const wasActive = existing.isActive !== false;
    await ctx.db.patch(existing._id, {
      isActive: true,
      ...(note !== undefined ? { note } : {}),
    });
    return { id: existing._id, newlyGranted: !wasActive };
  }

  // No row yet — a fresh grant turns access on for the first time.
  const id = await ctx.db.insert("accessAllowlist", {
    email: normalized,
    note,
    isActive: true,
    createdAt: Date.now(),
  });
  return { id, newlyGranted: true };
}

/** Grant, then email the guest if this call freshly turned their access on. */
async function grantAndNotify(
  ctx: MutationCtx,
  email: string,
  note?: string,
): Promise<Id<"accessAllowlist">> {
  const { id, newlyGranted } = await grantGuest(ctx, email, note);
  if (newlyGranted) {
    await ctx.scheduler.runAfter(
      0,
      internal.accessAllowlist.sendAccessGrantedEmail,
      { email: normalizeEmail(email)! },
    );
  }
  return id;
}

/**
 * Revoke access, keeping the row (isActive=false) so the note/history
 * survives. Targets the `accessAllowlist` table only (legacy `guestAllowlist`
 * rows were folded in by `copyGuestAllowlist`).
 */
async function revokeGuest(ctx: MutationCtx, email: string): Promise<null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const access = await ctx.db
    .query("accessAllowlist")
    .withIndex("by_email", (q) => q.eq("email", normalized))
    .first();
  if (access) await ctx.db.patch(access._id, { isActive: false });
  return null;
}

/**
 * Newest-first list of allowlist rows (bounded). Reads the `accessAllowlist`
 * table only — the legacy `guestAllowlist` rows were folded in by
 * `copyGuestAllowlist`.
 */
async function listGuestRows(ctx: QueryCtx): Promise<Doc<"accessAllowlist">[]> {
  return await ctx.db.query("accessAllowlist").order("desc").take(500);
}

// ── Seeded from Convex (internal: dashboard function runner / seed scripts) ───

export const allow = internalMutation({
  args: { email: v.string(), note: v.optional(v.string()) },
  handler: (ctx, { email, note }) => grantAndNotify(ctx, email, note),
});

export const revoke = internalMutation({
  args: { email: v.string() },
  handler: (ctx, { email }) => revokeGuest(ctx, email),
});

export const list = internalQuery({
  args: {},
  handler: (ctx) => listGuestRows(ctx),
});

// ── Managed in-app by super admins (public, superuser-gated) ─────────────────

export const grantAccess = mutation({
  args: { email: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, { email, note }) => {
    await requireSuperuser(ctx);
    return await grantAndNotify(ctx, email, note);
  },
});

export const revokeAccess = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    await requireSuperuser(ctx);
    return await revokeGuest(ctx, email);
  },
});

export const listGuests = query({
  args: {},
  handler: async (ctx): Promise<Doc<"accessAllowlist">[]> => {
    await requireSuperuser(ctx);
    return await listGuestRows(ctx);
  },
});

// ── Notification (internal action; fetch works in the default runtime) ───────

/**
 * Email a guest that they've been granted access. Mirrors the auth OTP mailer:
 * uses Resend when `RESEND_API_KEY` is set, otherwise just logs (dev). Best
 * effort — a send failure is logged, never thrown, so it can't fail the grant.
 */
export const sendAccessGrantedEmail = internalAction({
  args: { email: v.string() },
  handler: async (_ctx, { email }) => {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.AUTH_EMAIL_FROM ?? "auth@events-os.com";
    const subject = "You've been given access to Chapter OS";
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5;color:#111">
  <h2 style="margin:0 0 12px">You're in 🎉</h2>
  <p>You've been granted guest access to <strong>Chapter OS</strong>.</p>
  <p>Open the app, choose <strong>Sign in as a guest</strong>, and enter this email
  address (<strong>${email}</strong>). We'll email you a one-time code each time
  you sign in.</p>
  <p style="color:#666">See you inside.</p>
</div>`;

    if (!apiKey) {
      console.log(
        `[guests] access granted to ${email} (no RESEND_API_KEY — email skipped)`,
      );
      return null;
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: email, subject, html }),
    });
    if (!response.ok) {
      console.error(
        "[guests] access-granted email failed:",
        await response.text(),
      );
    }
    return null;
  },
});
