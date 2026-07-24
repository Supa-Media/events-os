/**
 * Phone-verification codes for RSVPs (Attendance F) — the SMS analog of
 * `emailCodes.ts`. A 6-digit code is texted when a guest verifies the phone on
 * their RSVP; only its hash is stored (`rsvpPhoneCodes`). Policy is identical
 * to the email flow and reuses its constants: 15-minute expiry, 5 attempts,
 * one send per minute.
 */
import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { sha256Hex } from "./sha256";
import { CODE_TTL_MS, MAX_CODE_ATTEMPTS, RESEND_INTERVAL_MS } from "./emailCodes";

export { CODE_TTL_MS, MAX_CODE_ATTEMPTS, RESEND_INTERVAL_MS };

/**
 * The RSVP fields phone verification needs. `phone` is spelled out REQUIRED
 * (it's optional on the doc): a code is only ever sent to a real number, so
 * callers must prove they have one before entering this flow.
 */
export type VerifiablePhoneRsvp = { _id: Id<"rsvps">; phone: string };

export function hashPhoneCode(code: string): string {
  return sha256Hex(`rsvp-phone-code:${code.trim()}`);
}

function newPhoneCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1_000_000).padStart(6, "0");
}

/** The pending code row for an RSVP, if any. */
export function pendingPhoneCodeFor(
  ctx: QueryCtx,
  rsvpId: Id<"rsvps">,
): Promise<Doc<"rsvpPhoneCodes"> | null> {
  return ctx.db
    .query("rsvpPhoneCodes")
    .withIndex("by_rsvp", (q) => q.eq("rsvpId", rsvpId))
    .unique();
}

export async function clearPhoneCode(
  ctx: MutationCtx,
  rsvpId: Id<"rsvps">,
): Promise<void> {
  const pending = await pendingPhoneCodeFor(ctx, rsvpId);
  if (pending) await ctx.db.delete(pending._id);
}

function sentRecently(row: Doc<"rsvpPhoneCodes"> | null): boolean {
  return !!row && Date.now() - row.lastSentAt < RESEND_INTERVAL_MS;
}

/** Upsert a fresh code (attempts reset) and return its plaintext. */
async function writeFreshCode(
  ctx: MutationCtx,
  rsvpId: Id<"rsvps">,
  existing: Doc<"rsvpPhoneCodes"> | null,
): Promise<string> {
  const now = Date.now();
  const code = newPhoneCode();
  const fields = {
    codeHash: hashPhoneCode(code),
    expiresAt: now + CODE_TTL_MS,
    attempts: 0,
    lastSentAt: now,
  };
  if (existing) await ctx.db.patch(existing._id, fields);
  else await ctx.db.insert("rsvpPhoneCodes", { rsvpId, ...fields, createdAt: now });
  return code;
}

function scheduleCodeSms(
  ctx: MutationCtx,
  rsvpId: Id<"rsvps">,
  phone: string,
  code: string,
) {
  return ctx.scheduler.runAfter(0, internal.ticketingSms.sendVerificationSms, {
    phone,
    code,
    rsvpId,
  });
}

/**
 * Mark the RSVP's phone unverified and text a fresh code. If one was sent less
 * than a minute ago the pending code is silently kept (no re-send).
 */
export async function beginPhoneVerification(
  ctx: MutationCtx,
  rsvp: VerifiablePhoneRsvp,
): Promise<void> {
  await ctx.db.patch(rsvp._id, { phoneVerified: false });
  const existing = await pendingPhoneCodeFor(ctx, rsvp._id);
  if (sentRecently(existing)) return;
  const code = await writeFreshCode(ctx, rsvp._id, existing);
  await scheduleCodeSms(ctx, rsvp._id, rsvp.phone, code);
}

/**
 * Text a fresh code for GUEST SIGN-IN (restoring identity by proving you own
 * the number). Unlike `beginPhoneVerification` it does NOT flip `phoneVerified`.
 * Rate-limited (one send/min); silently no-ops if a code was just sent. If SMS
 * isn't configured the send is a logged no-op (see `ticketingSms`), so the guest
 * can fall back to email sign-in.
 */
export async function sendSignInPhoneCode(
  ctx: MutationCtx,
  rsvp: VerifiablePhoneRsvp,
): Promise<void> {
  const existing = await pendingPhoneCodeFor(ctx, rsvp._id);
  if (sentRecently(existing)) return;
  const code = await writeFreshCode(ctx, rsvp._id, existing);
  await scheduleCodeSms(ctx, rsvp._id, rsvp.phone, code);
}

/** Explicit "Resend code" request — throws when rate-limited. */
export async function resendPhoneCode(
  ctx: MutationCtx,
  rsvp: VerifiablePhoneRsvp,
): Promise<void> {
  const existing = await pendingPhoneCodeFor(ctx, rsvp._id);
  if (sentRecently(existing)) {
    throw new ConvexError({
      code: "TOO_SOON",
      message: "We just sent a code — check your texts, or try again in a minute.",
    });
  }
  const code = await writeFreshCode(ctx, rsvp._id, existing);
  await scheduleCodeSms(ctx, rsvp._id, rsvp.phone, code);
}
