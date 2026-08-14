/**
 * Who is reading the backer portal, and which parts of it they may read.
 *
 * ── THE HOUSE RULE, APPLIED TO SOMEBODY WHO HOLDS NO SEAT ──────────────────
 * CLAUDE.md: put a capability behind a named access function from the start,
 * even when the answer today is "anyone". The seat chart is the register for
 * STAFF powers, and a backer has no seat — so this file is the register for
 * theirs, and it has two halves that must never be confused:
 *
 *   1. AUTHENTICATE  `requireBackerSession(ctx, token)` — is this token a live
 *      session, and whose? Returns an identity, not a user.
 *   2. AUTHORISE     `requireBackerModule(ctx, session, module)` — may THIS
 *      reader see THIS module (`BACKER_PORTAL_MODULES`)?
 *
 * Every portal read calls the second one. Nothing checks `isBacker`, a scope,
 * or a pledge status inline. When the owner wants "books off for Denver until
 * it launches", or "non-backer givers see their history but not the ladder",
 * that is a change to `hasBackerModule`'s body and nothing else.
 *
 * ── THE STAFF SIDE IS A REAL SEAT POWER, AND IT ISN'T HERE ─────────────────
 * Managing the portal — seeing who has access, revoking a session — is an
 * ordinary internal power and belongs in `SEAT_CAPABILITIES` as
 * `giving.portal.edit`, resolved through `lib/givingAccess.ts`. Until that
 * string ships, `requirePortalAdmin` below is `requireGivingManage`, with the
 * graduation named — the same shape `backerMilestones.saveMilestones` uses for
 * its own TODO.
 *
 * ── THE IDENTITY JOIN LIVES HERE TOO ───────────────────────────────────────
 * "Which records count as yours" is one question with one answer, and three
 * modules (giving history, attendance, purchases) all read it. It is resolved
 * from the proven EMAIL every time rather than stored on the session: donor
 * identities are maintained scaffolding that a merge can retire, so a stored id
 * would rot while an email keeps resolving. See `schema/backerPortal.ts`.
 */
import { ConvexError } from "convex/values";
import {
  BACKER_ACCESS_GRACE_MS,
  BACKER_UNIT_CENTS,
  type BackerPortalModule,
} from "@events-os/shared";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { sha256Hex } from "./sha256";
import { requireGivingManage, type GivingScope } from "./givingAccess";

/** How long a verified session lasts before the reader signs in again. Long
 *  enough that a backer checking in monthly isn't re-authenticating every
 *  visit; short enough that a borrowed laptop isn't a standing grant. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The cookie the session token rides in. `HttpOnly` + `SameSite=Lax` are set
 *  where it is written (`lib/backerApiRoutes.ts`) — a token readable by script
 *  is a token one XSS away from being everybody's. */
export const SESSION_COOKIE = "pw_backer";

/** Namespaced so a hash from this table can never be mistaken for — or
 *  replayed against — one of `rsvpEmailCodes`'. Same discipline as
 *  `hashEmailCode`'s `rsvp-email-code:` prefix. */
export function hashSessionToken(token: string): string {
  return sha256Hex(`backer-portal-session:${token.trim()}`);
}

export function hashPortalCode(email: string, code: string): string {
  return sha256Hex(`backer-portal-code:${normalizePortalEmail(email)}:${code.trim()}`);
}

/** The one normalization every lookup goes through — `donors.email` and
 *  `donorIdentities.key` are both stored trimmed-and-lowercased, so anything
 *  else here silently fails to find a real giver. */
export function normalizePortalEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Who a session belongs to, and what that person is.
 *
 * `donorIds`/`scopes` are the identity join — every book this person gives in.
 * `isBacker` is the ORG'S OWN definition, not a re-derivation: an `active`
 * pledge at or above `BACKER_UNIT_CENTS`, exactly as
 * `givingPledges.recomputeChapterBackerCount` counts it. Re-deriving that floor
 * by hand is how a portal starts disagreeing with the number on a city's public
 * page.
 */
export type BackerSession = {
  sessionId: Id<"backerPortalSessions">;
  email: string;
  /** Their `donors` rows, one per book they give in. Possibly empty — a person
   *  can hold a live session and have given nothing (a cancelled backer whose
   *  rows were merged elsewhere, an address that matched nothing). */
  donorIds: Id<"donors">[];
  scopes: GivingScope[];
  /** Display name, from the strongest donor row. */
  name: string;
  /** An `active` pledge at or above the $50 backer floor, right now. */
  isBacker: boolean;
  /** They were a backer and the pledge has stopped, but within the grace
   *  window — full access, deliberately (`BACKER_ACCESS_GRACE_MS`). */
  inGrace: boolean;
  /** Every pledge they hold, newest first — the backing module's own data. */
  pledges: Doc<"pledges">[];
};

/** The live session row for a token, or `null`. Expiry is enforced here and
 *  nowhere else. */
async function sessionRowFor(
  ctx: QueryCtx,
  token: string,
): Promise<Doc<"backerPortalSessions"> | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;
  const row = await ctx.db
    .query("backerPortalSessions")
    .withIndex("by_token", (q) => q.eq("tokenHash", hashSessionToken(trimmed)))
    .unique();
  if (!row) return null;
  if (row.expiresAt <= Date.now()) return null;
  return row;
}

/**
 * Resolve a token to everything the portal needs about its holder, or `null`.
 *
 * BOUNDED READS ONLY. A person's donor rows are one per book and their pledges
 * are a handful; both are `.take()`-capped anyway so a pathological identity
 * can't turn a page render into a table scan.
 */
export async function hasBackerSession(
  ctx: QueryCtx,
  token: string | undefined,
): Promise<BackerSession | null> {
  if (!token) return null;
  const row = await sessionRowFor(ctx, token);
  if (!row) return null;

  // EMAIL → donors, across every book. `by_email` is the donors table's own
  // documented cross-scope lookup.
  const donors = await ctx.db
    .query("donors")
    .withIndex("by_email", (q) => q.eq("email", row.email))
    .take(50);

  const pledges: Doc<"pledges">[] = [];
  for (const donor of donors) {
    const forDonor = await ctx.db
      .query("pledges")
      .withIndex("by_donor", (q) => q.eq("donorId", donor._id))
      .take(20);
    pledges.push(...forDonor);
  }
  pledges.sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt));

  const isBacker = pledges.some(
    (p) => p.status === "active" && p.amountCents >= BACKER_UNIT_CENTS,
  );
  // THE GRACE WINDOW. A pledge that has stopped keeps its holder's full access
  // for `BACKER_ACCESS_GRACE_MS` past the day it stopped — see that constant
  // for the owner's reasoning. Measured from `canceledAt` when we have it and
  // from the last period end otherwise, because a `past_due` pledge has no
  // cancellation date and is usually a bank rather than a decision.
  const graceFloor = Date.now() - BACKER_ACCESS_GRACE_MS;
  const inGrace =
    !isBacker &&
    pledges.some(
      (p) =>
        p.amountCents >= BACKER_UNIT_CENTS &&
        Math.max(p.canceledAt ?? 0, p.currentPeriodEnd ?? 0, p.startedAt ?? 0) >
          graceFloor,
    );

  const strongest = [...donors].sort((a, b) => b.lifetimeCents - a.lifetimeCents)[0];
  return {
    sessionId: row._id,
    email: row.email,
    donorIds: donors.map((d) => d._id),
    scopes: [...new Set(donors.map((d) => d.scope))] as GivingScope[],
    name: strongest?.name ?? row.email,
    isBacker,
    inGrace,
    pledges,
  };
}

/** The `require` twin. Throws the one message an unauthenticated reader can
 *  act on — "sign in again" — rather than leaking whether the token was
 *  wrong, expired, or revoked. */
export async function requireBackerSession(
  ctx: QueryCtx,
  token: string | undefined,
): Promise<BackerSession> {
  const session = await hasBackerSession(ctx, token);
  if (!session) {
    throw new ConvexError({
      code: "NOT_SIGNED_IN",
      message: "Your sign-in has expired. Enter your email to get a new code.",
    });
  }
  return session;
}

/**
 * May this reader see this module?
 *
 * ── TODAY'S BODY, AND WHY IT IS SHAPED THIS WAY ────────────────────────────
 * Two tiers, deliberately:
 *
 *  · YOUR OWN RECORD (`giving`, `backing`) is open to any authenticated giver,
 *    backer or not, for good and for ever. It is THEIR data. A $20/month giver
 *    being told "you're not important enough to see your own receipts" is the
 *    single most alienating thing this page could do, and the owner's decision
 *    on scope (2026-08-14) says the same: everyone signs in; the BACKER-ONLY
 *    part is what we show about the ORG.
 *
 *  · WHAT WE SHOW ABOUT THE ORG (`books`, `health`, `events`, `people`) needs
 *    an active backing — or the grace window after one. This is the "backer
 *    only" the owner asked for, and it is deliberately not per-chapter: he
 *    settled that any backer sees EVERY city, Central and the ones being
 *    raised, not only the one they fund.
 *
 * Note what this does NOT do: it never asks which chapter the module is about.
 * That is the decision recorded above, and the moment it needs to change —
 * "Denver's books stay closed until it launches" — it changes here, in one
 * body, with every call site already asking the right question.
 */
export function hasBackerModule(
  session: BackerSession,
  module: BackerPortalModule,
): boolean {
  switch (module) {
    case "giving":
    case "backing":
      return true;
    case "books":
    case "health":
    case "events":
    case "people":
      return session.isBacker || session.inGrace;
  }
}

/** Assert, else throw. Every portal read uses THIS form — see the module doc. */
export function requireBackerModule(
  session: BackerSession,
  module: BackerPortalModule,
): void {
  if (hasBackerModule(session, module)) return;
  throw new ConvexError({
    code: "NOT_A_BACKER",
    message:
      "That part of the portal is for backers — people giving monthly to a city.",
  });
}

/**
 * The STAFF power to manage the portal (see who has access, revoke a session).
 *
 * TODO(giving.portal.edit): this is a seat capability waiting for its string.
 * Add `"giving.portal.edit"` to `SEAT_CAPABILITIES`, carry it on
 * `development_director` and `executive_director` in `SEAT_DEFS`, and change
 * this body to ask for it. Until then it borrows `giving.manage`, which is the
 * nearest true statement — the people who can move a gift are the people who
 * can revoke a portal session — and every call site already routes through
 * here, so the graduation is one function.
 */
export async function requirePortalAdmin(
  ctx: QueryCtx,
  scope: GivingScope,
): Promise<void> {
  await requireGivingManage(ctx, scope);
}

/** Touch a session's `lastSeenAt`. Best-effort bookkeeping: a page that
 *  rendered must never fail because this didn't. */
export async function touchBackerSession(
  ctx: MutationCtx,
  sessionId: Id<"backerPortalSessions">,
): Promise<void> {
  const row = await ctx.db.get(sessionId);
  if (!row) return;
  await ctx.db.patch(sessionId, { lastSeenAt: Date.now() });
}
