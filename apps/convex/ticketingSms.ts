/**
 * Ticketing transactional SMS (Attendance F) — the SMS analog of
 * `ticketingEmails.ts`. Today: the 6-digit RSVP phone-verification code.
 *
 * Same best-effort shape as the email sends: resolve Twilio creds (stored
 * setting → `TWILIO_*` env → null), no-op with a log when Twilio isn't
 * configured, never throw so the scheduler doesn't retry-storm. Verification
 * codes are TRANSACTIONAL — no "Reply STOP" suffix (that's for marketing
 * blasts; STOP handling is enforced by the Messaging Service regardless).
 *
 * Every send attempt is also logged to `smsUsageEvents` (purpose
 * "verification") — the cost ledger behind `smsUsage.getSmsSpendSummary`, the
 * same audit trail `blasts.ts#deliverSmsBlast` writes for blasts.
 */
import { internalAction, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { normalizePhone, resolveTwilioCredentials, sendSms } from "./lib/twilio";
import { estimateSegments, SMS_SEGMENT_PRICE_USD_MICROS } from "@events-os/shared";

/** The RSVP's chapter/event scope, for the usage-ledger row. Internal-only —
 *  `sendVerificationSms` is the sole caller (via `ctx.runQuery`, since an
 *  action has no `ctx.db`). */
export const getRsvpScope = internalQuery({
  args: { rsvpId: v.id("rsvps") },
  returns: v.union(
    v.object({ chapterId: v.id("chapters"), eventId: v.id("events") }),
    v.null(),
  ),
  handler: async (ctx, { rsvpId }) => {
    const rsvp = await ctx.db.get(rsvpId);
    return rsvp ? { chapterId: rsvp.chapterId, eventId: rsvp.eventId } : null;
  },
});

/** SMS the 6-digit phone-verification code for an RSVP's phone number.
 *  `rsvpId` is optional only for defensive back-compat (a stale scheduled
 *  call from before this arg existed) — every current caller
 *  (`lib/phoneCodes.ts`) always passes it, so the ledger row can be
 *  chapter-attributed instead of falling back to "central". */
export const sendVerificationSms = internalAction({
  args: { phone: v.string(), code: v.string(), rsvpId: v.optional(v.id("rsvps")) },
  handler: async (ctx, { phone, code, rsvpId }) => {
    const creds = await resolveTwilioCredentials(ctx);
    if (!creds) {
      console.log(
        `[ticketing] SMS skipped (Twilio not configured): code → ${phone}`,
      );
      return null;
    }
    const to = normalizePhone(phone);
    if (!to) {
      console.error(`[ticketing] SMS skipped (unparseable phone): ${phone}`);
      return null;
    }
    const scope = rsvpId
      ? await ctx.runQuery(internal.ticketingSms.getRsvpScope, { rsvpId })
      : null;
    const body = `${code} is your Public Worship verification code. It expires in 15 minutes.`;
    const segments = estimateSegments(body);
    try {
      await sendSms(creds, { to, body });
      await ctx.runMutation(internal.smsUsage.recordUsageEvent, {
        chapterId: scope?.chapterId ?? "central",
        purpose: "verification",
        eventId: scope?.eventId,
        phoneLast4: to.slice(-4),
        segments,
        costUsdMicros: segments * SMS_SEGMENT_PRICE_USD_MICROS,
        outcome: "sent",
      });
    } catch (err) {
      // Best effort — the guest can tap "Resend code".
      console.error(`[ticketing] verification SMS failed:`, String(err));
      await ctx.runMutation(internal.smsUsage.recordUsageEvent, {
        chapterId: scope?.chapterId ?? "central",
        purpose: "verification",
        eventId: scope?.eventId,
        phoneLast4: to.slice(-4),
        segments,
        costUsdMicros: 0,
        outcome: "failed",
      });
    }
    return null;
  },
});
