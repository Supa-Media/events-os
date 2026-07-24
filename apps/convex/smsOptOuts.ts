/**
 * SMS opt-out ledger — read/write surface for `schema/smsOptOuts.ts`. Written
 * by the Twilio inbound webhook (`http.ts`'s `/twilio/webhook`, on a
 * STOP/START-family keyword) and read by `blasts.ts` to filter a blast
 * audience both when the composer previews it and again right before send.
 */
import { internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";

/** Bounded scan cap for the opt-out set — an audit/filter surface, not a
 *  paginated ledger (same spirit as `aiCodingData.ts`'s `USAGE_SCAN_LIMIT`).
 *  20k opted-out numbers deployment-wide is generously above anything this
 *  org's SMS volume will produce. */
const OPT_OUT_SCAN_LIMIT = 20_000;

/**
 * The full opted-out phone set (normalized E.164). For a `query`/
 * `internalQuery` handler (which already has a `QueryCtx`) call this
 * directly; an `action` has no `ctx.db` and goes through the
 * `listOptedOutPhones` internalQuery below via `ctx.runQuery`.
 */
export async function optedOutPhoneSet(ctx: QueryCtx): Promise<Set<string>> {
  const rows = await ctx.db.query("smsOptOuts").take(OPT_OUT_SCAN_LIMIT);
  return new Set(rows.map((r) => r.phone));
}

/** Action-callable wrapper around `optedOutPhoneSet` — used by
 *  `blasts.ts#deliverSmsBlast` to recheck opt-outs right before sending,
 *  catching a STOP that arrived after the blast was scheduled. */
export const listOptedOutPhones = internalQuery({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    return [...(await optedOutPhoneSet(ctx))];
  },
});

async function findByPhone(ctx: QueryCtx, phone: string) {
  return ctx.db
    .query("smsOptOuts")
    .withIndex("by_phone", (q) => q.eq("phone", phone))
    .unique();
}

/** Upsert an opt-out row for a normalized `phone` (STOP/STOPALL/UNSUBSCRIBE/
 *  CANCEL/END/QUIT). Idempotent — a repeat STOP just no-ops if a row already
 *  exists, so the original `createdAt` is preserved. */
export const recordOptOut = internalMutation({
  args: {
    phone: v.string(),
    source: v.union(v.literal("stop_webhook"), v.literal("manual")),
    note: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { phone, source, note }) => {
    const existing = await findByPhone(ctx, phone);
    if (existing) return null;
    await ctx.db.insert("smsOptOuts", {
      phone,
      source,
      note,
      createdAt: Date.now(),
    });
    return null;
  },
});

/** Clear an opt-out row for a normalized `phone` (START/UNSTOP/YES —
 *  re-subscribe). A no-op if the number wasn't opted out. */
export const clearOptOut = internalMutation({
  args: { phone: v.string() },
  returns: v.null(),
  handler: async (ctx, { phone }) => {
    const existing = await findByPhone(ctx, phone);
    if (existing) await ctx.db.delete(existing._id);
    return null;
  },
});
