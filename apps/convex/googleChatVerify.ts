"use node";

import { createVerify } from "node:crypto";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";

const CHAT_SERVICE_ACCOUNT = "chat@system.gserviceaccount.com";
const GOOGLE_ID_TOKEN_CERTS = "https://www.googleapis.com/oauth2/v1/certs";
const CHAT_JWT_CERTS =
  "https://www.googleapis.com/service_accounts/v1/metadata/x509/" +
  CHAT_SERVICE_ACCOUNT;
const CLOCK_SKEW_SECONDS = 60;

export const verifyGoogleChatBearer = internalAction({
  args: {
    authorization: v.union(v.string(), v.null()),
    audience: v.string(),
  },
  handler: async (_ctx, { authorization, audience }) =>
    verifyGoogleChatAuthorization(authorization, audience),
});

export async function verifyGoogleChatAuthorization(
  authorization: string | null,
  audience: string,
): Promise<boolean> {
  const bearer = bearerToken(authorization);
  if (!bearer || !audience) {
    console.warn("[googleChatLinkPreview] token missing", {
      hasBearer: Boolean(bearer),
      hasAudience: Boolean(audience),
    });
    return false;
  }
  const parsed = parseJwt(bearer);
  if (!parsed) {
    console.warn("[googleChatLinkPreview] token parse failed");
    return false;
  }
  const certsUrl =
    parsed.payload.iss === CHAT_SERVICE_ACCOUNT
      ? CHAT_JWT_CERTS
      : GOOGLE_ID_TOKEN_CERTS;
  if (!isCurrentToken(parsed.payload)) {
    console.warn("[googleChatLinkPreview] token time invalid", tokenLog(parsed));
    return false;
  }
  const certsResponse = await fetch(certsUrl);
  if (!certsResponse.ok) {
    console.warn("[googleChatLinkPreview] token cert fetch failed", {
      ...tokenLog(parsed),
      certsUrl,
      status: certsResponse.status,
    });
    return false;
  }
  const certs = (await certsResponse.json()) as Record<string, string>;
  const pem = parsed.header.kid ? certs[parsed.header.kid] : undefined;
  if (!pem) {
    console.warn("[googleChatLinkPreview] token key not found", {
      ...tokenLog(parsed),
      certKeyCount: Object.keys(certs).length,
    });
    return false;
  }
  if (!verifyRs256(parsed.signingInput, parsed.signature, pem)) {
    console.warn("[googleChatLinkPreview] token signature invalid", tokenLog(parsed));
    return false;
  }
  if (!audienceMatches(parsed.payload.aud, audience)) {
    console.warn("[googleChatLinkPreview] token audience mismatch", {
      expectedAudiences: audiences(audience),
      tokenAudience: parsed.payload.aud,
      issuer: parsed.payload.iss,
      email: parsed.payload.email,
      emailVerified: parsed.payload.email_verified,
      keyId: parsed.header.kid,
    });
    return false;
  }

  if (parsed.payload.iss === CHAT_SERVICE_ACCOUNT) return true;
  const issuerOk =
    parsed.payload.iss === "accounts.google.com" ||
    parsed.payload.iss === "https://accounts.google.com";
  const issuerAndEmailOk =
    issuerOk &&
    parsed.payload.email === CHAT_SERVICE_ACCOUNT &&
    parsed.payload.email_verified === true;
  if (!issuerAndEmailOk) {
    console.warn("[googleChatLinkPreview] token issuer/email invalid", {
      ...tokenLog(parsed),
      issuerOk,
    });
  }
  return issuerAndEmailOk;
}

function tokenLog(parsed: {
  header: { kid?: string };
  payload: {
    aud?: string;
    iss?: string;
    email?: string;
    email_verified?: boolean;
    exp?: number;
    iat?: number;
    nbf?: number;
  };
}): Record<string, unknown> {
  return {
    tokenAudience: parsed.payload.aud,
    issuer: parsed.payload.iss,
    email: parsed.payload.email,
    emailVerified: parsed.payload.email_verified,
    keyId: parsed.header.kid,
    exp: parsed.payload.exp,
    iat: parsed.payload.iat,
    nbf: parsed.payload.nbf,
  };
}

function audiences(audience: string): string[] {
  return audience
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function audienceMatches(tokenAudience: string | undefined, audience: string): boolean {
  return typeof tokenAudience === "string" && audiences(audience).includes(tokenAudience);
}

function bearerToken(authorization: string | null): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
  return match?.[1]?.trim() || null;
}

function parseJwt(token: string): {
  header: { alg?: string; kid?: string };
  payload: {
    aud?: string;
    iss?: string;
    email?: string;
    email_verified?: boolean;
    exp?: number;
    iat?: number;
    nbf?: number;
  };
  signingInput: string;
  signature: string;
} | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, signature] = parts;
  const header = parseBase64Json<{ alg?: string; kid?: string }>(parts[0]);
  const payload = parseBase64Json<{
    aud?: string;
    iss?: string;
    email?: string;
    email_verified?: boolean;
    exp?: number;
    iat?: number;
    nbf?: number;
  }>(parts[1]);
  if (!header || !payload || header.alg !== "RS256") return null;
  return {
    header,
    payload,
    signingInput: `${encodedHeader}.${encodedPayload}`,
    signature,
  };
}

function isCurrentToken(payload: {
  exp?: number;
  iat?: number;
  nbf?: number;
}): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (
    typeof payload.exp !== "number" ||
    payload.exp < now - CLOCK_SKEW_SECONDS
  ) {
    return false;
  }
  if (
    typeof payload.nbf === "number" &&
    payload.nbf > now + CLOCK_SKEW_SECONDS
  ) {
    return false;
  }
  if (
    typeof payload.iat === "number" &&
    payload.iat > now + CLOCK_SKEW_SECONDS
  ) {
    return false;
  }
  return true;
}

function parseBase64Json<T>(value: string): T | null {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function verifyRs256(
  signingInput: string,
  signature: string,
  pem: string,
): boolean {
  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(signingInput);
    verifier.end();
    return verifier.verify(pem, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}
