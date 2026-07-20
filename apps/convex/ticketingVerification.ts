/**
 * PUBLIC email verification for RSVPs. Guests prove they own the email on
 * their RSVP by entering the 6-digit code we mailed them. No auth — the guest
 * token identifies the RSVP, same as every other public ticketing mutation.
 *
 * Codes are stored hashed (`rsvpEmailCodes`); nothing here ever returns a
 * code or hash. A wrong code is reported via `{ ok: false }` rather than a
 * throw so the attempt counter survives the transaction (a thrown ConvexError
 * would roll back the increment and defeat the 5-attempt lockout).
 */
import { mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
  MAX_CODE_ATTEMPTS,
  hashEmailCode,
  pendingCodeFor,
  resendEmailCode,
  sendSignInEmailCode,
} from "./lib/emailCodes";
import {
  MAX_CODE_ATTEMPTS as MAX_PHONE_ATTEMPTS,
  beginPhoneVerification,
  hashPhoneCode,
  pendingPhoneCodeFor,
  resendPhoneCode,
  sendSignInPhoneCode,
} from "./lib/phoneCodes";
import { normalizeEmail } from "./lib/access";
import { normalizePhone } from "./lib/twilio";
import type { Id } from "./_generated/dataModel";
import { getPublishedPage, getViewerRsvp } from "./ticketing";

/** A generic wrong-code message — reused everywhere so a bad code, an unknown
 *  guest, and a mismatched contact are indistinguishable (no enumeration). */
const BAD_CODE = "That code doesn't match — double-check and try again.";

/** Resolve a guest by the contact they're signing in with (email or E.164
 *  phone), scoped to the event. Returns null on an unparseable/absent match. */
async function findGuestByContact(
  ctx: MutationCtx,
  eventId: Id<"events">,
  method: "email" | "phone",
  contact: string,
): Promise<Doc<"rsvps"> | null> {
  if (method === "email") {
    const email = normalizeEmail(contact);
    if (!email || !email.includes("@")) return null;
    return await ctx.db
      .query("rsvps")
      .withIndex("by_event_email", (q) =>
        q.eq("eventId", eventId).eq("email", email),
      )
      .first();
  }
  const phone = normalizePhone(contact);
  if (!phone) return null;
  return await ctx.db
    .query("rsvps")
    .withIndex("by_event_phone", (q) =>
      q.eq("eventId", eventId).eq("phone", phone),
    )
    .first();
}

/** Resolve the viewer's RSVP from slug + guest token, or throw friendly. */
async function requireViewer(
  ctx: MutationCtx,
  slug: string,
  token: string,
): Promise<Doc<"rsvps">> {
  const page = await getPublishedPage(ctx, slug);
  if (!page) {
    throw new ConvexError({ code: "NOT_FOUND", message: "RSVP page not found." });
  }
  const viewer = await getViewerRsvp(ctx, page.eventId, token);
  if (!viewer) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "We couldn't find your RSVP — try RSVPing again.",
    });
  }
  return viewer;
}

/** The pending code, after the not-usable cases have thrown friendly errors. */
async function requireUsableCode(
  ctx: MutationCtx,
  viewer: Doc<"rsvps">,
): Promise<Doc<"rsvpEmailCodes">> {
  const pending = await pendingCodeFor(ctx, viewer._id);
  if (!pending) {
    throw new ConvexError({
      code: "NO_CODE",
      message: "No code on file — tap “Resend code” and we'll email a fresh one.",
    });
  }
  if (pending.attempts >= MAX_CODE_ATTEMPTS) {
    throw new ConvexError({
      code: "LOCKED",
      message: "Too many tries — tap “Resend code” to get a fresh one.",
    });
  }
  if (pending.expiresAt < Date.now()) {
    throw new ConvexError({
      code: "EXPIRED",
      message: "That code expired — tap “Resend code” and we'll email a fresh one.",
    });
  }
  return pending;
}

/** Confirm the emailed 6-digit code and mark the RSVP's email verified. */
export const verifyRsvpEmail = mutation({
  args: { slug: v.string(), token: v.string(), code: v.string() },
  handler: async (ctx, { slug, token, code }) => {
    const viewer = await requireViewer(ctx, slug, token);
    if (viewer.emailVerified !== false) return { ok: true as const };

    const pending = await requireUsableCode(ctx, viewer);
    if (hashEmailCode(code) !== pending.codeHash) {
      await ctx.db.patch(pending._id, { attempts: pending.attempts + 1 });
      return {
        ok: false as const,
        error: "That code doesn't match — double-check and try again.",
      };
    }
    await ctx.db.patch(viewer._id, { emailVerified: true, updatedAt: Date.now() });
    await ctx.db.delete(pending._id);
    return { ok: true as const };
  },
});

/** Email a fresh code (rate-limited to one send per minute). */
export const resendRsvpEmailCode = mutation({
  args: { slug: v.string(), token: v.string() },
  handler: async (ctx, { slug, token }) => {
    const viewer = await requireViewer(ctx, slug, token);
    if (viewer.emailVerified !== false) {
      throw new ConvexError({
        code: "ALREADY_VERIFIED",
        message: "Your email is already verified ✓",
      });
    }
    // Unreachable in practice — an imported email-less guest never gets a
    // pending code, so `emailVerified` is `undefined` (legacy=verified) and
    // the guard above already returned. Kept for type-soundness: `email` is
    // optional on the RSVP doc but required by `resendEmailCode`.
    if (!viewer.email) {
      throw new ConvexError({
        code: "NO_EMAIL",
        message: "This guest has no email on file to send a code to.",
      });
    }
    await resendEmailCode(ctx, { _id: viewer._id, email: viewer.email });
    return { ok: true as const };
  },
});

// ── PUBLIC phone verification (Attendance F) ─────────────────────────────────
// The SMS mirror of the email pair above, plus an explicit `begin` (email
// verification is begun by `submitRsvp`; phone verification has no public
// submission entry yet — see the PR's public-flow scope note — so a phone
// guest who already carries a phone on their RSVP starts it here). Serves
// imported/synced phone guests and any RSVP that added a phone.

/** The pending phone code, after the not-usable cases throw friendly errors. */
async function requireUsablePhoneCode(
  ctx: MutationCtx,
  viewer: Doc<"rsvps">,
): Promise<Doc<"rsvpPhoneCodes">> {
  const pending = await pendingPhoneCodeFor(ctx, viewer._id);
  if (!pending) {
    throw new ConvexError({
      code: "NO_CODE",
      message: "No code on file — tap “Resend code” and we'll text a fresh one.",
    });
  }
  if (pending.attempts >= MAX_PHONE_ATTEMPTS) {
    throw new ConvexError({
      code: "LOCKED",
      message: "Too many tries — tap “Resend code” to get a fresh one.",
    });
  }
  if (pending.expiresAt < Date.now()) {
    throw new ConvexError({
      code: "EXPIRED",
      message: "That code expired — tap “Resend code” and we'll text a fresh one.",
    });
  }
  return pending;
}

/** The viewer's phone, after the missing-phone case throws friendly. */
function requirePhone(viewer: Doc<"rsvps">): string {
  if (!viewer.phone) {
    throw new ConvexError({
      code: "NO_PHONE",
      message: "Add a mobile number to your RSVP first, then verify it.",
    });
  }
  return viewer.phone;
}

/** Begin (or restart) phone verification: mark unverified and text a code. */
export const beginRsvpPhoneVerification = mutation({
  args: { slug: v.string(), token: v.string() },
  handler: async (ctx, { slug, token }) => {
    const viewer = await requireViewer(ctx, slug, token);
    const phone = requirePhone(viewer);
    if (viewer.phoneVerified === true) {
      throw new ConvexError({
        code: "ALREADY_VERIFIED",
        message: "Your number is already verified ✓",
      });
    }
    await beginPhoneVerification(ctx, { _id: viewer._id, phone });
    return { ok: true as const };
  },
});

/** Confirm the texted 6-digit code and mark the RSVP's phone verified. */
export const verifyRsvpPhone = mutation({
  args: { slug: v.string(), token: v.string(), code: v.string() },
  handler: async (ctx, { slug, token, code }) => {
    const viewer = await requireViewer(ctx, slug, token);
    if (viewer.phoneVerified === true) return { ok: true as const };

    const pending = await requireUsablePhoneCode(ctx, viewer);
    if (hashPhoneCode(code) !== pending.codeHash) {
      await ctx.db.patch(pending._id, { attempts: pending.attempts + 1 });
      return {
        ok: false as const,
        error: "That code doesn't match — double-check and try again.",
      };
    }
    await ctx.db.patch(viewer._id, { phoneVerified: true, updatedAt: Date.now() });
    await ctx.db.delete(pending._id);
    return { ok: true as const };
  },
});

/** Text a fresh code (rate-limited to one send per minute). */
export const resendRsvpPhoneCode = mutation({
  args: { slug: v.string(), token: v.string() },
  handler: async (ctx, { slug, token }) => {
    const viewer = await requireViewer(ctx, slug, token);
    const phone = requirePhone(viewer);
    if (viewer.phoneVerified === true) {
      throw new ConvexError({
        code: "ALREADY_VERIFIED",
        message: "Your number is already verified ✓",
      });
    }
    await resendPhoneCode(ctx, { _id: viewer._id, phone });
    return { ok: true as const };
  },
});

// ── PUBLIC guest sign-in ─────────────────────────────────────────────────────
// Restore a guest's identity on a fresh device: they enter the email or phone
// on their RSVP/ticket, we text/email a code, and verifying returns their guest
// `token` (the one thing every other public flow already requires). This is the
// only public path that resolves a guest WITHOUT a token — hence the deliberate
// no-enumeration posture (start always succeeds; verify uses one generic error).

const signInMethod = v.union(v.literal("email"), v.literal("phone"));

/** Send a sign-in code to the email/phone if it matches a guest of this event.
 *  Always resolves `{ ok: true }` — never reveals whether the contact matched. */
export const startGuestSignIn = mutation({
  args: { slug: v.string(), method: signInMethod, contact: v.string() },
  handler: async (ctx, { slug, method, contact }) => {
    const page = await getPublishedPage(ctx, slug);
    if (!page) {
      throw new ConvexError({ code: "NOT_FOUND", message: "RSVP page not found." });
    }
    const rsvp = await findGuestByContact(ctx, page.eventId, method, contact);
    if (rsvp) {
      if (method === "email" && rsvp.email) {
        await sendSignInEmailCode(ctx, { _id: rsvp._id, email: rsvp.email });
      } else if (method === "phone" && rsvp.phone) {
        await sendSignInPhoneCode(ctx, { _id: rsvp._id, phone: rsvp.phone });
      }
    }
    return { ok: true as const };
  },
});

/** Confirm the code and hand back the guest token so the browser signs in.
 *  A wrong code / unknown contact both return the same generic `{ ok: false }`. */
export const verifyGuestSignIn = mutation({
  args: {
    slug: v.string(),
    method: signInMethod,
    contact: v.string(),
    code: v.string(),
  },
  handler: async (ctx, { slug, method, contact, code }) => {
    const page = await getPublishedPage(ctx, slug);
    if (!page) {
      throw new ConvexError({ code: "NOT_FOUND", message: "RSVP page not found." });
    }
    const rsvp = await findGuestByContact(ctx, page.eventId, method, contact);
    if (!rsvp) return { ok: false as const, error: BAD_CODE };

    if (method === "email") {
      const pending = await requireUsableCode(ctx, rsvp);
      if (hashEmailCode(code) !== pending.codeHash) {
        await ctx.db.patch(pending._id, { attempts: pending.attempts + 1 });
        return { ok: false as const, error: BAD_CODE };
      }
      await ctx.db.patch(rsvp._id, { emailVerified: true, updatedAt: Date.now() });
      await ctx.db.delete(pending._id);
    } else {
      const pending = await requireUsablePhoneCode(ctx, rsvp);
      if (hashPhoneCode(code) !== pending.codeHash) {
        await ctx.db.patch(pending._id, { attempts: pending.attempts + 1 });
        return { ok: false as const, error: BAD_CODE };
      }
      await ctx.db.patch(rsvp._id, { phoneVerified: true, updatedAt: Date.now() });
      await ctx.db.delete(pending._id);
    }
    // The token is the guest's identity — the browser stores it and is now
    // signed in (activity unlocks, "your tickets" appears).
    return { ok: true as const, token: rsvp.token };
  },
});
