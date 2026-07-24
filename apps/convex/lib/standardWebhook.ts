/**
 * Standard Webhooks signature verification (https://www.standardwebhooks.com).
 *
 * The Standard Webhooks spec — used by Increase's own webhooks and by Svix, the
 * delivery layer Resend sends inbound `email.received` events through — signs
 * `${id}.${timestamp}.${rawBody}` with HMAC-SHA256, base64-encodes the MAC, and
 * ships it in a `webhook-signature` (Increase) / `svix-signature` (Svix/Resend)
 * header as one or more SPACE-separated `v1,<base64sig>` tokens (more than one
 * during a key rotation). The signing SECRET is the shared `whsec_<base64>`
 * value from the provider's webhook settings.
 *
 * This module is the single implementation both `verifyIncreaseSignature`
 * (`increase.ts`) and the Resend inbound route (`http.ts`) delegate to, so the
 * two can never drift on the crypto. The header NAMES differ per provider
 * (`webhook-*` vs `svix-*`); the caller reads whichever set applies and passes
 * the three values in here.
 */

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

/** The three Standard Webhooks values, already read off the request headers by
 *  the caller (under whichever prefix the provider uses). */
export interface StandardWebhookParts {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

/**
 * Verify a Standard Webhooks signature. Returns `true` iff the signature is
 * valid for `rawBody` under `secret` and the timestamp is within
 * `toleranceSeconds` of now (replay guard, default 5 minutes).
 *
 * KEY AMBIGUITY (carried over from `verifyIncreaseSignature`): a provider's
 * "shared secret" may be the HMAC key EITHER raw (its UTF-8 bytes) OR
 * base64-decoded (the `whsec_<base64>` convention). We can't know which, so we
 * try EVERY candidate key and accept if ANY produces a matching signature:
 *   - the raw secret bytes,
 *   - the raw bytes after stripping a `whsec_` prefix,
 *   - the base64-DECODED bytes of the secret (sans `whsec_`), when it decodes.
 */
export async function verifyStandardWebhookSignature(
  rawBody: string,
  parts: StandardWebhookParts,
  secret: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  const { id, timestamp, signature } = parts;
  if (!id || !timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) return false;

  const withoutPrefix = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const candidateKeys: Uint8Array<ArrayBuffer>[] = [
    new Uint8Array(new TextEncoder().encode(secret)),
  ];
  if (withoutPrefix !== secret) {
    candidateKeys.push(new Uint8Array(new TextEncoder().encode(withoutPrefix)));
  }
  try {
    candidateKeys.push(base64ToBytes(withoutPrefix));
  } catch {
    // Not valid base64 — skip the decoded-key candidate.
  }

  const signedContent = new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`);
  const tokens = signature.split(" ");

  for (const keyBytes of candidateKeys) {
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, signedContent));
    const expected = bytesToBase64(mac);

    for (const token of tokens) {
      const comma = token.indexOf(",");
      if (comma === -1) continue;
      const version = token.slice(0, comma);
      const candidate = token.slice(comma + 1);
      if (version !== "v1") continue;
      if (candidate.length !== expected.length) continue;
      let diff = 0;
      for (let i = 0; i < expected.length; i++) {
        diff |= expected.charCodeAt(i) ^ candidate.charCodeAt(i);
      }
      if (diff === 0) return true;
    }
  }
  return false;
}
