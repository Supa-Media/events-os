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
 * `readResendSettings` / `readResendInboundWebhookSecret` internalQueries,
 * reachable solely from the sending actions / webhook routes. The Resend FROM
 * ADDRESS is not secret (it's the sender line every recipient already sees)
 * — it's returned in full by `getIntegrationsStatus`.
 *
 * Email campaigns (`campaigns.ts`, `http.ts`'s `/resend/webhook`) add three
 * more fields, all Resend-adjacent but independently settable from the
 * send-path key/from-address above:
 *  - `resendWebhookSecret` — the Svix `whsec_...` signing secret for Resend's
 *    OUTBOUND webhook (bounce/complaint/inbound-reply events), verified in
 *    `lib/resend.ts#verifyResendWebhookSignature`. WRITE-ONLY, same secret
 *    discipline as the API key — never returned by `getIntegrationsStatus`,
 *    readable only through `readResendWebhookSecret`.
 *  - `resendInboundDomain` — NOT secret (e.g. "reply.publicworship.life"), the
 *    domain `campaigns.ts` builds each campaign's unique
 *    `campaign+<id>@<domain>` reply-to address from, so an inbound reply can
 *    be matched back to the campaign that sent it.
 *  - `orgMailingAddress` — NOT secret, the CAN-SPAM-required physical mailing
 *    address rendered in every campaign email's footer
 *    (`@events-os/shared`'s `renderCampaignEmail`).
 *
 * Separately, `resendInboundWebhookSecret` is the Svix signing secret for the
 * UNRELATED `/resend/inbound` receipt-OCR webhook (see `http.ts`) — a
 * different Resend endpoint/domain from the campaign webhook above; both
 * secrets coexist independently.
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
  // Email campaigns — see the module doc above. Independently settable from
  // the send-path key/from-address (a deployment can send campaigns without
  // inbound/webhook wiring configured yet, and vice versa).
  resendWebhookSecret: v.optional(v.string()),
  resendInboundDomain: v.optional(v.string()),
  orgMailingAddress: v.optional(v.string()),
  // Resend inbound receipt webhook — the Svix `whsec_…` signing secret used
  // to verify `/resend/inbound` deliveries (see `http.ts`). Same write-only
  // discipline as the Givebutter key: settable in-app at profile >
  // integrations by a superuser, resolved stored-setting-first, falling back
  // to the deployment `RESEND_INBOUND_WEBHOOK_SECRET` env var.
  resendInboundWebhookSecret: v.optional(v.string()),
  // Switchable AI engine (Ollama vs OpenRouter) — the whole app's AI provider,
  // configured in-app at profile > integrations by a superuser. `ollamaApiKey`
  // is the SECRET (same write-only discipline as the Givebutter key / Twilio
  // auth token: never returned to a client except its last4). `ollamaBaseUrl`
  // (optional; defaults to https://ollama.com) lets the owner point at a
  // self-hosted Ollama later. `aiProvider` absent = "openrouter" (full
  // back-compat). `aiModel` is the GLOBAL default model for the active provider
  // used across every AI call site (OCR, coding, assistant); absent = each call
  // site's own env/hardcoded default. See `integrationSettings.readAiEngineConfig`
  // (stored-first → env fallback) + `lib/aiEngine.ts`.
  ollamaApiKey: v.optional(v.string()),
  ollamaBaseUrl: v.optional(v.string()),
  aiProvider: v.optional(v.union(v.literal("openrouter"), v.literal("ollama"))),
  aiModel: v.optional(v.string()),
  updatedAt: v.number(),
  updatedBy: v.id("users"),
});
