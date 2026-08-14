/**
 * The backer portal's two capability tables — how a giver proves they own an
 * email address, and how that proof is carried for a while afterwards.
 *
 * ── NEITHER ROW HOLDS ANYTHING WORTH STEALING ──────────────────────────────
 * Both are pure capability rows: a hash, a coordinate, an expiry. No money, no
 * giving history, no name. The portal's DATA all lives where it already lives
 * (`donors`, `gifts`, `pledges`); these two tables only answer "is the person
 * holding this token allowed to read it?". `financePublicationPreviewTokens` is
 * the in-repo precedent for that shape — a token row carries coordinates, not
 * content.
 *
 * ── ONLY HASHES, BOTH TIMES ────────────────────────────────────────────────
 * The 6-digit code and the session token are stored as SHA-256 hashes, never in
 * the clear, matching `rsvpEmailCodes`. A database dump is then not a set of
 * live sign-ins. The email is stored normalized and in the clear on the code
 * row — it is the thing being proven, and hashing it would make "did I already
 * send this address a code a second ago?" unanswerable.
 *
 * ── AND THE IDENTITY IS RESOLVED AT SIGN-IN, NOT STORED ────────────────────
 * A session names an EMAIL, not a `donorIdentities` id. Identities are
 * maintained scaffolding — `lib/donorIdentity.ts` documents them as safe to
 * delete and rebuild, and a merge can retire one — so a session pinned to an id
 * would silently become a session pointing at nothing. The email is the durable
 * key (`donors.by_email`, `donorIdentities.key` = `e:<email>`), so every read
 * re-resolves from it and a merge or rebuild simply resolves differently.
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * A pending sign-in code for one email address. At most one row per address —
 * requesting a second code overwrites the first, which is also what makes
 * "5 attempts" a bound on the address rather than on a row somebody can churn.
 */
export const backerPortalCodes = defineTable({
  /** Normalized (trimmed, lowercased) email — the address being proven. */
  email: v.string(),
  /** SHA-256 of the 6-digit code. Never the code itself. */
  codeHash: v.string(),
  /** When this code stops being accepted (15 minutes — `CODE_TTL_MS`). */
  expiresAt: v.number(),
  /** Failed verifications so far. At `MAX_CODE_ATTEMPTS` the row is spent and
   *  a new code must be requested — the guard against guessing six digits. */
  attempts: v.number(),
  /** Last send, for the one-per-minute resend interval. */
  lastSentAt: v.number(),
  createdAt: v.number(),
}).index("by_email", ["email"]);

/**
 * A live portal session. Created by a verified code, carried in a `HttpOnly`
 * cookie, and revocable by deleting the row — which is the whole reason this is
 * a session rather than the signed link the contractor pages use. A forwarded
 * or archived email must not become permanent access to somebody's complete
 * giving history.
 */
export const backerPortalSessions = defineTable({
  /** SHA-256 of the opaque 32-char token. Never the token itself. */
  tokenHash: v.string(),
  /** The proven, normalized email. See the module doc for why this rather than
   *  a `donorIdentities` id. */
  email: v.string(),
  expiresAt: v.number(),
  createdAt: v.number(),
  /** Touched on use, so a stale-session sweep (and a staff "who's been in
   *  lately" view) has something honest to read. */
  lastSeenAt: v.number(),
})
  .index("by_token", ["tokenHash"])
  // Every session for one address — what a "sign me out everywhere" and a
  // staff-side revoke both read.
  .index("by_email", ["email"]);
