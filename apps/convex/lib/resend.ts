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

/**
 * Send one email via the Resend REST API. Throws on a non-2xx response so
 * callers that need to know whether delivery landed (`sendEmailReporting`)
 * can report it; the thrown message NEVER includes the API key.
 */
export async function sendResendEmail(
  settings: ResendSettings,
  { to, subject, html }: { to: string; subject: string; html: string },
): Promise<void> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: settings.fromAddress, to, subject, html }),
  });
  if (!response.ok) {
    // Resend error bodies carry a code + message, never our API key.
    throw new Error(`Resend send failed (${response.status}): ${await response.text()}`);
  }
}
