/**
 * Ticketing transactional SMS (Attendance F) — the SMS analog of
 * `ticketingEmails.ts`. Today: the 6-digit RSVP phone-verification code.
 *
 * Same best-effort shape as the email sends: resolve Twilio creds (stored
 * setting → `TWILIO_*` env → null), no-op with a log when Twilio isn't
 * configured, never throw so the scheduler doesn't retry-storm. Verification
 * codes are TRANSACTIONAL — no "Reply STOP" suffix (that's for marketing
 * blasts; STOP handling is enforced by the Messaging Service regardless).
 */
import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { normalizePhone, resolveTwilioCredentials, sendSms } from "./lib/twilio";

/** SMS the 6-digit phone-verification code for an RSVP's phone number. */
export const sendVerificationSms = internalAction({
  args: { phone: v.string(), code: v.string() },
  handler: async (ctx, { phone, code }) => {
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
    try {
      await sendSms(creds, {
        to,
        body: `${code} is your Public Worship verification code. It expires in 15 minutes.`,
      });
    } catch (err) {
      // Best effort — the guest can tap "Resend code".
      console.error(`[ticketing] verification SMS failed:`, String(err));
    }
    return null;
  },
});
