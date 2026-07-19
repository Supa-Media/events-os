import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Integration settings — the deployment-wide singleton (the `financeSettings`
 * / `aiSettings` pattern; ONE row for the whole deployment) that stores
 * third-party API credentials configured IN-APP (profile > integrations, by a
 * superuser) instead of only via a deployment env var.
 *
 * Today: the Givebutter API key (`givebutterSync.ts` resolves the stored
 * setting first, falling back to `process.env.GIVEBUTTER_API_KEY`) and the
 * Twilio SMS credentials (`lib/twilio.ts` / `blasts.ts` / `ticketingSms.ts`
 * resolve the stored trio first, falling back to `TWILIO_ACCOUNT_SID` /
 * `TWILIO_AUTH_TOKEN` / `TWILIO_MESSAGING_SERVICE_SID`).
 *
 * SECRETS (the auth token, the API key) are NEVER returned to clients —
 * `integrationSettings.getIntegrationsStatus` only ever projects status
 * (`configured`, non-secret last4/presence, `updatedAt`). The raw secret is
 * readable ONLY through the `readGivebutterApiKey` / `readTwilioCredentials`
 * internalQueries, reachable solely from the sending actions.
 */
export const integrationSettings = defineTable({
  givebutterApiKey: v.optional(v.string()),
  // Twilio (Attendance F) — guest SMS verification + text blasts. The
  // account SID is not secret (shown as last4); the AUTH TOKEN is the secret
  // and gets the same write-only discipline as the Givebutter key; the
  // messaging service SID routes the send (A2P-registered service). All three
  // are set/cleared together by `setTwilioCredentials`.
  twilioAccountSid: v.optional(v.string()),
  twilioAuthToken: v.optional(v.string()),
  twilioMessagingServiceSid: v.optional(v.string()),
  updatedAt: v.number(),
  updatedBy: v.id("users"),
});
