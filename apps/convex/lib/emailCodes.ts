/**
 * Email-verification codes for RSVPs. A 6-digit code is emailed when a guest
 * sets or changes their email; only its hash is stored (`rsvpEmailCodes`).
 * Policy lives here: 15-minute expiry, 5 attempts, one send per minute.
 */
import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { sha256Hex } from "./sha256";

export const CODE_TTL_MS = 15 * 60 * 1000;
export const RESEND_INTERVAL_MS = 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;

/**
 * The RSVP fields verification needs. `email` is spelled out as a REQUIRED
 * string here (not `Pick<Doc<"rsvps">, "email">`, which is now optional since
 * imported guests may lack one): a verification code is only ever sent to a
 * real address, so callers must prove they have one before entering this flow.
 */
export type VerifiableRsvp = { _id: Id<"rsvps">; email: string };

export function hashEmailCode(code: string): string {
  return sha256Hex(`rsvp-email-code:${code.trim()}`);
}

function newEmailCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1_000_000).padStart(6, "0");
}

/** The pending code row for an RSVP, if any. */
export function pendingCodeFor(
  ctx: QueryCtx,
  rsvpId: Id<"rsvps">,
): Promise<Doc<"rsvpEmailCodes"> | null> {
  return ctx.db
    .query("rsvpEmailCodes")
    .withIndex("by_rsvp", (q) => q.eq("rsvpId", rsvpId))
    .unique();
}

export async function clearEmailCode(
  ctx: MutationCtx,
  rsvpId: Id<"rsvps">,
): Promise<void> {
  const pending = await pendingCodeFor(ctx, rsvpId);
  if (pending) await ctx.db.delete(pending._id);
}

function sentRecently(row: Doc<"rsvpEmailCodes"> | null): boolean {
  return !!row && Date.now() - row.lastSentAt < RESEND_INTERVAL_MS;
}

/** Upsert a fresh code (attempts reset) and return its plaintext. */
async function writeFreshCode(
  ctx: MutationCtx,
  rsvpId: Id<"rsvps">,
  existing: Doc<"rsvpEmailCodes"> | null,
): Promise<string> {
  const now = Date.now();
  const code = newEmailCode();
  const fields = {
    codeHash: hashEmailCode(code),
    expiresAt: now + CODE_TTL_MS,
    attempts: 0,
    lastSentAt: now,
  };
  if (existing) await ctx.db.patch(existing._id, fields);
  else await ctx.db.insert("rsvpEmailCodes", { rsvpId, ...fields, createdAt: now });
  return code;
}

function scheduleCodeEmail(ctx: MutationCtx, email: string, code: string) {
  return ctx.scheduler.runAfter(
    0,
    internal.ticketingEmails.sendVerificationEmail,
    { email, code },
  );
}

/**
 * Mark the RSVP's email unverified and email a fresh code. If one was sent
 * less than a minute ago the pending code is silently kept (no re-send).
 */
export async function beginEmailVerification(
  ctx: MutationCtx,
  rsvp: VerifiableRsvp,
): Promise<void> {
  await ctx.db.patch(rsvp._id, { emailVerified: false });
  const existing = await pendingCodeFor(ctx, rsvp._id);
  if (sentRecently(existing)) return;
  const code = await writeFreshCode(ctx, rsvp._id, existing);
  await scheduleCodeEmail(ctx, rsvp.email, code);
}

/**
 * Email a fresh code for GUEST SIGN-IN (restoring identity by proving you own
 * the address). Unlike `beginEmailVerification` it does NOT flip `emailVerified`
 * — signing in mustn't downgrade an already-verified guest. Rate-limited (one
 * send/min); silently no-ops if a code was just sent.
 */
export async function sendSignInEmailCode(
  ctx: MutationCtx,
  rsvp: VerifiableRsvp,
): Promise<void> {
  const existing = await pendingCodeFor(ctx, rsvp._id);
  if (sentRecently(existing)) return;
  const code = await writeFreshCode(ctx, rsvp._id, existing);
  await scheduleCodeEmail(ctx, rsvp.email, code);
}

/** Explicit "Resend code" request — throws when rate-limited. */
export async function resendEmailCode(
  ctx: MutationCtx,
  rsvp: VerifiableRsvp,
): Promise<void> {
  const existing = await pendingCodeFor(ctx, rsvp._id);
  if (sentRecently(existing)) {
    throw new ConvexError({
      code: "TOO_SOON",
      message: "We just sent a code — check your inbox, or try again in a minute.",
    });
  }
  const code = await writeFreshCode(ctx, rsvp._id, existing);
  await scheduleCodeEmail(ctx, rsvp.email, code);
}
