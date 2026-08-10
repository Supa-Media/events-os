import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * A paid place on a PROJECT — a multi-session class, cohort or course someone
 * signed up for and paid a registration fee to attend.
 *
 * ── WHY THIS ISN'T A `ticketOrders` ROW ─────────────────────────────────────
 * `ticketOrders.eventId` is REQUIRED, and the thing people registered for is
 * not an event. "Worship Beyond The Walls" was a class that ran over several
 * weeks with a $50 fee — a `projects` row, with no `events` row behind it and
 * no `eventPages` to sell from. Forcing it into `ticketOrders` would mean
 * inventing an event that never existed, and every ticket/attendance report
 * would then count a class cohort as an event turnout — the same reasoning
 * that keeps merch in `sales` rather than `ticketOrders` (see that table's
 * header).
 *
 * Nor is it an `engagements` row: that table is volunteer/paid CREW — people
 * the org pays or rosters TO work an event — and it also requires an
 * `eventId`. A registrant is the opposite direction of money.
 *
 * So there was no person↔project link in this schema at all, and three paid
 * registrations simply never reached the books. The 2026-08-10 reconciliation
 * traced $150.00 of an unexplained org-wide gap to exactly that hole:
 * Givebutter collected $300.00 across six transactions, refunded $150.00 as
 * scholarships, and remitted $150.00 in payout `KKJ3TQ`. Our side had none of
 * it.
 *
 * ── REVENUE ─────────────────────────────────────────────────────────────────
 * This is the FOURTH revenue stream, alongside gifts, paid ticket orders and
 * sales. `status: "paid"` counts toward book value exactly as a paid
 * `ticketOrders` row does — summed chapter-scoped in
 * `reconciliation.ts#computeBookBalances` (phase 1) and itemised by
 * `bookValueBreakdown` / `bookValueLines`. `refunded` and `comped` count
 * NOTHING, and are still stored and still shown on the project: a scholarship
 * is a decision the org made, and a table that only keeps the money would
 * erase it.
 *
 * ── WRITE PATH ──────────────────────────────────────────────────────────────
 * There is deliberately NO authoring UI. The owner, 2026-08-10: "there would
 * need to be a course registration page where we can collect payments… I don't
 * want people to manually record payments, I want it all to flow through the
 * system." The only writer today is the one-time Givebutter backfill; the
 * shape here is the one a checkout-driven registration page needs, so that page
 * lands as new functions against this table rather than as a migration.
 */
export const registrations = defineTable({
  /** The book this registration's money belongs to. Denormalised from the
   *  project so the chapter-scoped revenue sum is one indexed read, exactly as
   *  `ticketOrders.chapterId` is. */
  chapterId: v.id("chapters"),
  /** The class/cohort/course they registered for. */
  projectId: v.id("projects"),
  /** The roster person, WHERE ONE EXISTS. Optional on purpose: someone paying
   *  to attend a class is very often not on the roster yet, and refusing the
   *  money until they are would be the tail wagging the dog. `name`/`email`
   *  below always carry what the registration itself stated, so an unlinked row
   *  is complete on its own and can be linked later without losing anything. */
  personId: v.optional(v.id("people")),
  /** What the registrant called themselves at checkout — a snapshot, never
   *  re-read from `people`, so the row still says who paid if the link changes. */
  name: v.string(),
  /** Optional because a cash/manual rail can produce a registration with no
   *  address. It is also the ONLY sound key for matching a registrant to a
   *  `people` row — never the name. */
  email: v.optional(v.string()),
  /** What they were charged, GROSS of processor fees — the same basis the other
   *  three revenue streams use. The fee is booked as its own expense by
   *  `processorFees.ts` and is never a haircut on revenue. */
  amountCents: v.number(),
  /**
   * Soft states, never a delete — a refund is a thing that happened, not the
   * absence of a thing.
   *  - `paid`     — money collected and kept. REVENUE.
   *  - `refunded` — money collected and given back (`refundReason` says why).
   *    Not revenue; still on the project.
   *  - `comped`   — a place given without charge. Not revenue; `amountCents`
   *    records what the place WOULD have cost, so the project can show what it
   *    gave away. Distinct from `refunded` because no money ever moved, which
   *    matters to anyone reconciling against a processor.
   */
  status: v.union(v.literal("paid"), v.literal("refunded"), v.literal("comped")),
  /** Why the money went back — "scholarship" is the case that prompted this
   *  table. Free text rather than an enum: the reasons are a human's sentence
   *  today, and an enum invented before there is a second real value would be
   *  guessing at the vocabulary. */
  refundReason: v.optional(v.string()),
  /**
   * THE IDEMPOTENCY KEY for a registration that arrived on a non-Stripe rail,
   * namespaced by rail: `gb:txn:<givebutter transaction id>`. Mirrors
   * `sales.externalRef` (`cashapp:sale:…`) and `ticketOrders.externalRef`
   * (`gb:ticket:…`) — same idiom, deliberately, rather than a fourth spelling
   * of the same idea. Indexed, so "have I already imported this payment?" is
   * one lookup AGAINST THIS TABLE.
   *
   * ⚠ IT IS NOT UNIQUE ACROSS TABLES, and an earlier version of this comment
   * wrongly implied it was. `gifts` already holds `gb:txn:<id>` rows — written
   * by the 2026-07-19 one-time CSV backfill (`lib/seed/historical/giving.ts` →
   * `historicalBackfill.ts`), keyed on the 10-digit Reference Number the
   * Givebutter EXPORT prints. (The live sync is a separate matter: it writes
   * `gifts.externalRef` UNPREFIXED, as the bare 16-char API transaction id, and
   * only READS the `gb:txn:` prefix in its legacy guard.) The string identifies
   * a Givebutter TRANSACTION, not a row, so dedup is per-table by construction
   * and "does this externalRef exist?" is not a question anyone can ask
   * globally.
   *
   * ⚠ AND THERE IS A LIVE DOUBLE-COUNT PATH THIS TABLE CANNOT CLOSE. Nothing in
   * `givebutterSync.ts` reads `registrations`. Attach the Worship Beyond The
   * Walls campaign to an `eventPages.givebutterCampaignId` — one text box, no
   * allowlist — and the sync re-imports the three PAID transactions (it drops
   * the three refunds itself, via `isRefundedTransaction`), counting exactly
   * $150.00 twice and swinging the org-wide gap to −$150.00. The same move cost
   * $665 of duplicate giving on Pop The Balloon in 2026-08.
   *
   * DO NOT ATTACH THAT CAMPAIGN TO AN EVENT. See
   * `backfillWorshipRegistrations.ts` for why the code guard is deferred rather
   * than guessed at.
   *
   * No `externalProvider` column beside it: the namespace prefix already says
   * which rail carried the money, and `sales` settled on exactly that.
   */
  externalRef: v.optional(v.string()),
  /** For the registration page that doesn't exist yet. A Stripe-checkout
   *  registration will carry these two instead of `externalRef`, exactly as a
   *  Stripe `ticketOrders` row does — the webhook settles `pending → paid` by
   *  session id, which is why the index below exists ahead of its caller. */
  stripeCheckoutSessionId: v.optional(v.string()),
  stripePaymentIntentId: v.optional(v.string()),
  /** When they registered — the event in the world, not when we imported it. */
  registeredAt: v.number(),
  /** WHEN the money went back, where that is known — NOT an "iff refunded"
   *  invariant, deliberately. The Givebutter export that seeded the first six
   *  rows gave each refund a status but no date, and copying `registeredAt`
   *  into here would be a fabricated fact on a money row. So a `refunded` row
   *  with no `refundedAt` means "we know it was refunded, we don't know the
   *  day" — which is the truth — and code must not read the absence of this
   *  field as "not refunded". `status` is the only authority on that. */
  refundedAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  // The project money page's registrations section — one bounded read.
  .index("by_project", ["projectId"])
  // The book-value revenue sum: a chapter's registrations in one bounded read
  // (`reconciliation.ts#computeBookBalances`), mirroring `ticketOrders.by_chapter`.
  .index("by_chapter", ["chapterId"])
  // Dedup key for an imported payment — the backfill applies on this.
  .index("by_external_ref", ["externalRef"])
  // The future checkout webhook's settle lookup. Present now because the
  // Stripe columns above are, and a webhook that has to scan the table to find
  // its own session is the kind of thing nobody notices until the table is big.
  .index("by_stripe_session", ["stripeCheckoutSessionId"]);
