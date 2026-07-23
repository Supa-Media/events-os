/**
 * Twilio SMS core (Attendance F) — the app-local send path for guest phone
 * verification codes (`ticketingSms.ts`) and text blasts (`blasts.ts`).
 *
 * DIVERGENCE from the framework: the supa-framework auth uses Twilio ONLY for
 * login OTP (`createSupaAuth({ twilio })`, via a Twilio Verify service +
 * `TWILIO_PHONE_NUMBER` / `TWILIO_VERIFY_SERVICE_SID`) — that stays entirely
 * framework-side and is NOT touched here. Guest-facing SMS is app-specific
 * (a Messaging Service the host configures + audiences drawn from RSVPs), so
 * it lives in the app. Both share the same Twilio account, hence the same
 * `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` env names.
 *
 * `fetch()` works in the default Convex runtime, so no `"use node"` — Twilio's
 * REST API is a plain form-encoded POST with Basic auth.
 */
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";

export type TwilioCredentials = {
  accountSid: string;
  authToken: string;
  messagingServiceSid: string;
};

/**
 * Normalize a raw phone string to E.164, or `null` when it can't be. US-biased
 * (the org's audience): a bare 10-digit number becomes `+1XXXXXXXXXX`, an
 * 11-digit number starting with `1` becomes `+1XXXXXXXXXX`. An input that
 * already carries a leading `+` is trusted as international if it has 8–15
 * digits. Everything else is rejected.
 */
export function normalizePhone(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const hadPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (hadPlus) {
    // Already international — keep as-is if it's a plausible E.164 length.
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/**
 * Resolve the Twilio credentials for a send: the in-app superuser setting
 * (`integrationSettings.readTwilioCredentials`) takes precedence, else the
 * deployment `TWILIO_*` env vars, else `null` (a logged no-op degrade at the
 * call site — mirrors `resolveGivebutterApiKey`). All three values must be
 * present for a non-null result.
 */
export async function resolveTwilioCredentials(
  ctx: ActionCtx,
): Promise<TwilioCredentials | null> {
  const stored = await ctx.runQuery(
    internal.integrationSettings.readTwilioCredentials,
    {},
  );
  if (stored) return stored;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  if (!accountSid || !authToken || !messagingServiceSid) return null;
  return { accountSid, authToken, messagingServiceSid };
}

/**
 * Verify an inbound Twilio webhook's `X-Twilio-Signature` header
 * (https://www.twilio.com/docs/usage/webhooks/webhooks-security). Twilio signs
 * HMAC-SHA1(authToken, url + sorted(key+value for every POST param)) and
 * base64-encodes the MAC — NOT a Standard-Webhooks scheme, so this is its own
 * implementation (`lib/standardWebhook.ts` doesn't apply here).
 *
 * `url` MUST be the EXACT URL Twilio posted to (scheme + host + path + query
 * string) — see `smsReceipts.ts#resolveTwilioReceiptsWebhookUrl` for how the
 * caller resolves that URL (the subtlety: it is NOT always `req.url` as the
 * httpAction sees it — a proxied request rewrites the host). `params` are the
 * POST body's form fields, already url-decoded (e.g. via
 * `new URLSearchParams(body)`) — Twilio computes the signature over the
 * DECODED values, not the raw encoded bytes.
 *
 * Returns `false` (never throws) on a missing signature, an empty auth token,
 * or a mismatch. Constant-time compare on the final digest.
 */
export async function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  authToken: string,
  signature: string | null,
): Promise<boolean> {
  if (!signature || !authToken) return false;

  // Twilio's algorithm: sort param keys, then concatenate url + key1 + value1
  // + key2 + value2 + ... (no separators at all — see Twilio's reference
  // implementations, e.g. twilio-node's `validateRequest`).
  let data = url;
  for (const key of Object.keys(params).sort()) {
    data += key + params[key];
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)),
  );
  let bin = "";
  for (const b of mac) bin += String.fromCharCode(b);
  const expected = btoa(bin);

  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Send one SMS via the Twilio REST API. `to` MUST already be E.164 (callers
 * normalize with `normalizePhone` first). Throws on a non-2xx response so
 * best-effort loops (blasts) can count failures; the thrown message NEVER
 * includes the auth token.
 */
export async function sendSms(
  creds: TwilioCredentials,
  { to, body }: { to: string; body: string },
): Promise<void> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Messages.json`;
  const form = new URLSearchParams({
    MessagingServiceSid: creds.messagingServiceSid,
    To: to,
    Body: body,
  });
  // Basic auth: base64("<sid>:<token>"). `btoa` is available in the Convex
  // runtime; the token stays inside the header and is never logged.
  const auth = btoa(`${creds.accountSid}:${creds.authToken}`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  if (!response.ok) {
    // Twilio error bodies carry a code + message, never our credentials.
    throw new Error(`Twilio send failed (${response.status}): ${await response.text()}`);
  }
}
