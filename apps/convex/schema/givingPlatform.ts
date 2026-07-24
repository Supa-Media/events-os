import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Giving Platform (F-6, Phase 1) — the development team's donor CRM.
 *
 * The event `donations` table (schema/ticketing.ts) is per-EVENT giving, shipped
 * with M5.1. This domain is the standing, chapter-and-central-aware DONOR
 * database the giving PRD (docs/plans/giving-platform.md §1) replaces Givebutter
 * + Monday.com with: a `donors` record per person/org that has ever given, and a
 * `gifts` history row per dollar-amount received from any source.
 *
 * Design invariants (mirroring the finance layer + `giving.ts`'s house pattern):
 *  - Money is ALWAYS integer cents (`amountCents`, `lifetimeCents`); never a
 *    float dollar value.
 *  - Counters are DENORMALIZED and bumped on write, clamped ≥ 0 (see
 *    `bumpGivingRollup` in `giving.ts` for the same pattern) — rows are NEVER
 *    counted at read time (Convex has no count operator).
 *  - `scope` is a real chapter id, or the `"central"` sentinel this repo always
 *    uses instead of null (same union as `FinanceScope` / `seatAssignments.scope`).
 *  - `gifts` is the giving HISTORY (a source record, like a reimbursement
 *    request); `transactions` stays the ONLY actuals ledger (PRD §7, B1). Event
 *    `donations` dual-write a linked `gifts` row on settle (`donationId` set) —
 *    the event flow + its rollups are untouched, the CRM just gains the history.
 */

/** How a donor relationship is classified (individual vs institutional). */
export const DONOR_KINDS = [
  "individual",
  "church",
  "business",
  "foundation",
] as const;

/**
 * A donor's lifecycle status, DERIVED from `lastGiftAt` on every gift write
 * (the 90-day lapse rule from the AJ donor system, PRD §1):
 *  - `prospect` — no gifts yet (`giftCount === 0`);
 *  - `active`   — a gift within the last 90 days;
 *  - `lapsed`   — has given, but not in the last 90 days (the reactivation queue).
 * A time-based cron that lapses `active` donors as the window passes is a
 * fast-follow (see the TODO in `givingPlatform.ts`), not part of P1.
 */
export const DONOR_STATUSES = ["prospect", "active", "lapsed"] as const;

/** Where a donor record originated (provenance, for the CRM audit trail). */
export const DONOR_SOURCES = [
  "givebutter-import",
  "event-donation",
  "manual",
  "map",
] as const;

/** The "source" of a single gift — how the money arrived (the UI labels this
 *  field "Source"; `stripe` displays as "Chapter OS", our own rails). Broader
 *  than the event `donations` method set (card/cash/other) because both the
 *  backfilled history AND external gifts (direct transfers, expensive purchases
 *  made on behalf of the org) span every channel the development team has ever
 *  taken money through. Order: the original set first, then the appended sources
 *  — never renumber, callers persist these literals.
 *
 *  The legacy `imported` literal (Givebutter-history rows imported before the
 *  merged "Source" field existed) was relabeled onto `givebutter`/`other` by
 *  migration 0031 and dropped from this union once 0031 had run in prod — see
 *  `migrations/0031_gift_method_sources.ts`. New gifts never wrote it even
 *  while it was still in the union. */
export const GIFT_METHODS = [
  "stripe",
  "cash",
  "check",
  "wire",
  "in_kind",
  // Appended sources (widened for the merged "Source" field — territories P4).
  "zelle",
  "venmo",
  "givebutter",
  "other",
  // Gifts ledger: Cash App is a distinct P2P rail the giving desk takes money
  // through (the owner's Zelle/Cash App gifts) — genuinely absent above, so
  // appended here (never renumber; callers persist these literals). "Paid on
  // behalf of the org" gifts (an expensive purchase made for the org that
  // counts toward the giver's statement) are already covered by `in_kind` — no
  // new literal for that case.
  "cash_app",
] as const;

/**
 * Gifts ledger AUDIT — the "breadcrumb trail" (owner request #4b) of every
 * human change to a gift: who did it, when, and a compact field-level summary.
 * A new immutable row per create / edit / donor-reassign / scope-move, read
 * newest-first on the gift detail via `by_gift`. This is the giving desk's
 * cleanup accountability record, deliberately separate from the money rollups
 * (which stay exact via `lib/givingDonors.ts`); the audit never affects a
 * counter, it only narrates. System-written gifts (event dual-write, Stripe
 * recurring cycle, CSV/canonical import) do NOT write audit rows — the trail is
 * for HUMAN desk edits, not machine writes, so it stays legible during cleanup.
 */
export const GIFT_AUDIT_ACTIONS = [
  "created",
  "edited",
  "reassignedDonor",
  "movedScope",
  // Gifts ledger integrity tools (owner feedback #1/#2):
  //  - `deleted`        — the gift row is GONE, so this breadcrumb carries a
  //    self-contained SNAPSHOT of it (donor name, amount, date, book, source)
  //    in `changes`, plus the required "why" in `note`. Read at the BOOK level
  //    (`by_scope`) — a deleted gift has no detail screen to reach `by_gift`.
  //  - `split`          — written on the ORIGINAL gift right before it's
  //    replaced by its per-part children (snapshot + child book/amount refs).
  //  - `createdBySplit` — written on EACH child gift, referencing the original.
  "deleted",
  "split",
  "createdBySplit",
] as const;

/** A donor's `scope`: the chapter that stewards the relationship, or central. */
const givingScope = v.union(v.id("chapters"), v.literal("central"));

/**
 * A donor's optional MAILING ADDRESS — for postal outreach (year-end letters,
 * thank-you cards, tax statements). Every field is optional so a partial
 * address (just a city/state, or a country only) is a legal record; the whole
 * object is optional on the donor. Populated by manual edit (`upsertDonor`) and
 * by the canonical import when an export row carries an address (donor creation
 * + fill-if-blank on match — never overwrites an address already on file).
 */
export const donorAddressValidator = v.object({
  line1: v.optional(v.string()),
  line2: v.optional(v.string()),
  city: v.optional(v.string()),
  state: v.optional(v.string()),
  postalCode: v.optional(v.string()),
  country: v.optional(v.string()),
});

/**
 * A recurring pledge's lifecycle, tracking the Stripe subscription behind it
 * (PRD §2):
 *  - `incomplete` — created, awaiting the donor's first successful checkout;
 *  - `active`     — the subscription is live and paying (counts toward backers
 *                   at/above `BACKER_UNIT_CENTS`);
 *  - `past_due`   — a cycle's payment failed; Stripe Smart Retries is dunning;
 *  - `canceled`   — the subscription ended (donor canceled, or Stripe gave up).
 *  - `paused`     — owner feedback #5a: a MANUAL, local hold. A paused pledge
 *                   does NOT count toward `backerCount` (the derived count only
 *                   sums `active` pledges, so `paused` is excluded for free) but
 *                   STAYS in the backers list (history preserved). Appended last
 *                   (never renumber — callers persist these literals). See
 *                   `givingPledges.setPledgeStatus` for the Stripe interaction.
 */
export const PLEDGE_STATUSES = [
  "incomplete",
  "active",
  "past_due",
  "canceled",
  "paused",
] as const;

/**
 * Where a pledge came from:
 *  - `stripe`   — a real recurring subscription on OUR rails (Stripe Billing);
 *  - `imported` — a Givebutter recurrence that CANNOT be ported (its card lives
 *                 in Givebutter's Stripe, PRD §2). Tracked as a pledge-shaped
 *                 row awaiting the donor's personal re-signup on our rails.
 */
export const PLEDGE_ORIGINS = ["stripe", "imported"] as const;

/**
 * A donor — any person or org that has ever given, stewarded by one scope.
 * Denormalized rollups (`lifetimeCents` / `giftCount` / `firstGiftAt` /
 * `lastGiftAt`) are maintained on every gift write and clamped ≥ 0; `status` is
 * recomputed from them. `userId` links the donor to a member account when they
 * are also on the roster.
 */
export const donors = defineTable({
  scope: givingScope,
  kind: v.union(...DONOR_KINDS.map((k) => v.literal(k))),
  name: v.string(),
  email: v.optional(v.string()), // normalized lowercase (the dedup key)
  phone: v.optional(v.string()),
  // Optional mailing address for postal outreach (see `donorAddressValidator`).
  // Set by manual edit or the canonical import (fill-if-blank on match).
  address: v.optional(donorAddressValidator),
  status: v.union(...DONOR_STATUSES.map((s) => v.literal(s))),
  // Relationship owner (AJ's "owners") — a roster person, not an auth user.
  ownerPersonId: v.optional(v.id("people")),
  notes: v.optional(v.string()),
  source: v.optional(v.union(...DONOR_SOURCES.map((s) => v.literal(s)))),
  // Linked member account, when the donor is also on the roster.
  userId: v.optional(v.id("users")),
  // Territories P5: the chapter `people` row this donor 1:1-links to. Set by
  // `lib/givingDonors.ts#linkDonorToPerson` on create/edit for a CHAPTER-scope
  // donor only — a `"central"` donor has no chapter roster to link into and
  // stays permanently unset (central donors are CRM-only). Powers the People
  // tab's "Givers" overlay (`givingPlatform.giverMarks`) without leaking money
  // fields into the roster payload itself.
  personId: v.optional(v.id("people")),
  // Denormalized rollups (bumped on gift write, clamped ≥ 0).
  lifetimeCents: v.number(),
  giftCount: v.number(),
  lastGiftAt: v.optional(v.number()),
  firstGiftAt: v.optional(v.number()),
  createdAt: v.number(),
  // Cross-chapter IDENTITY layer (donor-identity, 2026-07): the `donorIdentities`
  // row that represents this scope-partitioned donor's UNDERLYING PERSON across
  // books. ADDITIVE — this row's own per-scope rollups (`lifetimeCents`/
  // `giftCount`) are NEVER changed by the identity layer; the identity only
  // GROUPS rows and keeps its OWN aggregate. Attached-or-created on every donor
  // write (`matchOrCreateDonor`, `upsertDonor`) and kept in sync when a gift
  // lands/leaves or the donor is edited (`lib/donorIdentity.ts`). Optional
  // because it's populated lazily on write + by `donorIdentityBackfill.ts` for
  // pre-existing rows. Grouping key is normalized email (primary), else phone,
  // else exact normalized name — the same person-across-books rule
  // `listOrgDonorsByIdentity` reads at query time, now persisted.
  identityId: v.optional(v.id("donorIdentities")),
})
  .index("by_scope", ["scope"])
  .index("by_scope_and_status", ["scope", "status"])
  // The "top donors" ordering the relationship workflow needs on day one.
  .index("by_scope_and_lifetime", ["scope", "lifetimeCents"])
  // Scoped dedup on match-or-create (email is the primary key, name the fallback).
  .index("by_scope_and_email", ["scope", "email"])
  .index("by_scope_and_name", ["scope", "name"])
  // Cross-scope email lookup (member linking, future dedup surfaces).
  .index("by_email", ["email"])
  // Phone fallback for `linkDonorToPerson`'s people-roster match (territories
  // P5) — a scoped exact-phone lookup alongside the email/name indexes above.
  .index("by_scope_and_phone", ["scope", "phone"])
  // Cross-chapter identity layer: every scope row that belongs to one underlying
  // person, for the identity's aggregate recompute + the drill-in per-book list.
  .index("by_identity", ["identityId"]);

/**
 * A cross-chapter donor IDENTITY (donor-identity, 2026-07) — the ONE underlying
 * person behind the scope-partitioned `donors` rows. The giving book is
 * per-`(scope, person)` (a giver to central AND New York is two `donors` rows,
 * on purpose, so chapters keep their donors separate). This layer sits OVER
 * those rows: a donor who gives to everyone shows up as one identity carrying
 * the `scopes` they're part of, WITHOUT collapsing the underlying rows or
 * touching their per-scope money rollups.
 *
 * Grouping key (`key`, the `by_key` dedup index): normalized email (primary),
 * else exact phone, else exact normalized name — the person-across-books rule
 * `givingPlatform.listOrgDonorsByIdentity` computes at read time, now PERSISTED
 * and maintained on write. (That read-time query keys `personId` first, but a
 * `personId` is a per-chapter roster row that can never be shared across two
 * scope-partitioned donors, so email is what actually groups cross-book — and
 * is the donors table's own documented "primary key". `personId` stays a
 * linking signal, not the stored identity key.)
 *
 * Denormalized aggregates (`lifetimeCents`/`giftCount`/`lastGiftAt`) are the
 * SUM/MAX across the identity's `donors` rows, RECOMPUTED from those rows on
 * every relevant write (never a blind bump — one donor per scope makes the
 * recompute a small bounded read, so it can't drift). `scopes` is the distinct
 * set of books this identity's rows belong to — the "field for what chapters"
 * a giver is part of / has given to. An identity with no remaining rows is
 * garbage-collected (this layer is additive scaffolding, safe to delete — never
 * money data).
 */
export const donorIdentities = defineTable({
  // The grouping key: "e:<normalized email>" | "p:<trimmed phone>" |
  // "n:<normalized name>" (see `lib/donorIdentity.ts#donorIdentityKey`).
  key: v.string(),
  // Normalized-lowercase email — present iff the key is email-derived (the
  // primary/stable key). Kept for display + `by_email` lookup.
  email: v.optional(v.string()),
  // Display name (from the strongest-lifetime attached donor row).
  name: v.string(),
  phone: v.optional(v.string()),
  // Aggregates across the identity's `donors` rows (recomputed, never blind-bumped).
  lifetimeCents: v.number(),
  giftCount: v.number(),
  lastGiftAt: v.optional(v.number()),
  // The books this identity is part of / has given to — the distinct set of its
  // donor rows' scopes. This is the cross-chapter "what chapters" field.
  scopes: v.array(givingScope),
  createdAt: v.number(),
})
  // Dedup + attach lookup: at most one identity per grouping key.
  .index("by_key", ["key"])
  // Email lookup (display / future cross-surface reconciliation).
  .index("by_email", ["email"])
  // "Biggest underlying donors" ordering for the identity-grouped org view.
  .index("by_lifetime", ["lifetimeCents"]);

/**
 * One gift — a single dollar-amount received, ever, from any source. The unit
 * of giving history. `donationId` links back to the event `donations` row a
 * gift was dual-written from (the migration + settle-time write use it for
 * idempotency); `externalRef` is the Givebutter transaction id, the dedup key
 * that makes CSV import safely re-runnable; `sponsorshipId` (F-6 P4) links a
 * payment to its `sponsorships` agreement — see `sponsorships.ts#recordSponsorshipGift`.
 */
export const gifts = defineTable({
  donorId: v.id("donors"),
  scope: givingScope,
  amountCents: v.number(), // int > 0
  currency: v.string(), // "usd"
  receivedAt: v.number(),
  method: v.union(...GIFT_METHODS.map((m) => v.literal(m))),
  // Set when the gift came through an event page (dual-write from `donations`).
  eventId: v.optional(v.id("events")),
  donationId: v.optional(v.id("donations")), // link to the event donation row
  externalRef: v.optional(v.string()), // Givebutter txn id (import dedup key)
  // F-6 P4: set when this payment is against a sponsorship agreement.
  sponsorshipId: v.optional(v.id("sponsorships")),
  note: v.optional(v.string()),
  recordedBy: v.optional(v.id("users")), // manual/backfill entries
  // P2 recurring: set for a gift written from a Stripe subscription billing
  // cycle (`invoice.paid`). `stripeInvoiceId` is the cycle's idempotency key —
  // one gift per invoice, safe on webhook redelivery.
  pledgeId: v.optional(v.id("pledges")),
  stripeInvoiceId: v.optional(v.string()),
  // Territories launch pot (docs/plans/giving-territories.md §D3): `true` iff
  // this gift's amount is currently counted inside its territory's
  // `launchFundCents` pot — stamped by `recordGiftForDonor` when the gift lands
  // on a chapter whose territory is still `prospect`/`raising` (100% pre-launch
  // accrual). The flag makes reversal EXACT: `removeGiftRow` un-bumps the pot
  // only for a flagged gift, and only while the territory hasn't launched (the
  // freeze — a post-launch delete leaves the flag on the deleted row's history
  // but never un-bumps a frozen pot). Absent/`false` = never counted.
  countedInLaunchFund: v.optional(v.boolean()),
  // Territories P4 (gift sources/editing/receipts): file/image proof on a gift
  // — especially external gifts (direct transfers, purchases made on behalf of
  // the org that count toward the giver's statement). A BOUNDED array (≤ 10,
  // enforced at the mutations, NOT the validator) that mirrors the house
  // `receiptStorageId` pattern on `reimbursementLineItems`/`transactions`.
  receiptStorageIds: v.optional(v.array(v.id("_storage"))),
  // Set the first time a gift is edited in place (`editGiftRow`) — the audit
  // stamp for a manual correction. A SYSTEM-WRITTEN gift (`isSystemWrittenGift`
  // — a Stripe cycle, an event donation, a sponsorship payment, OR a matched
  // bank credit) can only ever have its note/receipts touched, never its money
  // fields. `editedAt` is stamped iff something ACTUALLY changed (a no-op
  // resubmit writes nothing), so an edit stamp exists iff an audit row does.
  editedAt: v.optional(v.number()),
  editedBy: v.optional(v.id("users")),
  // Territories P7 (bank-credit gift matching, docs/plans/giving-territories.md
  // §D10): set when this gift was CONFIRMED from a direct bank-credit candidate
  // (`givingCandidates.confirmExternalGift`) — the evidence link back to the
  // `transactions` row the money actually landed in. Evidence only: `gifts`
  // stays giving HISTORY, `transactions` stays the only actuals ledger (no
  // double-count — the linked transaction is never itself re-summed as a
  // gift). Absent for every other gift (manual entry, CSV import, event
  // dual-write, recurring cycle). `by_transaction` is both the display link
  // AND the candidate query's "already confirmed" exclusion +
  // `confirmExternalGift`'s idempotency check (at most one gift per
  // transaction).
  transactionId: v.optional(v.id("transactions")),
  createdAt: v.number(),
})
  .index("by_donor", ["donorId"])
  .index("by_scope", ["scope"])
  // The dashboard's last-30-days window (bounded range read, never a full scan).
  .index("by_scope_and_received", ["scope", "receivedAt"])
  .index("by_externalRef", ["externalRef"])
  // Gifts manually attached to an event (the fundraiser attribution feature) —
  // powers the per-event gift list + `externalGiftsCents` recompute. Only
  // attached gifts have `eventId`; unattached rows are never in this index.
  .index("by_event", ["eventId"])
  .index("by_donation", ["donationId"])
  .index("by_pledge", ["pledgeId"])
  // One gift per billing cycle — the `invoice.paid` idempotency lookup.
  .index("by_stripeInvoice", ["stripeInvoiceId"])
  .index("by_sponsorship", ["sponsorshipId"])
  // Territories P7: the evidence link's reverse lookup — "is this transaction
  // already a confirmed gift" (candidate exclusion + confirm idempotency).
  .index("by_transaction", ["transactionId"]);

/**
 * One audit breadcrumb for a HUMAN gift change (owner request #4b — "a
 * breadcrumb trail of me showing I updated this"). Written by the giving-desk
 * mutations (`addGift`, `editGift`, `reassignGiftDonor`, `moveGiftScope`) after
 * the money write succeeds, so a row exists iff the change committed. Read
 * bounded newest-first via `by_gift` on the gift detail. `changes` is a compact
 * field-level diff (each `{field, from, to}` already stringified for display —
 * "$50.00" → "$80.00", "New York" → "central"); `note` is the actor's optional
 * "why". Immutable: rows are never patched or deleted (a gift's whole audit
 * outlives an edit; only `removeGift`/`mergeDonors`, which delete gifts, orphan
 * them, and an orphaned trail is harmless — it's never read without its gift).
 */
export const giftAudit = defineTable({
  giftId: v.id("gifts"),
  // The gift's scope at the time of the change (the "book" it was in) — kept
  // for a possible future scope-filtered audit read; the primary read is by_gift.
  scope: givingScope,
  actorUserId: v.id("users"),
  at: v.number(),
  action: v.union(...GIFT_AUDIT_ACTIONS.map((a) => v.literal(a))),
  // Compact, display-ready field-level change summary. Empty/absent for a bare
  // "created" row. Values are pre-formatted strings (money, dates, labels).
  changes: v.optional(
    v.array(
      v.object({
        field: v.string(),
        from: v.optional(v.string()),
        to: v.optional(v.string()),
      }),
    ),
  ),
  note: v.optional(v.string()), // the actor's optional "why"
})
  .index("by_gift", ["giftId"])
  // Book-level trail: a `deleted` breadcrumb outlives its (now-gone) gift, so
  // it can only be surfaced by scope, newest-first. Also lets the ledger show a
  // book's recent human changes without walking every gift.
  .index("by_scope_and_at", ["scope", "at"]);

/**
 * Donor field AUDIT (owner feedback #4) — the donor-record counterpart to
 * `giftAudit`. One immutable breadcrumb per HUMAN change to a donor's identity
 * fields (name / email / phone) OR its person link, written after the write
 * commits. `changes` is a compact display-ready field-level diff (same shape as
 * `giftAudit.changes`); `note` is the actor's optional "why". Read bounded
 * newest-first via `by_donor` on the donor detail. System writes (import,
 * event/Stripe dual-write, match-or-create) do NOT narrate — the trail is for
 * desk edits, like `giftAudit`.
 */
export const DONOR_AUDIT_ACTIONS = [
  "edited",
  "linkedPerson",
  "unlinkedPerson",
] as const;

export const donorAudit = defineTable({
  donorId: v.id("donors"),
  scope: givingScope,
  actorUserId: v.id("users"),
  at: v.number(),
  action: v.union(...DONOR_AUDIT_ACTIONS.map((a) => v.literal(a))),
  changes: v.optional(
    v.array(
      v.object({
        field: v.string(),
        from: v.optional(v.string()),
        to: v.optional(v.string()),
      }),
    ),
  ),
  note: v.optional(v.string()),
}).index("by_donor", ["donorId"]);

/**
 * Pledge lifecycle HISTORY (owner feedback #5d) — one immutable event per
 * status transition (manual AND system/billing) and per manual field edit
 * (`startedAt`, delete), so a backer's paused / resumed / card-failed / canceled
 * timeline is legible. `actorUserId` is set for a human desk action and ABSENT
 * for a system/billing transition (Stripe webhook, invoice cycle) — the read
 * renders "System" when it's absent. `from`/`to` are display-ready strings.
 * Read bounded newest-first via `by_pledge` on the backer detail.
 */
export const PLEDGE_EVENT_KINDS = [
  "created",
  "status",
  "startedAt",
  "amount",
  "deleted",
] as const;

export const pledgeEvents = defineTable({
  pledgeId: v.id("pledges"),
  scope: givingScope,
  at: v.number(),
  // Absent = a system/billing transition (Stripe webhook / invoice cycle).
  actorUserId: v.optional(v.id("users")),
  kind: v.union(...PLEDGE_EVENT_KINDS.map((k) => v.literal(k))),
  from: v.optional(v.string()),
  to: v.optional(v.string()),
  note: v.optional(v.string()),
}).index("by_pledge", ["pledgeId"]);

/**
 * Territories P7 (bank-credit gift matching, §D10) — a development-team
 * decision that a candidate bank-credit transaction is NOT a gift (an
 * unrecognized deposit, a refund the heuristic missed, a provider payout the
 * description didn't match) and should stop surfacing in
 * `candidateExternalGifts`. Deliberately NOT a soft-delete flag on
 * `transactions` itself — the transaction row is the actuals ledger and stays
 * untouched; this is a tiny side-table recording ONE human decision (mirrors
 * `personalRepayments`' single-purpose link-table shape). `by_transaction`
 * powers both the exclusion lookup and `dismissGiftCandidate`'s idempotency
 * (at most one dismissal per transaction — a second dismiss no-ops rather
 * than piling up rows).
 */
export const dismissedGiftCandidates = defineTable({
  transactionId: v.id("transactions"),
  dismissedBy: v.id("users"),
  dismissedAt: v.number(),
}).index("by_transaction", ["transactionId"]);

/**
 * Per-scope denormalized aggregates for the giving dashboard — one row per
 * scope, so the dashboard reads O(1) instead of scanning `donors`/`gifts`
 * (Convex has no count operator; the guidelines forbid counting at read time).
 * Every counter is bumped on the same writes that touch `donors`/`gifts` and
 * clamped ≥ 0. Per-status counts reflect status AT LAST WRITE — the time-based
 * lapse cron (a fast-follow) is what will keep `lapsedCount` truthful as the
 * 90-day window passes without a write.
 */
export const givingScopeRollups = defineTable({
  scope: givingScope,
  lifetimeCents: v.number(),
  giftCount: v.number(),
  donorCount: v.number(),
  activeCount: v.number(),
  lapsedCount: v.number(),
  prospectCount: v.number(),
  updatedAt: v.number(),
}).index("by_scope", ["scope"]);

/**
 * A recurring pledge (PRD §2) — a donor's standing monthly commitment to a
 * city, backed by a Stripe subscription (or an imported Givebutter recurrence
 * awaiting re-signup). A donor with an `active` pledge at/above
 * `BACKER_UNIT_CENTS` is a BACKER — what the affordability tiers count.
 *
 * `gifts` is still the giving HISTORY: each paid billing cycle (`invoice.paid`)
 * writes one `gifts` row with `pledgeId` set, so recurring giving shows up in
 * the CRM exactly like every other gift. This row is the SUBSCRIPTION state,
 * not the money history.
 *
 * Money is integer cents; `amountCents` is the monthly pledge (≥ 2000 = $20
 * floor, enforced at the write path). Stripe ids are optional because an
 * `incomplete` pledge has no subscription yet, and an `imported` pledge never
 * gets one until the donor re-signs up on our rails.
 */
export const pledges = defineTable({
  donorId: v.id("donors"),
  // The city this pledge backs: a live chapter, or `"central"`. Under
  // Territories a pledge ALWAYS scopes to a real chapter — a prospect
  // territory's shadow chapter is a real (inactive) `chapters` row, so there's
  // no separate prospect-city scoping concept. (Pre-Territories, prospect-city
  // pledges scoped `"central"` + a now-retired `cityCampaignId` field;
  // migration 0029 re-scoped every one of those rows onto its chapter.)
  scope: givingScope,
  amountCents: v.number(), // int ≥ 2000 ($20 floor), enforced at the write path
  status: v.union(...PLEDGE_STATUSES.map((s) => v.literal(s))),
  origin: v.union(...PLEDGE_ORIGINS.map((o) => v.literal(o))),
  // Present once a Stripe subscription is created/linked (absent while
  // `incomplete`, and for `imported` rows that never got one).
  stripeCustomerId: v.optional(v.string()),
  stripeSubscriptionId: v.optional(v.string()),
  externalRef: v.optional(v.string()), // Givebutter recurrence id (import dedup)
  startedAt: v.optional(v.number()), // when the subscription first went active
  canceledAt: v.optional(v.number()),
  currentPeriodEnd: v.optional(v.number()), // synced from the subscription
  createdAt: v.number(),
})
  .index("by_donor", ["donorId"])
  // The admin list + the derived backer-count recompute (active pledges per
  // scope) both read this.
  .index("by_scope_and_status", ["scope", "status"])
  // Webhook resolution: an invoice/subscription event → its pledge.
  .index("by_stripe_subscription", ["stripeSubscriptionId"]);
