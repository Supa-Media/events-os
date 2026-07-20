import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Integration settings — the deployment-wide singleton (the `financeSettings`
 * / `aiSettings` pattern; ONE row for the whole deployment) that stores
 * third-party API credentials configured IN-APP (profile > integrations, by a
 * superuser) instead of only via a deployment env var.
 *
 * Today: the Givebutter API key (`givebutterSync.ts` resolves the stored
 * setting first, falling back to `process.env.GIVEBUTTER_API_KEY`), the
 * Twilio SMS credentials (`lib/twilio.ts` / `blasts.ts` / `ticketingSms.ts`
 * resolve the stored trio first, falling back to `TWILIO_ACCOUNT_SID` /
 * `TWILIO_AUTH_TOKEN` / `TWILIO_MESSAGING_SERVICE_SID`), and the Resend email
 * key + from-address (`lib/resend.ts` resolves the stored setting first,
 * falling back to `RESEND_API_KEY` / `AUTH_EMAIL_FROM`) — lets a chapter send
 * transactional email from its own Resend account/domain instead of the
 * shared default, so mail doesn't look like it's coming from the framework's
 * shared sender.
 *
 * SECRETS (the auth token, the API keys) are NEVER returned to clients —
 * `integrationSettings.getIntegrationsStatus` only ever projects status
 * (`configured`, non-secret last4/presence, `updatedAt`). The raw secret is
 * readable ONLY through the `readGivebutterApiKey` / `readTwilioCredentials` /
 * `readResendSettings` internalQueries, reachable solely from the sending
 * actions. The Resend FROM ADDRESS is not secret (it's the sender line every
 * recipient already sees) — it's returned in full by `getIntegrationsStatus`.
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
  // Resend (own-key email) — the org's own Resend API key + the "From"
  // address/name to send with (e.g. `Chapter OS <os@publicworship.life>`),
  // set/cleared together by `setResendSettings`. The key is the secret
  // (write-only, last4 only in status); the from-address is not secret and
  // is shown in full so a superuser can confirm what recipients will see.
  resendApiKey: v.optional(v.string()),
  resendFromAddress: v.optional(v.string()),
  updatedAt: v.number(),
  updatedBy: v.id("users"),
});
