import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Public activity wall (`/give` redesign, wave 2, F6) — a per-territory feed
 * of recurring backers and one-time gifts, each optionally carrying a
 * self-provided public display name + a short public message ("Sam K. —
 * $5,000 toward the Ohio City Launch Fund: 'Let's make this happen.'").
 *
 * Deliberately separate from `donors`/`gifts`/`pledges` (the CRM — full PII,
 * private) and from `givingInterest` (no-payment lead capture): this table is
 * a PUBLIC, opt-in echo of a REAL, SETTLED payment. Every row's spam
 * deterrent is that it can only ever go `"visible"` once a real Stripe
 * checkout actually settles — there is no way to post to the wall without
 * paying.
 *
 * Lifecycle (mirrors the pledge/gift settle pattern in `givingPledges.ts` /
 * `givingDonations.ts`):
 *  1. `givingActivity.recordPendingActivity` (internalMutation, called from
 *     `startGiveDonationCheckout` / `startPledgeCheckout` right after the
 *     Stripe Checkout Session is created, only when the giver opted in via
 *     `shareOnWall`) inserts ONE `"pending"` row keyed by `refKey` — the
 *     Stripe session id for a gift, the pledge id for a backer. A giver who
 *     supplied neither a display name nor a message has nothing to show, so
 *     no row is inserted at all (an all-PII-free "just give quietly" flow
 *     stays silent, not a blank public row).
 *  2. The shared `/stripe/webhook` fan-out flips the row `"visible"` on
 *     settle (`givingActivity.markActivityVisible`, called by the
 *     orchestrator from `http.ts` alongside `recordGiveDonationPaid` /
 *     `recordPledgeInvoice`) — idempotent on `refKey`, and it re-stamps
 *     `amountCents` from the SETTLED Stripe amount, never the amount the
 *     giver typed into the checkout form.
 *  3. `givingActivity.getTerritoryActivity` (public, no auth) reads only
 *     `"visible"` rows for a territory's chapter, newest first, capped —
 *     PII-FREE: `displayName` is a self-provided public name, NEVER the
 *     giver's real name or email.
 *  4. `hideActivity` (central `giving.manage`) is the moderation escape
 *     hatch — no auto-profanity filter yet (tracked as a follow-up), so a
 *     human can pull a row (`"hidden"`) without deleting the underlying gift/
 *     pledge history.
 *
 * `scope` is always a real `chapters` id (never `"central"` — the wall is
 * per-territory, so a central/general gift with no chapter has nowhere to
 * post). Money is integer cents, matching every other giving table.
 */

/** What a wall entry represents: a recurring monthly backer, or a one-time
 *  gift. Mirrors the money-flow split between `pledges` and `gifts`. */
export const ACTIVITY_KINDS = ["backer", "gift"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/**
 * A wall entry's moderation lifecycle:
 *  - `pending` — recorded at checkout-start time, before the payment settles;
 *                NEVER shown publicly.
 *  - `visible` — the payment settled (webhook flip) — shown on the public
 *                wall.
 *  - `hidden`  — a human moderation decision (`hideActivity`) pulled it from
 *                the public wall; the row (and the underlying gift/pledge)
 *                is otherwise untouched.
 */
export const ACTIVITY_STATUSES = ["pending", "visible", "hidden"] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

export const givingActivity = defineTable({
  // The territory's chapter — always a real chapter (a prospect territory's
  // shadow chapter counts too, same convention as `pledges.scope` /
  // `donors.scope`), never the `"central"` sentinel: the wall is per-territory.
  scope: v.id("chapters"),
  kind: v.union(...ACTIVITY_KINDS.map((k) => v.literal(k))),
  // Self-provided PUBLIC name ("Sam K.") — NEVER the giver's real CRM name or
  // email. Optional: a giver may opt into the wall with a message but no name
  // (or vice versa).
  displayName: v.optional(v.string()),
  // The SETTLED amount, in cents. Set to the giver's intended amount at
  // `recordPendingActivity` time, then OVERWRITTEN with the Stripe-settled
  // amount when `markActivityVisible` flips the row — never trust the
  // pre-settle number once the row is public.
  amountCents: v.number(),
  // Optional public message ("Let's make this happen."). Trimmed + capped at
  // insert time (see `givingActivity.ts`'s `MESSAGE_MAX_LEN`).
  message: v.optional(v.string()),
  status: v.union(...ACTIVITY_STATUSES.map((s) => v.literal(s))),
  // The idempotency key linking this row back to its settling event: a
  // one-time gift's Stripe session id (`"give:" + session.id`, mirroring
  // `gifts.externalRef`'s `give:` prefix) or a backer's pledge id
  // (`String(pledgeId)`). Unique by convention (`recordPendingActivity`
  // skips a second insert for the same `refKey`).
  refKey: v.string(),
  createdAt: v.number(),
  // Stamped by `markActivityVisible` on the pending→visible flip. Absent
  // while `pending`.
  settledAt: v.optional(v.number()),
})
  // The public wall's read: a territory's chapter, visible rows only,
  // newest first.
  .index("by_scope_and_status", ["scope", "status"])
  // The webhook flip's idempotent lookup (at most one row per refKey).
  .index("by_refKey", ["refKey"]);
