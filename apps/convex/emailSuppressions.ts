/**
 * Email suppression ledger — read/write surface for `schema/campaigns.ts`'s
 * `emailSuppressions` table, the email-channel analog of `smsOptOuts.ts`.
 * Deployment-wide (NOT chapter/campaign-scoped — an unsubscribe or bounce
 * suppresses an address everywhere, the `smsOptOuts` precedent).
 *
 * Written by:
 *  - `http.ts`'s `/unsubscribe/<token>` route (reason "unsubscribe") — for a
 *    campaign recipient OR an event-blast recipient.
 *  - `http.ts`'s `/resend/webhook` route on a PERMANENT `email.bounced` or an
 *    `email.complained` (reason "bounce"/"complaint"). A transient/soft bounce
 *    deliberately writes nothing — see that route's `classifyBounce`.
 *  - `suppressEmail` / `unsuppressEmail` below (reason "manual") — the ADMIN
 *    surface, gated and audited.
 *
 * Read by:
 *  - `audiences.ts`'s resolvers (guests/donors/people all drop suppressed
 *    addresses before returning a preview/send list).
 *  - `campaigns.ts#deliverCampaignBatch` (rechecked right before each send —
 *    the `smsOptOuts` "recheck at delivery time" precedent, catching an
 *    unsubscribe that lands in the gap between materialize and send).
 *  - `blasts.ts`'s email audience (a campaign unsubscribe also silences event
 *    blasts to that address).
 *
 * ── Suppression is not a one-way door ──────────────────────────────────────
 * A bounce can be wrong: a full mailbox, a misconfigured corporate gateway, a
 * temporary DNS failure — and before `unsuppressEmail` existed, any of those
 * killed a good address permanently and INVISIBLY (there is no screen that
 * lists this table, and nothing ever deleted a row). `smsOptOuts.clearOptOut`
 * has had the equivalent since day one. Both admin mutations write an
 * `emailSuppressionAudit` row so "who put this address back into circulation,
 * and why" is answerable afterwards.
 */
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { normalizeEmail } from "./lib/access";
import { requireUserId } from "./lib/context";
import { requireCampaignsAccess } from "./lib/campaignsAccess";
import { EMAIL_SUPPRESSION_REASONS } from "./schema/campaigns";
import type { Id } from "./_generated/dataModel";

/** Bounded scan cap — an audit/filter surface, not a paginated ledger (the
 *  `smsOptOuts.OPT_OUT_SCAN_LIMIT` precedent). Comfortably above any
 *  realistic deployment's suppression volume. Exported so the observability
 *  surfaces below can report what the ceiling actually is rather than
 *  hardcoding the number twice. */
export const SUPPRESSION_SCAN_LIMIT = 50_000;

/**
 * The suppressed-email set (normalized lowercase) AND whether the scan hit its
 * ceiling.
 *
 * ── Why `truncated` exists ─────────────────────────────────────────────────
 * Past `SUPPRESSION_SCAN_LIMIT` rows the scan silently stops, and every
 * address beyond the cut becomes MAILABLE again — a suppression list that
 * quietly stops suppressing is the worst possible failure mode for this table
 * (it re-mails people who opted out, and re-mails addresses that hard-bounced,
 * both of which burn sending reputation). Raising the number alone just moves
 * the cliff, so the truncation is made loud instead: a `console.error` on
 * every read that trips it, and a `truncated` flag on
 * `getSuppressionSummary` for a human-facing surface.
 */
export async function readSuppressionScan(
  ctx: QueryCtx,
  limit: number = SUPPRESSION_SCAN_LIMIT,
): Promise<{ emails: Set<string>; truncated: boolean }> {
  const rows = await ctx.db.query("emailSuppressions").take(limit);
  const truncated = rows.length >= limit;
  if (truncated) {
    console.error(
      `[emailSuppressions] SCAN TRUNCATED at ${limit} rows — addresses beyond the cap are NOT being suppressed and may be mailed. Move this table to a paginated/indexed read before sending again.`,
    );
  }
  return { emails: new Set(rows.map((r) => r.email)), truncated };
}

/** The full suppressed-email set (normalized lowercase). For a `query`/
 *  `internalQuery` handler (already holding a `QueryCtx`) call this directly;
 *  an `action` goes through `listSuppressedEmails` via `ctx.runQuery`.
 *  Truncation is logged by `readSuppressionScan`. */
export async function suppressedEmailSet(ctx: QueryCtx): Promise<Set<string>> {
  return (await readSuppressionScan(ctx)).emails;
}

/** Action-callable wrapper around `suppressedEmailSet`. */
export const listSuppressedEmails = internalQuery({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => [...(await suppressedEmailSet(ctx))],
});

async function findByEmail(ctx: QueryCtx, email: string) {
  return ctx.db
    .query("emailSuppressions")
    .withIndex("by_email", (q) => q.eq("email", email))
    .first();
}

/** True iff `email` (normalized) is currently suppressed. */
export const isEmailSuppressed = internalQuery({
  args: { email: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { email }) => {
    const normalized = normalizeEmail(email);
    if (!normalized) return false;
    return !!(await findByEmail(ctx, normalized));
  },
});

/** Record a suppression. Idempotent by address — a repeat bounce/unsubscribe
 *  for an already-suppressed address just no-ops, preserving the original
 *  `createdAt`/`reason` (mirrors `smsOptOuts.recordOptOut`). */
export const recordSuppression = internalMutation({
  args: {
    email: v.string(),
    reason: v.union(...EMAIL_SUPPRESSION_REASONS.map((r) => v.literal(r))),
    campaignId: v.optional(v.id("campaigns")),
    note: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { email, reason, campaignId, note }) => {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    const existing = await findByEmail(ctx, normalized);
    if (existing) return null;
    await ctx.db.insert("emailSuppressions", {
      email: normalized,
      reason,
      campaignId,
      note,
      createdAt: Date.now(),
    });
    return null;
  },
});

// ── Admin surface ───────────────────────────────────────────────────────────
// Gated by `requireCampaignsAccess` — the named resolver that already owns
// "who may operate the email desk" (`lib/campaignsAccess.ts`). Suppression
// management deliberately does NOT check seats inline here: if it ever needs
// to be narrower than desk access (e.g. only an approver may resurrect a
// hard-bounced address), that becomes a new `campaigns.suppressions` power on
// the seat chart and a change to ONE resolver, with no call-site churn.

/** Normalize + reject a blank/malformed address at the gate, so an admin
 *  typo can't create an un-findable ledger row. */
function requireNormalizedEmail(raw: string): string {
  const normalized = normalizeEmail(raw);
  if (!normalized || !normalized.includes("@")) {
    throw new ConvexError({
      code: "INVALID_EMAIL",
      message: "Enter a valid email address.",
    });
  }
  return normalized;
}

/** Append the "a human did this" breadcrumb. See
 *  `schema/campaigns.ts#emailSuppressionAudit` for why automated writes
 *  (unsubscribe clicks, bounces, complaints) deliberately don't land here. */
async function logSuppressionChange(
  ctx: MutationCtx,
  args: {
    email: string;
    action: "suppressed" | "unsuppressed";
    reason?: (typeof EMAIL_SUPPRESSION_REASONS)[number];
    note?: string;
  },
): Promise<void> {
  const actorUserId = (await requireUserId(ctx)) as Id<"users">;
  await ctx.db.insert("emailSuppressionAudit", {
    email: args.email,
    action: args.action,
    reason: args.reason,
    actorUserId,
    note: args.note,
    at: Date.now(),
  });
}

/**
 * Suppress an address by hand — the writer that makes the `"manual"` reason
 * on `EMAIL_SUPPRESSION_REASONS` real. Until now the enum declared a value
 * nothing could ever produce: a person who asks to be taken off the list by
 * replying, phoning, or telling someone in person had no way onto it short of
 * a database edit.
 *
 * Idempotent: an address that's already suppressed (for any reason) keeps its
 * original row — the earlier reason is the truer one — and still logs the
 * attempt, so "we thought we'd suppressed this" is answerable.
 */
export const suppressEmail = mutation({
  args: { email: v.string(), note: v.optional(v.string()) },
  returns: v.object({ email: v.string(), alreadySuppressed: v.boolean() }),
  handler: async (ctx, { email, note }) => {
    await requireCampaignsAccess(ctx);
    const normalized = requireNormalizedEmail(email);
    const trimmedNote = note?.trim() || undefined;
    const existing = await findByEmail(ctx, normalized);
    if (!existing) {
      await ctx.db.insert("emailSuppressions", {
        email: normalized,
        reason: "manual",
        note: trimmedNote,
        createdAt: Date.now(),
      });
    }
    await logSuppressionChange(ctx, {
      email: normalized,
      action: "suppressed",
      reason: existing?.reason ?? "manual",
      note: trimmedNote,
    });
    return { email: normalized, alreadySuppressed: !!existing };
  },
});

/**
 * Un-suppress an address — the door back out (`smsOptOuts.clearOptOut`'s
 * counterpart). Deleting the row is what actually re-enables delivery: every
 * reader of this table (audience resolution, `deliverCampaignBatch`'s
 * pre-send recheck, the blast audience) asks "is there a row?", so once it's
 * gone the address is mailable again immediately.
 *
 * The audit row is written BEFORE the delete so the reason being cleared is
 * captured — an un-suppressed complaint is a materially riskier decision than
 * an un-suppressed soft bounce, and after the delete there'd be nothing left
 * to say which it was. A no-op on an address that isn't suppressed (no row,
 * no audit entry).
 */
export const unsuppressEmail = mutation({
  args: { email: v.string(), note: v.optional(v.string()) },
  returns: v.object({ email: v.string(), wasSuppressed: v.boolean() }),
  handler: async (ctx, { email, note }) => {
    await requireCampaignsAccess(ctx);
    const normalized = requireNormalizedEmail(email);
    const existing = await findByEmail(ctx, normalized);
    if (!existing) return { email: normalized, wasSuppressed: false };
    await logSuppressionChange(ctx, {
      email: normalized,
      action: "unsuppressed",
      reason: existing.reason,
      note: note?.trim() || undefined,
    });
    await ctx.db.delete(existing._id);
    return { email: normalized, wasSuppressed: true };
  },
});

/** How many recent suppressions a summary read returns — a "what's happened
 *  lately" strip, not the whole ledger. */
const RECENT_SUPPRESSIONS_LIMIT = 50;

/**
 * The suppression ledger's health + its most recent entries — the surface
 * that makes `SUPPRESSION_SCAN_LIMIT` observable instead of a silent cliff
 * (`truncated: true` means addresses beyond the cap are no longer being
 * suppressed and mail is going to them). `scanLimit` exists so a caller (and
 * a test) can probe the truncation behaviour without materializing 50,000
 * rows; it is CAPPED at the real limit, so it can only ever make the scan
 * smaller, never bigger.
 */
export const getSuppressionSummary = query({
  args: { scanLimit: v.optional(v.number()) },
  returns: v.object({
    count: v.number(),
    limit: v.number(),
    truncated: v.boolean(),
    recent: v.array(
      v.object({
        email: v.string(),
        reason: v.union(...EMAIL_SUPPRESSION_REASONS.map((r) => v.literal(r))),
        note: v.union(v.string(), v.null()),
        createdAt: v.number(),
      }),
    ),
  }),
  handler: async (ctx, { scanLimit }) => {
    await requireCampaignsAccess(ctx);
    const limit = Math.max(
      1,
      Math.min(scanLimit ?? SUPPRESSION_SCAN_LIMIT, SUPPRESSION_SCAN_LIMIT),
    );
    const { emails, truncated } = await readSuppressionScan(ctx, limit);
    const recent = await ctx.db
      .query("emailSuppressions")
      .order("desc")
      .take(RECENT_SUPPRESSIONS_LIMIT);
    return {
      count: emails.size,
      limit,
      truncated,
      recent: recent.map((r) => ({
        email: r.email,
        reason: r.reason,
        note: r.note ?? null,
        createdAt: r.createdAt,
      })),
    };
  },
});
