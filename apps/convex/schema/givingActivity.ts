import { defineTable } from "convex/server";
import { v } from "convex/values";
import { givingScope } from "./givingPlatform";

/**
 * Public activity wall (`/give` redesign, wave 2, F6; widened by
 * give-redesign-v3 C2) — the feed of giving the public `/give` and
 * `/give/<slug>` pages render: recurring backers, one-time gifts to a city,
 * gifts against a fundraiser, and gifts to central operations.
 *
 * Deliberately separate from `donors`/`gifts`/`pledges` (the CRM — full PII,
 * private) and from `givingInterest` (no-payment lead capture): this table is
 * the PUBLIC echo of a REAL, SETTLED payment. Every row's spam deterrent is
 * that it can only ever go `"visible"` once a real Stripe checkout actually
 * settles — there is no way to post to the wall without paying.
 *
 * ── EXISTENCE IS NOT ATTRIBUTION (v3, D6) ───────────────────────────────────
 * The wall used to be OPT-IN: no consent, no row, and a giver who ticked the
 * box but typed neither a name nor a message got no row either. That made the
 * wall a self-selected highlight reel of the handful of people who filled in a
 * text field — a feed that was the page's whole proof and showed almost none of
 * the giving it was proving.
 *
 * v3 splits the two questions that were fused into one flag
 * (docs/plans/give-redesign-v3.md, D6 + "Privacy posture"):
 *  - EXISTENCE is unconditional. Every gift and every new backer that comes
 *    through the `/give` checkout gets a row on settle, whatever they said
 *    about being named. The default rendering is anonymous — "A gift to New
 *    York — $50" — which carries no PII at all. (UNCONDITIONAL ON CONSENT, not
 *    on the rail: money that arrives another way — desk-entered cash/check/
 *    wire, an event-page donation, a canonical import — is written by
 *    `lib/givingDonors.ts#recordGiftForDonor` and gets no row here. The wall is
 *    the checkout feed; `/finances` is the complete record, and the wall's copy
 *    says so. See `lib/givePageSections.ts#givingWallHtml`.)
 *  - ATTRIBUTION (`displayName` + `message`) is what `consent` gates, and it
 *    gates it on the READ path, every time, for ever.
 * So `consent === false` now means "count me, don't name me", not "pretend I
 * never gave". Nothing about an anonymous row identifies anyone: an amount and
 * a coarse timestamp against a city is not a person.
 *
 * Lifecycle (mirrors the pledge/gift settle pattern in `givingPledges.ts` /
 * `givingDonations.ts`):
 *  1. `givingActivity.recordPendingActivity` (internalMutation, called from
 *     `startGiveDonationCheckout` / `startPledgeCheckout` right after the
 *     Stripe Checkout Session is created — now for EVERY gift and pledge, not
 *     only opt-ins) inserts ONE `"pending"` row keyed by `refKey` — the Stripe
 *     session id for a gift, the pledge id for a backer.
 *  2. The shared `/stripe/webhook` fan-out flips the row `"visible"` on
 *     settle (`givingActivity.markActivityVisible`, called by the
 *     orchestrator from `http.ts` alongside `recordGiveDonationPaid` /
 *     `recordPledgeInvoice`) — idempotent on `refKey`, and it re-stamps
 *     `amountCents` from the SETTLED Stripe amount, never the amount the
 *     giver typed into the checkout form.
 *  3. `givingActivity.getPublicWall` (public, no auth) is the v3 read: the
 *     org-wide or per-city feed plus the live totals. `getTerritoryActivity`
 *     is its predecessor, still serving the un-swapped city-page renderer.
 *     Both are PII-FREE: `displayName` is a self-provided public name, NEVER
 *     the giver's real name or email, and it is only ever returned for a row
 *     that consented to be named.
 *  4. `hideActivity` (central `giving.manage`) is the moderation escape
 *     hatch — no auto-profanity filter yet (tracked as a follow-up), so a
 *     human can pull a row (`"hidden"`) without deleting the underlying gift/
 *     pledge history. `restoreActivity` (same gate) is its undo, so a staff
 *     member handling a donor's "please take me down" email can act in
 *     seconds without fearing an irreversible click.
 *
 * Money is integer cents, matching every other giving table.
 */

/**
 * What a wall entry represents. The first two are the original money-flow split
 * between `pledges` and `gifts`; the last two were added by give-redesign-v3
 * C2 so the wall can say what a row IS rather than flattening everything into
 * "gift":
 *  - `backer`     — a new recurring monthly pledge.
 *  - `gift`       — a one-time gift to a city.
 *  - `fundraiser` — a one-time gift against an event that carries a money goal
 *                   (D9: past fundraisers stay giveable, same pot). The row
 *                   carries `eventId` so the read can render the goal card.
 *  - `central`    — a one-time gift to central operations (D7). Before v3 these
 *                   were dropped on the floor — the wall was per-territory, so
 *                   a `"central"` gift had nowhere to post and the checkout
 *                   simply skipped the wall write. That made the most
 *                   unglamorous giving the org receives invisible on the page
 *                   whose whole job is to show that people give.
 * Never renumber or repurpose — these literals are persisted on every row.
 */
export const ACTIVITY_KINDS = [
  "backer",
  "gift",
  "fundraiser",
  "central",
] as const;
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

/**
 * WHY a row is `"hidden"`. Both reasons land on the same status, but only one
 * of them is safe to undo:
 *  - `staff` — a person pulled it (`hideActivity`), usually because the donor
 *    asked. The payment behind it is still real, so putting it back is just
 *    reversing a human decision. ONLY this reason is restorable.
 *  - `payment_reversed` — the money went away (`withdrawActivity`, an ACH
 *    debit that failed or was returned). The wall's whole spam deterrent is
 *    that an entry means a real settled payment; restoring one of these would
 *    republish a gift that no longer exists, so `restoreActivity` refuses.
 *
 * ABSENT means "hidden before this field existed" and is treated as NOT
 * restorable — the same conservative posture `consent` takes. A staff member
 * can always hide such a row again (that's idempotent); what they can't do is
 * put something back on the public wall when we can't say why it came down.
 */
export const ACTIVITY_HIDDEN_REASONS = ["staff", "payment_reversed"] as const;
export type ActivityHiddenReason = (typeof ACTIVITY_HIDDEN_REASONS)[number];

export const givingActivity = defineTable({
  // WHERE this giving landed: a real chapter (a prospect territory's shadow
  // chapter counts too, same convention as `pledges.scope` / `donors.scope`),
  // or the `"central"` sentinel.
  //
  // WIDENED FROM `v.id("chapters")` BY v3 C2 (D7). The old narrow type WAS the
  // reason central gifts never reached the wall — the type made it impossible,
  // so the checkout had to guard on `scope !== "central"` and drop the write.
  // Imported from `schema/givingPlatform.ts` rather than re-declared so this
  // and `gifts.scope` can never drift apart; a row's scope is now exactly the
  // scope of the money behind it.
  scope: givingScope,
  kind: v.union(...ACTIVITY_KINDS.map((k) => v.literal(k))),
  // Self-provided PUBLIC name ("Sam K.") — NEVER the giver's real CRM name or
  // email. Optional: most rows have none (a giver who didn't ask to be named,
  // or a row the migration backfilled from history), and a giver may supply a
  // message but no name. RETURNED ONLY under the consent rules below.
  displayName: v.optional(v.string()),
  // The SETTLED amount, in cents. Set to the giver's intended amount at
  // `recordPendingActivity` time, then OVERWRITTEN with the Stripe-settled
  // amount when `markActivityVisible` flips the row — never trust the
  // pre-settle number once the row is public.
  amountCents: v.number(),
  // Optional public message ("Let's make this happen."). Trimmed + capped at
  // insert time (see `givingActivity.ts`'s `MESSAGE_MAX_LEN`). Same consent
  // gate as `displayName` — a message is attribution too.
  message: v.optional(v.string()),
  status: v.union(...ACTIVITY_STATUSES.map((s) => v.literal(s))),
  // The idempotency key linking this row back to its settling event: a
  // one-time gift's Stripe session id (`"give:" + session.id`, mirroring
  // `gifts.externalRef`'s `give:` prefix), a backer's pledge id
  // (`String(pledgeId)`), or `"gift:" + giftId` for a row the historical
  // backfill wrote (migration 0074). Unique by convention
  // (`recordPendingActivity` skips a second insert for the same `refKey`, and
  // the backfill checks it before inserting) — and NEVER returned publicly:
  // it identifies a payment.
  refKey: v.string(),
  createdAt: v.number(),
  // Stamped by `markActivityVisible` on the pending→visible flip (and by the
  // 0074 backfill, from the historical gift's `receivedAt`). Absent while
  // `pending`. This — not `_creationTime` — is what the feed orders by: the
  // backfill wrote decade-old giving at deploy time, so creation order is not
  // settle order. See `by_status_and_settledAt`.
  settledAt: v.optional(v.number()),
  // EXPLICIT, RECORDED CONSENT TO BE NAMED on the public wall — the giver
  // ticked "Show my name and gift amount on our public giving wall" in the
  // give form.
  //
  // SINCE v3 (D6) THIS GATES ATTRIBUTION, NOT EXISTENCE. The row exists
  // either way; `consent !== true` means `displayName` and `message` are never
  // returned by any public read, so the row renders as "A gift to New York —
  // $50". It is stored on the row so every read path re-checks it rather than
  // inferring consent from the mere existence of a row.
  //
  // ABSENT IS TREATED AS NO everywhere it is read. That "absent means no" rule
  // IS the retroactive opt-out: rather than a one-time sweep that could miss a
  // row created between the sweep and the deploy, every pre-consent row is
  // permanently ineligible for attribution. The owner's instruction was
  // "assume no for everybody before now"; this encodes it in the read path so
  // it cannot be undone by a later backfill — including 0074's, which writes
  // no consent at all.
  consent: v.optional(v.boolean()),
  // WHETHER THAT CONSENT WAS GIVEN FOR AN INDEXED PAGE (v3, "Privacy posture"
  // + D10).
  //
  // `/give/<slug>` carried `noindex` because agreeing to be SHOWN on a page is
  // not agreeing to be FINDABLE BY NAME beside what you gave, for ever. D6
  // makes the default row anonymous, which removes that objection for almost
  // every row and lets D10 drop `noindex` — but it does NOT retroactively
  // license indexing the names of people who consented under the old, quieter
  // promise. Their consent was real; it was just consent to something smaller.
  //
  // So the new consent copy says plainly that the page is public AND can be
  // found by search, and consent captured under THAT copy is stamped `true`
  // here. On an indexed page, attribution renders only for
  // `consentIndexable === true`. Pre-existing consents keep their old promise:
  // they still appear, still count, and stay anonymous.
  //
  // ABSENT IS A NO, for the same reason `consent`'s is — and absent is exactly
  // what every pre-v3 row and every backfilled row carries.
  consentIndexable: v.optional(v.boolean()),
  // The fundraiser this gift was given against — set only on a `"fundraiser"`
  // row, and the ONLY way the read can render C1's `goal` card (label, raised,
  // target), which lives on the event's `eventPages` row and cannot be
  // recovered from a scope + an amount. Absent on every other kind.
  eventId: v.optional(v.id("events")),
  // Why this row is `"hidden"` — see `ACTIVITY_HIDDEN_REASONS`. Written by
  // whichever path hid it; meaningless (and absent) on a `pending`/`visible`
  // row. Optional in the validator because rows hidden before this field
  // existed carry no reason, and an absent reason is NOT restorable.
  hiddenReason: v.optional(
    v.union(...ACTIVITY_HIDDEN_REASONS.map((r) => v.literal(r))),
  ),
  // WHO took this entry down, and WHEN. Stamped by `hideActivity` only —
  // `withdrawActivity` is the system reacting to a reversed payment, and
  // attributing that to a person would be a lie, so it leaves both absent and
  // the read renders "System".
  //
  // This is deliberately two fields on the row rather than a new audit table.
  // Every audit trail in this codebase is hard-typed to one entity
  // (`giftAudit.giftId`, `donorAudit.donorId`, `pledgeEvents.pledgeId`,
  // `personAudit.personId`), and `financeAuditLog`'s `subjectType` is a closed
  // finance-only union — none of them can carry a `givingActivity` id, and
  // there is no generic writer to reuse. An action that changes what the
  // PUBLIC sees still needs to say who did it, so the row records it itself:
  // no new table, no new charter, nothing to keep in sync.
  //
  // Absent on every row hidden before these fields existed, and absent while a
  // row is `pending`/`visible`. Cleared by `restoreActivity`, because a row
  // that is back up was not taken down by anyone.
  hiddenBy: v.optional(v.id("users")),
  hiddenAt: v.optional(v.number()),
})
  // One city's wall: a chapter scope, visible rows only. Also the moderation
  // read's per-scope cut.
  .index("by_scope_and_status", ["scope", "status"])
  // The ORG-WIDE feed (v3 C1's no-slug call): every visible row across every
  // chapter AND central, newest SETTLE first. `by_scope_and_status` cannot
  // serve it — it would mean fanning out per chapter and merging by hand — and
  // ordering on `settledAt` rather than on the index's implicit
  // `_creationTime` matters because migration 0074 wrote historical rows at
  // deploy time: by creation order a gift from last year outranks one from
  // this morning.
  .index("by_status_and_settledAt", ["status", "settledAt"])
  // The webhook flip's idempotent lookup (at most one row per refKey).
  .index("by_refKey", ["refKey"]);
