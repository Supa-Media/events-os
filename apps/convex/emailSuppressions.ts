/**
 * Email suppression ledger — read/write surface for `schema/campaigns.ts`'s
 * `emailSuppressions` table, the email-channel analog of `smsOptOuts.ts`.
 * Deployment-wide (NOT chapter/campaign-scoped — an unsubscribe or bounce
 * suppresses an address everywhere, the `smsOptOuts` precedent).
 *
 * Written by:
 *  - `http.ts`'s `/unsubscribe/<token>` route (reason "unsubscribe").
 *  - `http.ts`'s `/resend/webhook` route on `email.bounced`/`email.complained`
 *    (reason "bounce"/"complaint").
 *
 * Read by:
 *  - `audiences.ts`'s resolvers (guests/donors/people all drop suppressed
 *    addresses before returning a preview/send list).
 *  - `campaigns.ts#deliverCampaignBatch` (rechecked right before each send —
 *    the `smsOptOuts` "recheck at delivery time" precedent, catching an
 *    unsubscribe that lands in the gap between materialize and send).
 *  - `blasts.ts`'s email audience (a campaign unsubscribe also silences event
 *    blasts to that address).
 */
import { internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { normalizeEmail } from "./lib/access";
import { EMAIL_SUPPRESSION_REASONS } from "./schema/campaigns";

/** Bounded scan cap — an audit/filter surface, not a paginated ledger (the
 *  `smsOptOuts.OPT_OUT_SCAN_LIMIT` precedent). Comfortably above any
 *  realistic deployment's suppression volume. */
const SUPPRESSION_SCAN_LIMIT = 50_000;

/** The full suppressed-email set (normalized lowercase). For a `query`/
 *  `internalQuery` handler (already holding a `QueryCtx`) call this directly;
 *  an `action` goes through `listSuppressedEmails` via `ctx.runQuery`. */
export async function suppressedEmailSet(ctx: QueryCtx): Promise<Set<string>> {
  const rows = await ctx.db.query("emailSuppressions").take(SUPPRESSION_SCAN_LIMIT);
  return new Set(rows.map((r) => r.email));
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
