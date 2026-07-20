/**
 * Resend email core (own-key integration) — resolves which Resend API
 * key/from-address a send should use and performs the raw Resend fetch.
 * Mirrors `lib/twilio.ts`'s `resolveTwilioCredentials`/`sendSms` shape:
 * `resolveResendSettings` decides WHICH credentials to use, `sendResendEmail`
 * is the dumb fetch that just uses whatever it's handed.
 *
 * `fetch()` works in the default Convex runtime, so no `"use node"` — same as
 * every other REST integration in this codebase.
 */
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";

export type ResendSettings = {
  apiKey: string;
  fromAddress: string;
};

const DEFAULT_FROM_ADDRESS = "auth@events-os.com";

/**
 * Resolve the Resend settings for a send: the in-app superuser setting
 * (`integrationSettings.readResendSettings`) takes precedence, else the
 * deployment `RESEND_API_KEY`/`AUTH_EMAIL_FROM` env vars, else `null` (a
 * logged no-op degrade at the call site — mirrors `resolveTwilioCredentials`
 * / `resolveGivebutterApiKey`). A stored setting with no from-address (or a
 * cleared one) falls back to the env from-address / the hardcoded default,
 * NOT to `null` — a key with nowhere to send from still needs a sender line.
 */
export async function resolveResendSettings(
  ctx: Pick<ActionCtx, "runQuery">,
): Promise<ResendSettings | null> {
  const stored = await ctx.runQuery(
    internal.integrationSettings.readResendSettings,
    {},
  );
  const envFrom = process.env.AUTH_EMAIL_FROM ?? DEFAULT_FROM_ADDRESS;
  if (stored) {
    return { apiKey: stored.apiKey, fromAddress: stored.fromAddress ?? envFrom };
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  return { apiKey, fromAddress: envFrom };
}

export type ResendSendResult = { ok: boolean; status: number };

/**
 * Send one email via the Resend REST API. Distinguishes two failure modes
 * that callers (`sendEmailReporting`) need to treat differently:
 *  - a non-2xx RESPONSE (bad address, invalid domain, rate limit…) is logged
 *    here and returned as `{ok:false, status}` — NOT thrown, since one
 *    rejected recipient isn't a system failure.
 *  - a `fetch` REJECTION (DNS failure, timeout, Resend fully down) is a
 *    transport failure, NOT caught here — it propagates to the caller so a
 *    real Resend outage can't be mistaken for "delivered" (see
 *    `sendEmailReporting` / `blasts.ts#deliverEmailBlast`'s per-recipient
 *    catch, which needs a real throw to count a failure).
 * The logged/returned text NEVER includes the API key.
 *
 * `text`, `replyTo`, and `headers` are optional additions for email
 * campaigns (`campaigns.ts`) — a plaintext alternative body, a per-campaign
 * `campaign+<id>@<inboundDomain>` reply-to, and the `List-Unsubscribe` /
 * `List-Unsubscribe-Post` headers a one-click-unsubscribe send needs.
 * `from` is a per-send override of `settings.fromAddress` — the per-campaign
 * "send as a person" sender (`campaigns.ts`'s `fromName`/`fromEmail`).
 * Backward compatible: every existing call site (RSVP/donation receipts,
 * blasts, verification codes) omits all four.
 */
export async function sendResendEmail(
  settings: ResendSettings,
  {
    to,
    subject,
    html,
    text,
    from,
    replyTo,
    headers,
  }: {
    to: string;
    subject: string;
    html: string;
    text?: string;
    from?: string;
    replyTo?: string;
    headers?: Record<string, string>;
  },
): Promise<ResendSendResult> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: from ?? settings.fromAddress,
      to,
      subject,
      html,
      ...(text !== undefined ? { text } : {}),
      ...(replyTo !== undefined ? { reply_to: replyTo } : {}),
      ...(headers !== undefined ? { headers } : {}),
    }),
  });
  if (!response.ok) {
    // Resend error bodies carry a code + message, never our API key.
    console.error(`[resend] send failed (${response.status}): ${await response.text()}`);
  }
  return { ok: response.ok, status: response.status };
}

/**
 * One recipient's fields for `sendResendEmailBatch` — the same per-item
 * shape a single `sendResendEmail` call takes (Resend's batch endpoint is
 * literally an array of the same object), so per-recipient personalization
 * (unsubscribe headers/tokens, merge-tag html/text) travels per-item exactly
 * like it does today.
 */
export type ResendBatchEmail = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string;
  headers?: Record<string, string>;
};

/**
 * Send up to 100 emails in ONE Resend API call
 * (`POST /emails/batch` — https://resend.com/docs/api-reference/emails/send-batch-emails).
 * Each array item carries its own `to`/`subject`/`html`/`text`/`from`/
 * `reply_to`/`headers`, so per-recipient personalization (a distinct
 * `List-Unsubscribe` token per address) works exactly like individual sends —
 * Resend just accepts the whole array in one request, which is how
 * `campaigns.ts#deliverCampaignBatch` stays comfortably under Resend's ~2
 * requests/second default rate limit while still sending each recipient
 * their own personalized email.
 *
 * Same two-failure-mode split as `sendResendEmail`, but coarser: Resend
 * rejects a batch request WHOLESALE on any per-item validation error (a 4xx
 * covering the whole array, not a per-item result) — so a non-2xx response
 * here means every item in this request failed, not just one. A transport
 * REJECTION still propagates (thrown), same as `sendResendEmail`.
 */
export async function sendResendEmailBatch(
  settings: ResendSettings,
  emails: ResendBatchEmail[],
): Promise<ResendSendResult> {
  const response = await fetch("https://api.resend.com/emails/batch", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      emails.map((e) => ({
        from: e.from ?? settings.fromAddress,
        to: e.to,
        subject: e.subject,
        html: e.html,
        ...(e.text !== undefined ? { text: e.text } : {}),
        ...(e.replyTo !== undefined ? { reply_to: e.replyTo } : {}),
        ...(e.headers !== undefined ? { headers: e.headers } : {}),
      })),
    ),
  });
  if (!response.ok) {
    console.error(`[resend] batch send failed (${response.status}): ${await response.text()}`);
  }
  return { ok: response.ok, status: response.status };
}

// ── Address parsing (per-campaign sender / org from-address domain) ─────────

/** "Name <addr@dom>" → { name, email}; a bare address → { name: null, email
 *  }. Loose (not a full RFC 5322 parse), same discipline as
 *  `integrationSettings.ts`'s `normalizeFromAddress`. */
export function parseFromAddress(raw: string): { name: string | null; email: string } {
  const trimmed = raw.trim();
  const match = /^(.*)<(.+)>$/.exec(trimmed);
  if (match) {
    const name = match[1].trim().replace(/^"|"$/g, "");
    return { name: name || null, email: match[2].trim() };
  }
  return { name: null, email: trimmed };
}

/** The lowercased domain of an email address, accepting either a bare
 *  address or the `"Name <addr@dom>"` form. `null` when it doesn't look like
 *  an email at all. */
export function emailDomain(raw: string): string | null {
  const { email } = parseFromAddress(raw);
  const at = email.lastIndexOf("@");
  if (at === -1 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

/** Build a `From:` header value from an optional display name + a bare
 *  address — `"Name <addr>"` when a name is given, else just the bare
 *  address. Used for the per-campaign sender override
 *  (`campaigns.ts`'s `fromName`/`fromEmail`). */
export function formatFromAddress(name: string | undefined | null, email: string): string {
  const trimmed = name?.trim();
  return trimmed ? `${trimmed} <${email}>` : email;
}

// ── Resend webhook signature verification (Svix) ─────────────────────────────
// Resend's outbound webhooks (bounce/complaint/inbound-reply — `http.ts`'s
// `/resend/webhook`) are signed via Svix: https://resend.com/docs/dashboard/webhooks/verify-webhooks-signatures
// Three headers (`svix-id`, `svix-timestamp`, `svix-signature`); the signed
// content is `${svix-id}.${svix-timestamp}.${rawBody}`, HMAC-SHA256,
// base64-encoded, keyed on the `whsec_...` secret's BASE64-DECODED bytes (the
// `whsec_` prefix stripped first). `svix-signature` is one or more
// space-separated `v1,<base64sig>` tokens (key rotation); we constant-time
// compare against each. Uses Web Crypto (`crypto.subtle`), not Node's
// `crypto` module — mirrors `validateTwilioSignature` (twilio.ts) /
// `verifyIncreaseSignature` (increase.ts), both Standard-Webhooks-shaped.

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Constant-time string compare — a length mismatch alone must not
 *  short-circuit before the loop runs. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface ResendWebhookHeaders {
  svixId: string | null;
  svixTimestamp: string | null;
  svixSignature: string | null;
}

/**
 * Verify a Resend/Svix webhook signature. Returns `false` (never throws) on
 * any malformed input — a missing header, an unparseable secret/timestamp, a
 * mismatched MAC. A ~5-minute timestamp tolerance guards replay, matching
 * `verifyIncreaseSignature`'s tolerance.
 */
export async function verifyResendWebhookSignature(
  rawBody: string,
  headers: ResendWebhookHeaders,
  secret: string,
): Promise<boolean> {
  const { svixId, svixTimestamp, svixSignature } = headers;
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  const ts = Number(svixTimestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const withoutPrefix = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let keyBytes: Uint8Array<ArrayBuffer>;
  try {
    keyBytes = base64ToBytes(withoutPrefix);
  } catch {
    return false; // Not valid base64 — can't be a real Svix secret.
  }

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signedContent = new TextEncoder().encode(`${svixId}.${svixTimestamp}.${rawBody}`);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, signedContent));
  const expected = bytesToBase64(mac);

  for (const token of svixSignature.split(" ")) {
    const comma = token.indexOf(",");
    const candidate = comma === -1 ? token : token.slice(comma + 1);
    if (constantTimeEqual(expected, candidate)) return true;
  }
  return false;
}
