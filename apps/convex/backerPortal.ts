/**
 * The backer portal's backend — sign in, read your own record, sign out.
 *
 * The page itself is `lib/backerPortalPage.ts` (server-rendered, house style);
 * its same-origin JSON surface is `lib/backerApiRoutes.ts`; who may read what
 * is `lib/backerAccess.ts`. This file is the data.
 *
 * ── THE SIGN-IN IS DELIBERATELY UNINFORMATIVE ──────────────────────────────
 * `requestCode` returns the SAME answer for an address we know and one we have
 * never seen. A giving history is exactly the kind of thing whose existence is
 * worth hiding: "does Public Worship have a donor with this email?" must not be
 * a question a stranger can ask a thousand times. The `/finances` preview 404
 * sets the same precedent in this codebase. Everything downstream — the code
 * email, the row, the rate limiter — is arranged so that the two paths are
 * indistinguishable from outside.
 *
 * ── AND THE READS ARE ALL BOUNDED ──────────────────────────────────────────
 * Every query here runs for an unauthenticated-until-proven stranger on a
 * public URL, so nothing walks a table: donors are `by_email` (one row per book
 * they give in), gifts are `by_donor` and capped, pledges are `by_donor` and
 * capped. A person with a hundred books would render a slow page, not a
 * transaction failure.
 */
import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { BACKER_UNIT_CENTS } from "@events-os/shared";
import { newGuestToken } from "./ticketing";
import { sendEmail } from "./ticketingEmails";
import {
  SESSION_TTL_MS,
  hashPortalCode,
  hashSessionToken,
  normalizePortalEmail,
  requireBackerModule,
  requireBackerSession,
  touchBackerSession,
} from "./lib/backerAccess";
import { renderPortalCodeEmail } from "./lib/backerPortalEmails";
import { scopeLabel } from "./lib/givingNotificationContext";
import { giftMethodLabel } from "./lib/giftLabels";
import { AFFORDABILITY_TIERS } from "@events-os/shared";

/** Code policy, transcribed from `lib/emailCodes.ts` — the RSVP flow's numbers,
 *  because a person should not have to learn two different sign-in rhythms.
 *  Not imported: that module's helpers are all shaped around an `rsvps` row. */
export const CODE_TTL_MS = 15 * 60 * 1000;
export const RESEND_INTERVAL_MS = 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;

/** Rate-limit budgets, per IP per hour. Generous for a person who mistypes
 *  their address twice and impatient-clicks; far below what enumerating a donor
 *  list would take. */
const RATE_WINDOW_MS = 60 * 60 * 1000;
const CODE_REQUESTS_MAX_PER_IP = 12;
const VERIFY_ATTEMPTS_MAX_PER_IP = 20;

/** How many gifts the history lists. Far past any real giver's lifetime. */
const MAX_HISTORY_GIFTS = 200;

/**
 * The shared attempt-counter table, with our own key prefixes so one endpoint
 * can never burn another's budget. Same mechanism as
 * `contractorPayments.ts#assertContractNotRateLimited`, deliberately reusing
 * `reimbursementSubmitAttempts` rather than adding a third attempts table —
 * it is already the house's generic "how many times has this key done this
 * lately" ledger.
 */
async function assertPortalNotRateLimited(
  ctx: MutationCtx,
  key: string,
  max: number,
): Promise<void> {
  const windowStart = Date.now() - RATE_WINDOW_MS;
  const recent = await ctx.db
    .query("reimbursementSubmitAttempts")
    .withIndex("by_key_and_time", (q) =>
      q.eq("key", key).gte("createdAt", windowStart),
    )
    .take(max);
  if (recent.length >= max) {
    throw new ConvexError({
      code: "RATE_LIMITED",
      message: "Too many attempts recently. Please try again in a bit.",
    });
  }
  await ctx.db.insert("reimbursementSubmitAttempts", {
    key,
    createdAt: Date.now(),
  });
}

function newSixDigitCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1_000_000).padStart(6, "0");
}

// ── Sign in ──────────────────────────────────────────────────────────────────

/**
 * Mint (or silently keep) a sign-in code for an address, and say nothing about
 * whether we know it.
 *
 * Returns `{ sent: true }` in every non-rate-limited case — see the module doc.
 * The only thing that varies invisibly is whether an email is actually
 * scheduled, and even that is arranged so timing barely differs: the donor
 * lookup happens either way.
 *
 * A code requested less than a minute after the last one silently reuses the
 * pending row rather than re-sending, which is the RSVP flow's behaviour and
 * stops "click resend eight times" from becoming eight emails.
 */
export const requestCode = internalMutation({
  args: { email: v.string(), clientIp: v.optional(v.string()) },
  returns: v.object({ sent: v.boolean() }),
  handler: async (ctx, args) => {
    await assertPortalNotRateLimited(
      ctx,
      `backer_code_ip:${args.clientIp ?? "unknown"}`,
      CODE_REQUESTS_MAX_PER_IP,
    );

    const email = normalizePortalEmail(args.email);
    if (!email.includes("@") || email.length > 254) {
      throw new ConvexError({
        code: "INVALID_EMAIL",
        message: "That doesn't look like an email address.",
      });
    }

    // THE LOOKUP HAPPENS EITHER WAY. Whether a donor exists decides only
    // whether an email is scheduled — never what this function returns, and
    // never how much work it did first.
    const donor = await ctx.db
      .query("donors")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();

    const now = Date.now();
    const existing = await ctx.db
      .query("backerPortalCodes")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();

    if (existing && now - existing.lastSentAt < RESEND_INTERVAL_MS) {
      // Recently sent: keep the pending code, send nothing, say the same thing.
      return { sent: true };
    }

    const code = newSixDigitCode();
    const fields = {
      codeHash: hashPortalCode(email, code),
      expiresAt: now + CODE_TTL_MS,
      attempts: 0,
      lastSentAt: now,
    };
    if (existing) await ctx.db.patch(existing._id, fields);
    else {
      await ctx.db.insert("backerPortalCodes", {
        email,
        ...fields,
        createdAt: now,
      });
    }

    if (donor) {
      await ctx.scheduler.runAfter(0, internal.backerPortal.sendPortalCode, {
        email,
        code,
      });
    }
    return { sent: true };
  },
});

/** Mail one sign-in code. Transactional — no unsubscribe footer, no suppression
 *  consult; a sign-in code is not marketing (`givingComms.ts` documents the
 *  split). Degrades to a logged no-op with no Resend key. */
export const sendPortalCode = internalAction({
  args: { email: v.string(), code: v.string() },
  returns: v.null(),
  handler: async (ctx, { email, code }) => {
    const { subject, html } = renderPortalCodeEmail({ code });
    await sendEmail(ctx, { to: email, subject, html });
    return null;
  },
});

/**
 * Trade a correct code for a session token.
 *
 * Three ways this refuses, and they are deliberately distinguishable to the
 * person holding the code (wrong / expired / spent) — unlike the sign-in
 * request above, which must tell a stranger nothing. Somebody typing a code
 * they were just emailed already knows the address is on file; hiding WHY it
 * didn't work at that point is user-hostile without buying any secrecy.
 *
 * A correct code is CONSUMED — the row is deleted, so a code is good exactly
 * once even if the email is read twice.
 */
export const verifyCode = internalMutation({
  args: {
    email: v.string(),
    code: v.string(),
    clientIp: v.optional(v.string()),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      token: v.string(),
      expiresAt: v.number(),
    }),
    v.object({ ok: v.literal(false), error: v.string() }),
  ),
  handler: async (ctx, args) => {
    await assertPortalNotRateLimited(
      ctx,
      `backer_verify_ip:${args.clientIp ?? "unknown"}`,
      VERIFY_ATTEMPTS_MAX_PER_IP,
    );

    const email = normalizePortalEmail(args.email);
    const row = await ctx.db
      .query("backerPortalCodes")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    // ── A WRONG CODE *RETURNS*; AN UNUSABLE ONE THROWS ────────────────────
    // The distinction is load-bearing and it is the house pattern
    // (`ticketingVerification.verifyRsvpEmail`). A `ConvexError` ROLLS THE
    // MUTATION BACK — including the `attempts` increment — so throwing on a
    // wrong code would mean the counter never persisted and the five-attempt
    // guard never fired once, leaving six digits protected by nothing but the
    // hourly IP budget. Returning commits the increment. The cases that write
    // nothing (no row, expired, spent) still throw, because there is no write
    // to lose and the page reads their messages out.
    const wrong = { ok: false as const, error: "That code didn't match. Check the email and try again." };
    if (!row) return wrong;
    // NEITHER OF THESE DELETES THE ROW, and that is deliberate rather than
    // lazy: a `ConvexError` rolls its own transaction back, so a delete here
    // would never commit — the code would read as tidy and do nothing. The row
    // is already inert (expired, or out of attempts), it refuses every future
    // guess exactly as it is, and `requestCode` overwrites it the moment the
    // person asks for a fresh code. Same shape as
    // `ticketingVerification.requireUsableCode`, which throws without deleting
    // for the same reason.
    if (row.expiresAt <= Date.now()) {
      throw new ConvexError({
        code: "CODE_EXPIRED",
        message: "That code has expired — send yourself a new one.",
      });
    }
    if (row.attempts >= MAX_CODE_ATTEMPTS) {
      throw new ConvexError({
        code: "CODE_SPENT",
        message: "Too many tries on that code. Send yourself a new one.",
      });
    }
    if (row.codeHash !== hashPortalCode(email, args.code)) {
      await ctx.db.patch(row._id, { attempts: row.attempts + 1 });
      return wrong;
    }

    // Correct. Spend the code and mint the session.
    await ctx.db.delete(row._id);
    const token = newGuestToken();
    const now = Date.now();
    await ctx.db.insert("backerPortalSessions", {
      tokenHash: hashSessionToken(token),
      email,
      expiresAt: now + SESSION_TTL_MS,
      createdAt: now,
      lastSeenAt: now,
    });
    return { ok: true as const, token, expiresAt: now + SESSION_TTL_MS };
  },
});

/** End one session. Idempotent, and deliberately silent about whether the token
 *  was live — a sign-out that reports "you weren't signed in" is an oracle. */
export const signOut = internalMutation({
  args: { token: v.string() },
  returns: v.null(),
  handler: async (ctx, { token }) => {
    const row = await ctx.db
      .query("backerPortalSessions")
      .withIndex("by_token", (q) => q.eq("tokenHash", hashSessionToken(token)))
      .unique();
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});

// ── The page's data ──────────────────────────────────────────────────────────

/** One pledge, as the page renders it. */
const portalPledge = v.object({
  pledgeId: v.id("pledges"),
  amountCents: v.number(),
  status: v.string(),
  scopeLabel: v.string(),
  startedAt: v.optional(v.number()),
  currentPeriodEnd: v.optional(v.number()),
  canceledAt: v.optional(v.number()),
  isBacker: v.boolean(),
  /** An `imported` pledge lives on the old platform and cannot be managed
   *  here — the page says so instead of offering a button that would fail. */
  manageable: v.boolean(),
  /** The public page for this city, when it has one — the share link. */
  givePath: v.union(v.string(), v.null()),
});

/**
 * Everything the portal renders for one session, in one read.
 *
 * ONE QUERY, not six, because this is a server-rendered page: it has exactly
 * one chance to gather its data, and six round trips would be six chances for
 * a partial render. Each SECTION is still gated individually through
 * `requireBackerModule` — the gathering being shared doesn't make the
 * authorisation shared.
 */
export const portalPayload = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const session = await requireBackerSession(ctx, token);

    // ── Your backing (module: backing) ──────────────────────────────────────
    requireBackerModule(session, "backing");
    const chapterNames = new Map<string, string>();
    const labelFor = async (scope: Doc<"pledges">["scope"]): Promise<string> => {
      const key = scope as string;
      let label = chapterNames.get(key);
      if (label === undefined) {
        label = await scopeLabel(ctx, scope);
        chapterNames.set(key, label);
      }
      return label;
    };

    const pledges = [];
    for (const pledge of session.pledges) {
      let givePath: string | null = null;
      if (pledge.scope !== "central") {
        const chapterId = pledge.scope as Id<"chapters">;
        const territory = await ctx.db
          .query("territories")
          .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
          .unique();
        if (territory?.publiclyVisible) givePath = `/give/${territory.slug}`;
      }
      pledges.push({
        pledgeId: pledge._id,
        amountCents: pledge.amountCents,
        status: pledge.status,
        scopeLabel: await labelFor(pledge.scope),
        startedAt: pledge.startedAt,
        currentPeriodEnd: pledge.currentPeriodEnd,
        canceledAt: pledge.canceledAt,
        isBacker:
          pledge.status === "active" && pledge.amountCents >= BACKER_UNIT_CENTS,
        // Only a Stripe-origin pledge with a live subscription can be managed
        // from here. An `imported` one bills on the old platform.
        manageable: pledge.origin === "stripe" && !!pledge.stripeSubscriptionId,
        givePath,
      });
    }

    // ── Your giving (module: giving) ────────────────────────────────────────
    requireBackerModule(session, "giving");
    const gifts: Doc<"gifts">[] = [];
    let lifetimeCents = 0;
    let giftCount = 0;
    let firstGiftAt: number | undefined;
    for (const donorId of session.donorIds) {
      const donor = await ctx.db.get(donorId);
      if (donor) {
        lifetimeCents += donor.lifetimeCents;
        giftCount += donor.giftCount;
        if (
          donor.firstGiftAt !== undefined &&
          (firstGiftAt === undefined || donor.firstGiftAt < firstGiftAt)
        ) {
          firstGiftAt = donor.firstGiftAt;
        }
      }
      const rows = await ctx.db
        .query("gifts")
        .withIndex("by_donor", (q) => q.eq("donorId", donorId))
        .take(MAX_HISTORY_GIFTS);
      gifts.push(...rows);
    }
    gifts.sort((a, b) => b.receivedAt - a.receivedAt);

    // Reversals, rendered IN PLACE among the gifts rather than hidden in a
    // tab — a record that quietly omits the gift your bank took back is a
    // record nobody should trust. Keyed by the gift they reversed.
    const reversals: {
      amountCents: number;
      reversedAt: number;
      scope: Doc<"gifts">["scope"];
    }[] = [];
    for (const donorId of session.donorIds) {
      const rows = await ctx.db
        .query("giftReversals")
        .withIndex("by_donor", (q) => q.eq("donorId", donorId))
        .take(50);
      for (const row of rows) {
        // A RESTORED reversal is one the bank gave back — the gift stands, so
        // it is not struck through. `restoredGiftId` names the row that
        // replaced it; the reversal itself carries no live gift link, so an
        // unrestored reversal is rendered as its own line rather than by
        // striking a gift row.
        if (row.status !== "restored") {
          reversals.push({
            amountCents: row.amountCents,
            reversedAt: row.reversedAt,
            scope: row.scope,
          });
        }
      }
    }

    const history = await Promise.all(
      gifts.slice(0, MAX_HISTORY_GIFTS).map(async (gift) => ({
        giftId: String(gift._id),
        amountCents: gift.amountCents,
        receivedAt: gift.receivedAt,
        methodLabel: giftMethodLabel(gift.method),
        scopeLabel: await labelFor(gift.scope),
        isRecurring: !!gift.pledgeId,
        coveredFees: !!gift.feeCoverageCents,
        reversed: false,
      })),
    );

    // Reversals ride in the same list, dated where they happened. A record
    // that quietly drops the gift your bank took back is a record nobody
    // should trust — so it is shown, struck through, in place.
    for (const r of reversals) {
      history.push({
        // A reversal is not a gift and has no gift id — the view's key is a
        // string, so it says what this row is rather than borrowing an id that
        // would point at the wrong thing.
        giftId: `reversal-${r.reversedAt}`,
        amountCents: r.amountCents,
        receivedAt: r.reversedAt,
        methodLabel: "Returned by your bank",
        scopeLabel: await labelFor(r.scope),
        isRecurring: false,
        coveredFees: false,
        reversed: true,
      });
    }
    history.sort((a, b) => b.receivedAt - a.receivedAt);

    // ── The org's side: only for backers (modules: health, events) ──────────
    const backerOnly = pledges.some((p) => p.isBacker) || session.inGrace;

    let ladder: {
      scopeLabel: string;
      backerCount: number;
      nextAt: number | null;
      nextLabel: string | null;
      nextCommitment: string | null;
      rungs: { minBackers: number; label: string; commitment: string; reached: boolean }[];
    } | null = null;
    let upcoming: { name: string; startsAt: number; venue: string | null }[] = [];

    if (backerOnly) {
      // The city this person backs — the first chapter-scoped pledge they hold.
      const home = session.pledges.find((p) => p.scope !== "central");
      const homeChapterId =
        home && home.scope !== "central"
          ? (home.scope as Id<"chapters">)
          : null;
      if (homeChapterId) {
        requireBackerModule(session, "health");
        const chapter = await ctx.db.get(homeChapterId);
        const backerCount = chapter?.backerCount ?? 0;
        const configured = await ctx.db
          .query("backerMilestones")
          .withIndex("by_minBackers")
          .order("asc")
          .take(20);
        // The configured ladder, else the shared affordability tiers — the same
        // fallback `backerMilestones.ts` documents, so the portal and the public
        // `/give` page can never promise different rungs.
        const rungs = configured.length
          ? configured.map((m) => ({
              minBackers: m.minBackers,
              label: m.label,
              commitment: m.commitment,
              reached: backerCount >= m.minBackers,
            }))
          : // The shared tiers carry no commitment sentence — the ladder table
            // is where a rung's promise is authored. Falling back to the tier
            // LABEL alone is honest; inventing a promise here would put words
            // in the org's mouth that its own config never said.
            [...AFFORDABILITY_TIERS]
              .sort((a, b) => a.minBackers - b.minBackers)
              .map((t) => ({
                minBackers: t.minBackers,
                label: t.label,
                commitment: "",
                reached: backerCount >= t.minBackers,
              }));
        const next = rungs.find((r) => !r.reached) ?? null;
        ladder = {
          scopeLabel: await labelFor(homeChapterId),
          backerCount,
          nextAt: next?.minBackers ?? null,
          nextLabel: next?.label ?? null,
          nextCommitment: next?.commitment ?? null,
          rungs,
        };

        requireBackerModule(session, "events");
        const now = Date.now();
        const events = await ctx.db
          .query("events")
          .withIndex("by_chapter_date", (q) =>
            q.eq("chapterId", homeChapterId).gte("eventDate", now),
          )
          .take(10);
        upcoming = events.slice(0, 3).map((e) => ({
          name: e.name,
          startsAt: e.eventDate,
          venue: e.location ?? null,
        }));
      }
    }

    return {
      email: session.email,
      name: session.name,
      isBacker: session.isBacker,
      inGrace: session.inGrace,
      pledges,
      lifetimeCents,
      giftCount,
      firstGiftAt,
      history,
      ladder,
      upcoming,
    };
  },
});

/** Touch `lastSeenAt` after a render. Separate from the payload because that
 *  one is a QUERY — a page read must not need a write transaction to succeed,
 *  and this is bookkeeping nobody's access depends on. */
export const markSeen = internalMutation({
  args: { token: v.string() },
  returns: v.null(),
  handler: async (ctx, { token }) => {
    const row = await ctx.db
      .query("backerPortalSessions")
      .withIndex("by_token", (q) => q.eq("tokenHash", hashSessionToken(token)))
      .unique();
    if (row) await touchBackerSession(ctx, row._id);
    return null;
  },
});
