/**
 * Public activity wall (`/give` redesign, wave 2, F6) — see
 * `schema/givingActivity.ts` for the table's full design doc + lifecycle.
 * Four surfaces:
 *  - `recordPendingActivity` (internalMutation) — called by
 *    `givingDonations.startGiveDonationCheckout` /
 *    `givingPledges.startPledgeCheckout` right after the Stripe Checkout
 *    Session is created, only when the giver opted in (`shareOnWall`).
 *  - `markActivityVisible` (internalMutation) — called by the orchestrator's
 *    `/stripe/webhook` fan-out (`http.ts`) on settle, alongside
 *    `recordGiveDonationPaid` / `recordPledgeInvoice`.
 *  - `getTerritoryActivity` (PUBLIC query, no auth) — the wall itself, PII-free.
 *  - `listActivityAdmin` / `hideActivity` (central `giving.view`/`giving.manage`)
 *    — OS moderation.
 */
import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { ACTIVITY_KINDS, ACTIVITY_STATUSES } from "./schema/givingActivity";
import { requireGivingManage, requireGivingView } from "./lib/givingAccess";

const activityKindValidator = v.union(
  ...ACTIVITY_KINDS.map((k) => v.literal(k)),
);
const activityStatusValidator = v.union(
  ...ACTIVITY_STATUSES.map((s) => v.literal(s)),
);

/** A public display name is a short handle ("Sam K."), not a full legal
 *  name — capped well short of the message. */
const DISPLAY_NAME_MAX_LEN = 60;
/** A generous cap on the public message — a sentence or two, not an essay
 *  (mirrors the "Let's make this happen." example in the spec). */
const MESSAGE_MAX_LEN = 280;

/** The wall shows a handful of recent entries, not a full history. */
const TERRITORY_ACTIVITY_LIMIT = 20;

/** A generous bound on the moderation list — nowhere near this in the
 *  current launch phase (mirrors `givingInterest.ts`'s `INTEREST_LIST_LIMIT`). */
const ACTIVITY_ADMIN_LIST_LIMIT = 500;

/** `undefined` for a blank/whitespace-only string, else the trimmed value,
 *  capped to `maxLen` (mirrors `givingInterest.ts`'s `trimmedOrUndefined`). */
function trimmedCapped(
  s: string | undefined,
  maxLen: number,
): string | undefined {
  const t = s?.trim();
  return t ? t.slice(0, maxLen) : undefined;
}

// ── Capture (internal — called from the checkout-start actions) ─────────────

/**
 * Record a `"pending"` wall entry right after a Stripe Checkout Session is
 * created (called from `givingDonations.startGiveDonationCheckout` /
 * `givingPledges.startPledgeCheckout`, ONLY when the giver opted into
 * `shareOnWall`). NEVER shown publicly until `markActivityVisible` flips it
 * on settle — so an abandoned checkout never reaches the wall.
 *
 * SKIPS entirely (inserts nothing) if neither a display name nor a message
 * is present after trimming — a giver who opted in but left both blank has
 * nothing to show, so there's no reason to carry a silent row.
 *
 * Idempotent on `refKey`: a redelivered/duplicate call (the checkout-start
 * action retried, or a defensive re-call) finds the existing row and no-ops
 * rather than inserting a second one.
 */
export const recordPendingActivity = internalMutation({
  args: {
    refKey: v.string(),
    scope: v.id("chapters"),
    kind: activityKindValidator,
    amountCents: v.number(),
    displayName: v.optional(v.string()),
    message: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const displayName = trimmedCapped(args.displayName, DISPLAY_NAME_MAX_LEN);
    const message = trimmedCapped(args.message, MESSAGE_MAX_LEN);
    if (!displayName && !message) return null; // nothing to show — skip

    const existing = await ctx.db
      .query("givingActivity")
      .withIndex("by_refKey", (q) => q.eq("refKey", args.refKey))
      .unique();
    if (existing) return null; // idempotent — already recorded for this refKey

    await ctx.db.insert("givingActivity", {
      scope: args.scope,
      kind: args.kind,
      ...(displayName ? { displayName } : {}),
      amountCents: args.amountCents,
      ...(message ? { message } : {}),
      status: "pending",
      refKey: args.refKey,
      createdAt: Date.now(),
    });
    return null;
  },
});

// ── Settle (internal — called from the /stripe/webhook fan-out) ─────────────

/**
 * Flip a `"pending"` wall entry to `"visible"` on settle and stamp
 * `settledAt`. `amountCents` is OPTIONAL: pass it for a ONE-TIME gift (the
 * settled Stripe `amount_total` is the truth, never the pre-settle intended
 * amount); OMIT it for a BACKER, whose displayed figure is the recurring
 * monthly pledge amount already stored at pending time (a `mode=subscription`
 * checkout session's `amount_total` is $0/prorated, so there's nothing truer to
 * re-stamp). Resolved by `refKey` (the session id for a gift, the pledge id for
 * a backer) — a `refKey` with no
 * matching row (the giver didn't opt into the wall, so `recordPendingActivity`
 * skipped it) is a safe no-op, mirroring the settle handlers' "safe fan-out"
 * pattern elsewhere in the giving stack.
 *
 * Idempotent: only a row still `"pending"` is flipped — a redelivered webhook
 * finds the row already `"visible"` and no-ops, so a duplicate delivery can
 * never re-stamp `settledAt` or re-apply the amount a second time.
 */
export const markActivityVisible = internalMutation({
  args: {
    refKey: v.string(),
    amountCents: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("givingActivity")
      .withIndex("by_refKey", (q) => q.eq("refKey", args.refKey))
      .unique();
    if (!row) return null; // no wall entry for this refKey — safe no-op
    if (row.status !== "pending") return null; // already settled/hidden — idempotent no-op

    await ctx.db.patch(row._id, {
      status: "visible",
      // Overwrite with the settled amount for a gift; keep the stored monthly
      // amount for a backer (amountCents omitted).
      ...(args.amountCents !== undefined ? { amountCents: args.amountCents } : {}),
      settledAt: Date.now(),
    });
    return null;
  },
});

// ── Public (no auth — PII-free) ──────────────────────────────────────────────

const territoryActivityRowValidator = v.object({
  kind: activityKindValidator,
  displayName: v.union(v.string(), v.null()),
  amountCents: v.number(),
  message: v.union(v.string(), v.null()),
  at: v.number(),
});

/**
 * The public activity wall for one territory (by slug): up to
 * `TERRITORY_ACTIVITY_LIMIT` newest `"visible"` entries, PII-free —
 * `displayName` is the giver's self-provided public handle, NEVER a CRM name
 * or email. Resolves slug → chapter the same way `resolveTerritoryForCheckout`
 * does (a hidden/unknown slug renders an empty wall, not an error — a public
 * page should never leak whether a slug exists).
 */
export const getTerritoryActivity = query({
  args: { slug: v.string() },
  returns: v.array(territoryActivityRowValidator),
  handler: async (ctx, { slug }) => {
    const territory = await ctx.db
      .query("territories")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (!territory || !territory.publiclyVisible) return [];

    const rows = await ctx.db
      .query("givingActivity")
      .withIndex("by_scope_and_status", (q) =>
        q.eq("scope", territory.chapterId).eq("status", "visible"),
      )
      .order("desc")
      .take(TERRITORY_ACTIVITY_LIMIT);

    return rows.map((r) => ({
      kind: r.kind,
      displayName: r.displayName ?? null,
      amountCents: r.amountCents,
      message: r.message ?? null,
      at: r.settledAt ?? r.createdAt,
    }));
  },
});

// ── Admin (central `giving.view`/`giving.manage`) ────────────────────────────

const activityAdminRowValidator = v.object({
  _id: v.id("givingActivity"),
  scope: v.id("chapters"),
  kind: activityKindValidator,
  displayName: v.union(v.string(), v.null()),
  amountCents: v.number(),
  message: v.union(v.string(), v.null()),
  status: activityStatusValidator,
  refKey: v.string(),
  createdAt: v.number(),
  settledAt: v.union(v.number(), v.null()),
});

/** Every wall entry (any status), newest first — the OS moderation list.
 *  Central `giving.view`: the wall spans every territory, like the territory
 *  map and interest inbox. */
export const listActivityAdmin = query({
  args: {},
  returns: v.array(activityAdminRowValidator),
  handler: async (ctx) => {
    await requireGivingView(ctx, "central");
    const rows = await ctx.db
      .query("givingActivity")
      .order("desc")
      .take(ACTIVITY_ADMIN_LIST_LIMIT);
    return rows.map((r) => ({
      _id: r._id,
      scope: r.scope,
      kind: r.kind,
      displayName: r.displayName ?? null,
      amountCents: r.amountCents,
      message: r.message ?? null,
      status: r.status,
      refKey: r.refKey,
      createdAt: r.createdAt,
      settledAt: r.settledAt ?? null,
    }));
  },
});

/** Moderate a wall entry off the public wall (central `giving.manage`) — sets
 *  `status: "hidden"`. Does NOT touch the underlying gift/pledge history,
 *  only its public echo. Idempotent: hiding an already-hidden row is a no-op. */
export const hideActivity = mutation({
  args: { id: v.id("givingActivity") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    await requireGivingManage(ctx, "central");
    const row = await ctx.db.get(id);
    if (!row) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Activity entry not found.",
      });
    }
    if (row.status !== "hidden") {
      await ctx.db.patch(id, { status: "hidden" });
    }
    return null;
  },
});
