/**
 * One-time: Pop The Balloon's Venmo money is 41 tickets, not a gift (2026-08-09).
 *
 * Charisma Stevens collected the Venmo payments for Pop The Balloon by hand and
 * forwarded the lot as ONE $820.00 Givebutter payment on 2025-11-30. The
 * Givebutter sync recorded it the only way the API let it: a personal donation
 * from Charisma, tagged to the event. `lib/seed/historical/ptbVenmo2026.ts`
 * holds the guest list, the arithmetic and the reasoning behind every
 * judgement; this runs it.
 *
 * The swap, in one sentence: the $820 gift comes off the giving ledger and
 * $820 of paid ticket revenue goes on, carrying the 40 named Venmo guests plus
 * one the owner identified himself (`RESOLVED_41ST_GUEST` — the guest list's
 * Platform column catches 40 of the 41, and Brenell Harrison's was left blank).
 *
 * ── BOOK VALUE MUST NOT MOVE ────────────────────────────────────────────────
 * `reconciliation.ts#computeBookBalances` counts a scope's gifts and its PAID
 * ticket orders at face value, once each. $820 of gift becoming $820 of ticket
 * revenue on the same book is therefore worth exactly $0 — and that is the
 * whole test of whether this correction is a correction or a mistake. The
 * runner computes the delta from the rows it actually touched and reports it;
 * `tests/ptbVenmoBackfill.test.ts` reads book value out of the real
 * `accountBalances` query before and after and requires equality.
 *
 * The EVENT's two counters do move, by the same $820 in opposite directions:
 * Revenue (ticket-only) up, Given (`externalGiftsCents`) down. `removeGiftRow`
 * reverses the Given bump the gift made when the sync recorded it — which is
 * one of several reasons the gift leaves through that helper rather than
 * `ctx.db.delete`. The others are donor `lifetimeCents`/`giftCount`, the scope
 * rollups, donor status, the cross-chapter identity aggregate and the
 * territory launch pot: a raw delete would leave every one of them overstated
 * by $820.
 *
 * ── THE SYNC WOULD PUT THE GIFT STRAIGHT BACK ───────────────────────────────
 * `applyGivebutterDonations` decides "already recorded?" by looking the
 * Givebutter transaction id up in `gifts.by_externalRef`. Remove the gift and
 * that lookup misses, so the next run of a campaign that is still attached to
 * this event inserts the donation again — $820 in the books twice, once as
 * tickets and once as a resurrected gift. A dedup key that stops matching is
 * the failure this integration keeps having; it is what #533 spent a day
 * repairing when the CSV backfill and the live sync keyed on different ids.
 *
 * So the conversion writes a DURABLE record — a `givebutterConvertedDonations`
 * row keyed on the same transaction id — and `applyGivebutterDonations` now
 * consults it before inserting. See that table's doc for why a tombstone beat
 * the alternatives (a neutralised gift row cannot be zeroed past
 * `assertPositiveGiftCents`, and any surviving gift row keeps asserting the
 * very claim being retracted).
 *
 * ── NOTHING IS WRITTEN ON A PATTERN ─────────────────────────────────────────
 * The gift is found by its transaction id and then RE-VERIFIED — amount, scope,
 * event, method, and that it is not an on-page donation dual-write — against
 * the data module before anything is touched. The admission count is recomputed
 * from the LIVE gift's amount rather than trusted from the module, so a gift
 * that is no longer $820 stops the run instead of being papered over with 41
 * tickets. Any disagreement is reported in `problems` and NOTHING is written:
 * all or nothing, because half of this correction is a worse state than none of
 * it. That rule is the standing lesson of a real $500 bank deposit deleted
 * earlier in this reconciliation for matching a duplicate's amount and date.
 *
 * `execute` omitted / false = a zero-write dry run that reports exactly what a
 * real run would do. Delete this module once run.
 */
import { internalMutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { NEW_YORK_CHAPTER_SLUG } from "./lib/seed/historical/mapping";
import { removeGiftRow } from "./lib/givingDonors";
import {
  ADMISSION_41_CANDIDATES,
  COLLECTOR_EMAIL,
  COLLECTOR_NAME,
  FORWARDED_AT_MS,
  FORWARDED_CENTS,
  GIVEBUTTER_TRANSACTION_ID,
  PTB_PAGE_SLUG,
  RESOLVED_41ST_GUEST,
  TICKET_ATTENDEE_NAMES,
  TICKET_ORDER_NAME,
  TICKET_ORDER_REF,
  TICKET_PRICE_CENTS,
  VENMO_TYPE_NAME,
  ticketGrossCents,
} from "./lib/seed/historical/ptbVenmo2026";

/** One event's tiers — a handful, never thousands. */
const TICKET_TYPE_SCAN_LIMIT = 100;

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** What the reclassification says about Charisma's donor record — the answer to
 *  "did she stop being credited with money she never gave, and did anything
 *  else of hers move?" Reported per RUN from the live donor row, because it is
 *  the single thing most worth eyeballing before `execute: true`. */
const donorReport = v.object({
  name: v.string(),
  lifetimeCentsBefore: v.number(),
  lifetimeCentsAfter: v.number(),
  giftCountBefore: v.number(),
  giftCountAfter: v.number(),
  /** Her gifts that this run does NOT touch. Seven, and they are all real. */
  otherGiftsKept: v.number(),
  otherGiftCentsKept: v.number(),
});

export const runPtbVenmoBackfill = internalMutation({
  args: {
    /** Stamped on the conversion record as `convertedBy` — a money
     *  reclassification leaves an attributable trail. Passed in because this
     *  runs from the CLI, which carries the deployment admin key and has no
     *  session to derive it from. */
    recordedBy: v.id("users"),
    execute: v.optional(v.boolean()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    /** False when the gift could not be verified — nothing was written. */
    proceeded: v.boolean(),
    /** The Givebutter transaction this run is about. */
    externalRef: v.string(),
    giftFound: v.boolean(),
    giftCents: v.number(),
    donor: v.union(donorReport, v.null()),
    conversionRecorded: v.boolean(),
    ticketOrderCreated: v.boolean(),
    ticketCents: v.number(),
    ticketAdmissions: v.number(),
    /** How many of the 41 come from the transcribed `Platform` = Venmo rows.
     *  The remainder is the owner-resolved 41st — so this is the count of
     *  admissions that rest on the guest list rather than on a judgement. */
    transcribedAdmissions: v.number(),
    /** The event page's Revenue and Given, which move by ±the same $820. */
    eventRevenueDeltaCents: v.number(),
    eventGivenDeltaCents: v.number(),
    /** The whole point: 0. A non-zero value means this is not a
     *  reclassification and should not be executed. */
    bookValueDeltaCents: v.number(),
    /** Disagreements and open questions — reported, never guessed past. */
    problems: v.array(v.string()),
  }),
  handler: async (ctx, { recordedBy, execute }) => {
    const write = execute ?? false;
    const problems: string[] = [];

    const chapter = await ctx.db
      .query("chapters")
      .withIndex("by_slug", (q) => q.eq("slug", NEW_YORK_CHAPTER_SLUG))
      .first();
    if (!chapter) {
      throw new ConvexError({ code: "NO_CHAPTER", message: "NY chapter not found." });
    }

    const page = await ctx.db
      .query("eventPages")
      .withIndex("by_slug", (q) => q.eq("slug", PTB_PAGE_SLUG))
      .unique();
    if (!page) {
      throw new ConvexError({
        code: "NO_PAGE",
        message: `No event page with slug "${PTB_PAGE_SLUG}".`,
      });
    }
    if (page.chapterId !== chapter._id) {
      throw new ConvexError({
        code: "WRONG_SCOPE",
        message:
          `The "${PTB_PAGE_SLUG}" page is not on the New York chapter. This backfill ` +
          `moves money between layers on ONE book and cannot reason about two.`,
      });
    }

    // The 41st admission is DISCLOSED on every run, dry or real — not because
    // it is unresolved (the owner settled it on 2026-08-09) but because it is
    // the one figure in this correction that rests on a person's memory rather
    // than on arithmetic. Everything else is forced by $820 ÷ $20. A judgement
    // that is invisible after it is made is one nobody can revisit, so it stays
    // in front of whoever reads a run, with the alternatives it was chosen over.
    problems.push(
      `the 41st admission is recorded as "${RESOLVED_41ST_GUEST.name}" (${RESOLVED_41ST_GUEST.handle}) ` +
        `on the owner's decision of 2026-08-09 — the guest list's Platform=Venmo filter catches only ` +
        `40 of the 41 tickets the $820 pays for, so this one name is a judgement, not a transcription. ` +
        `${ADMISSION_41_CANDIDATES.join("; ")}. If that is wrong, it is the last entry of the order's ` +
        `attendeeNames.`,
    );

    // ── 0. Has this already run? ─────────────────────────────────────────────
    const priorConversion = await ctx.db
      .query("givebutterConvertedDonations")
      .withIndex("by_externalRef", (q) =>
        q.eq("externalRef", GIVEBUTTER_TRANSACTION_ID),
      )
      .first();
    const priorOrder = await ctx.db
      .query("ticketOrders")
      .withIndex("by_external_ref", (q) => q.eq("externalRef", TICKET_ORDER_REF))
      .unique();

    // ── 1. The gift, re-verified against the module before anything moves ────
    const gift = await ctx.db
      .query("gifts")
      .withIndex("by_externalRef", (q) =>
        q.eq("externalRef", GIVEBUTTER_TRANSACTION_ID),
      )
      .first();

    const nothing = {
      dryRun: !write,
      proceeded: false,
      externalRef: GIVEBUTTER_TRANSACTION_ID,
      giftFound: gift != null,
      giftCents: gift?.amountCents ?? 0,
      donor: null,
      conversionRecorded: false,
      ticketOrderCreated: false,
      ticketCents: 0,
      ticketAdmissions: 0,
      transcribedAdmissions: 0,
      eventRevenueDeltaCents: 0,
      eventGivenDeltaCents: 0,
      bookValueDeltaCents: 0,
      problems,
    };

    if (!gift) {
      // A SECOND RUN is the benign reading, and it has a positive proof rather
      // than an assumption: the conversion record and the replacement order are
      // both present, so the money is exactly where this module put it.
      if (priorConversion && priorOrder) {
        return { ...nothing, proceeded: true };
      }
      problems.push(
        `no gift with externalRef "${GIVEBUTTER_TRANSACTION_ID}" — and no conversion record ` +
          `to say it was already reclassified. Nothing was written; find out where the ` +
          `${usd(FORWARDED_CENTS)} went before running this again.`,
      );
      return nothing;
    }

    // THE ADMISSION COUNT IS RECOMPUTED FROM THE LIVE MONEY, not read off the
    // module — and it is checked FIRST, before the row is compared to what this
    // module was written against. The order matters: "whatever this row now is,
    // does it even describe whole $20 tickets?" is the question that has to be
    // answerable before any of the narrower ones mean anything.
    if (gift.amountCents % TICKET_PRICE_CENTS !== 0) {
      problems.push(
        `gift ${GIVEBUTTER_TRANSACTION_ID}: ${usd(gift.amountCents)} is not a whole number of ` +
          `${usd(TICKET_PRICE_CENTS)} tickets — nothing written.`,
      );
      return nothing;
    }
    const admissions = gift.amountCents / TICKET_PRICE_CENTS;

    // Every one of these is a fact the correction depends on. A gift that has
    // moved book, changed amount, lost its event tag or turned into an on-page
    // donation dual-write is not the row this module was written against, and
    // converting it anyway would be guessing.
    if (gift.amountCents !== FORWARDED_CENTS) {
      problems.push(
        `gift ${GIVEBUTTER_TRANSACTION_ID}: expected ${usd(FORWARDED_CENTS)}, found ` +
          `${usd(gift.amountCents)} — nothing written.`,
      );
      return nothing;
    }
    if (gift.scope !== chapter._id) {
      problems.push(
        `gift ${GIVEBUTTER_TRANSACTION_ID}: expected New York's scope, found "${gift.scope}" ` +
          `— nothing written.`,
      );
      return nothing;
    }
    if (gift.eventId !== page.eventId) {
      problems.push(
        `gift ${GIVEBUTTER_TRANSACTION_ID}: expected it tagged to Pop The Balloon, found ` +
          `${gift.eventId == null ? "no event" : `event "${gift.eventId}"`} — nothing written. ` +
          `The event tag is what makes the Given rollup reversible.`,
      );
      return nothing;
    }
    if (gift.donationId !== undefined) {
      problems.push(
        `gift ${GIVEBUTTER_TRANSACTION_ID}: carries a donationId, so it is an on-page ` +
          `donation dual-write owned by giving.ts, not the Givebutter sync's row — nothing written.`,
      );
      return nothing;
    }
    if (gift.method !== "givebutter") {
      problems.push(
        `gift ${GIVEBUTTER_TRANSACTION_ID}: expected method "givebutter", found ` +
          `"${gift.method}" — nothing written.`,
      );
      return nothing;
    }

    // And the module has to carry exactly one name per admission. This is the
    // guard that catches an EDIT to the guest list — someone adding or dropping
    // a Venmo row without touching the money — which would otherwise write an
    // order whose attendee list and quantity disagree.
    if (TICKET_ATTENDEE_NAMES.length !== admissions) {
      problems.push(
        `gift ${GIVEBUTTER_TRANSACTION_ID}: ${usd(gift.amountCents)} is ${admissions} tickets but ` +
          `the module carries ${TICKET_ATTENDEE_NAMES.length} names — nothing written.`,
      );
      return nothing;
    }

    // ── 2. The donor, read BEFORE the removal so the report has both sides ───
    const donor = await ctx.db.get(gift.donorId);
    if (!donor) {
      problems.push(
        `gift ${GIVEBUTTER_TRANSACTION_ID}: its donor row is missing — nothing written.`,
      );
      return nothing;
    }
    // Bounded read: one donor's giving history, not a table scan. Reported so a
    // reader can see at a glance that her other giving is untouched.
    const herGifts = await ctx.db
      .query("gifts")
      .withIndex("by_donor", (q) => q.eq("donorId", donor._id))
      .take(500);
    const others = herGifts.filter((g) => g._id !== gift._id);
    const donorAfter = {
      name: donor.name,
      lifetimeCentsBefore: donor.lifetimeCents,
      lifetimeCentsAfter: Math.max(0, donor.lifetimeCents - gift.amountCents),
      giftCountBefore: donor.giftCount,
      giftCountAfter: Math.max(0, donor.giftCount - 1),
      otherGiftsKept: others.length,
      otherGiftCentsKept: others.reduce((a, g) => a + g.amountCents, 0),
    };
    if (donor.name.toLowerCase() !== COLLECTOR_NAME.toLowerCase()) {
      // Not fatal — the donor row is reached through the gift's own `donorId`,
      // so the identity is certain whatever the row is spelled. Worth saying
      // out loud all the same, because a surprise here means the guest list and
      // the donor record disagree about who forwarded the money.
      problems.push(
        `the gift's donor is "${donor.name}", not "${COLLECTOR_NAME}" — proceeding (the link is ` +
          `by id, not by name), but check that this is the collector.`,
      );
    }

    // ── 3. Already converted, but the gift is back? ──────────────────────────
    // Nothing should be able to produce this state — but if it exists, it is
    // the sync having resurrected the gift, which is the exact failure the
    // tombstone is there to prevent. Say so loudly rather than quietly
    // converting a second time.
    if (priorConversion) {
      problems.push(
        `a conversion record for ${GIVEBUTTER_TRANSACTION_ID} already exists (${priorConversion.convertedTo}) ` +
          `AND the gift is present. The gift was re-created after the conversion — remove it by ` +
          `hand through the gifts desk and check why the guard did not hold.`,
      );
      return nothing;
    }
    if (priorOrder) {
      problems.push(
        `ticket order ${TICKET_ORDER_REF} already exists alongside the gift — both are counting ` +
          `${usd(FORWARDED_CENTS)}. Nothing written; resolve by hand.`,
      );
      return nothing;
    }

    // ── 4. The write, all of it or none of it ────────────────────────────────
    const grossCents = ticketGrossCents();
    if (write) {
      // The tombstone goes in FIRST, so that at no point in the transaction's
      // ordering does a gift-less transaction id exist without the record that
      // explains it. (Convex mutations are atomic, so this is about
      // readability rather than crash-safety — but the ordering is the one a
      // reader would expect and there is no reason to invert it.)
      await ctx.db.insert("givebutterConvertedDonations", {
        externalRef: GIVEBUTTER_TRANSACTION_ID,
        amountCents: gift.amountCents,
        scope: chapter._id,
        eventId: page.eventId,
        convertedTo: `ticketOrders.externalRef=${TICKET_ORDER_REF}`,
        // THE NARRATIVE OUTLIVES THIS MODULE. `ptbVenmo2026.ts` and this runner
        // are one-time and get deleted once run; this row is permanent and is
        // the only place the reasoning survives. So it carries not just what
        // happened but the one judgement inside it — the 41st name — because a
        // future reader counting heads against the Cash App order will
        // otherwise have no way to find out why 41 rather than 40.
        reason:
          `${usd(gift.amountCents)} of Venmo ticket money for Pop The Balloon, collected by hand by ` +
          `${COLLECTOR_NAME} and forwarded to Givebutter as one payment on 2025-11-30. Recorded ` +
          `2026-08-09 as ${admissions} × ${usd(TICKET_PRICE_CENTS)} admissions instead of a personal ` +
          `gift from her. Book value is unchanged; only the layer and the attribution moved. ` +
          `40 admissions are the guest list's Platform=Venmo rows; the 41st is ` +
          `${RESOLVED_41ST_GUEST.name} (${RESOLVED_41ST_GUEST.handle}), whose platform column was ` +
          `blank — owner's decision, 2026-08-09, over Charisma Stevens (already a live admission on ` +
          `ptb:cashapp:2025-10) and Fancy. Do not re-import this transaction as a donation.`,
        convertedAt: Date.now(),
        convertedBy: recordedBy,
      });

      // Through the helper, never `ctx.db.delete` — see the module header for
      // the six rollups that hang off it, including the event's Given total
      // this gift is currently inflating.
      await removeGiftRow(ctx, gift._id);

      // A tier of its own for the Venmo rail (see the data module). Find-or-
      // create by name so a re-run after a partial hand-fix cannot mint a
      // second one. NEVER `isActive` — this is a historical record, not
      // something still on sale, and an inactive tier is also invisible to
      // `applyGivebutterTickets`'s native-tier matching.
      const now = Date.now();
      const siblings = await ctx.db
        .query("ticketTypes")
        .withIndex("by_event", (q) => q.eq("eventId", page.eventId))
        .take(TICKET_TYPE_SCAN_LIMIT);
      let ticketTypeId: Id<"ticketTypes"> | null =
        siblings.find((tt) => tt.name === VENMO_TYPE_NAME)?._id ?? null;
      if (ticketTypeId == null) {
        ticketTypeId = await ctx.db.insert("ticketTypes", {
          eventId: page.eventId,
          chapterId: chapter._id,
          name: VENMO_TYPE_NAME,
          description:
            `Tickets paid by Venmo to ${COLLECTOR_NAME}, who forwarded the ` +
            `collection to Givebutter as a single payment on 2025-11-30.`,
          priceCents: TICKET_PRICE_CENTS,
          currency: "usd",
          soldCount: admissions,
          sortOrder: 101,
          isActive: false,
          createdAt: now,
          updatedAt: now,
        });
      } else {
        const tier = await ctx.db.get(ticketTypeId);
        if (tier) {
          await ctx.db.patch(ticketTypeId, {
            soldCount: tier.soldCount + admissions,
            updatedAt: now,
          });
        }
      }

      await ctx.db.insert("ticketOrders", {
        eventId: page.eventId,
        chapterId: chapter._id,
        name: TICKET_ORDER_NAME,
        // `ticketOrders.email` is required and the Venmo payers gave none.
        // THE COLLECTOR'S OWN ADDRESS is the honest stand-in — the same rule
        // `cashAppBackfill.ts` applied, pointed at whoever actually collected
        // that rail's money. Forty-one invented addresses would be forty-one
        // fabricated contact records, which is precisely what `attendeeNames`
        // exists to avoid.
        email: COLLECTOR_EMAIL,
        // ONE LINE, not one per payer. `reconciliation.ts` renders an order's
        // detail as `quantity× name` joined across items, so 41 lines would
        // print a 41-clause sentence for one collection. The per-person detail
        // lives where the schema puts it: index-aligned `attendeeNames`, one
        // entry per admission.
        items: [
          {
            ticketTypeId,
            name: VENMO_TYPE_NAME,
            quantity: admissions,
            unitPriceCents: TICKET_PRICE_CENTS,
            attendeeNames: TICKET_ATTENDEE_NAMES,
          },
        ],
        totalCents: grossCents,
        currency: "usd",
        status: "paid",
        externalRef: TICKET_ORDER_REF,
        // The SAME instant the gift carried. The classification changed; the
        // date did not, and the reconciliation panel sorts earned revenue by
        // exactly this field — so the swap is date-neutral there too.
        createdAt: FORWARDED_AT_MS,
        updatedAt: now,
      });

      // Revenue up by the ticket money. Given has ALREADY come down by the
      // same amount inside `removeGiftRow`, so it is deliberately not touched
      // here — doing both would take $820 off the event twice.
      const current = (await ctx.db.get(page._id))!;
      await ctx.db.patch(page._id, {
        ticketsSoldCount: current.ticketsSoldCount + admissions,
        revenueCents: current.revenueCents + grossCents,
        updatedAt: now,
      });
    }

    return {
      dryRun: !write,
      proceeded: true,
      externalRef: GIVEBUTTER_TRANSACTION_ID,
      giftFound: true,
      giftCents: gift.amountCents,
      donor: donorAfter,
      conversionRecorded: true,
      ticketOrderCreated: true,
      ticketCents: grossCents,
      ticketAdmissions: admissions,
      transcribedAdmissions: TICKET_ATTENDEE_NAMES.filter(
        (n) => n !== RESOLVED_41ST_GUEST.name,
      ).length,
      eventRevenueDeltaCents: grossCents,
      eventGivenDeltaCents: -gift.amountCents,
      // Computed from the two sides this run actually moved, not asserted.
      bookValueDeltaCents: grossCents - gift.amountCents,
      problems,
    };
  },
});
