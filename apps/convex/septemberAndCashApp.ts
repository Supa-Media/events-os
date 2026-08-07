/**
 * Two corrections the owner's bank screenshots and guest list settled
 * (2026-08-07).
 *
 * ═══ 1. THE SEPTEMBER TRUIST GIFTS WERE THE WRONG AMOUNTS AND THE WRONG DAY ══
 *
 * The chain, from the owner's Truist statement:
 *   Sep 15 — TWO Zelle payments to Global Echo, $900 + $100, memo "Seyi Olujide
 *            – Public Worship Donation". THIS is the donation.
 *   Sep 17 — a separate $1,000 wire out to Global Echo c/o THREAD BANK (Relay's
 *            partner bank), which lands in Relay the same day as
 *            "1/OLUSEYI OLUJIDE". A second, distinct gift — already recorded
 *            correctly as `genesis:wire:2025-09-17` and already linked.
 *   Sep 19 — the ORG's Truist sends $500 + $500 into Relay as "ACH Add Funds".
 *            This is the Sep 15 money finally moving between two accounts the
 *            org owns. Not a gift; an internal transfer.
 *
 * The genesis import read the Sep 19 Relay credits as the gift, so the giving
 * ledger says Seyi gave $500 + $500 on Sep 19. He gave $900 + $100 on Sep 15.
 * The TOTAL was right, which is why book value never looked wrong — but a
 * donor's record and their acknowledgement letter are about amounts and dates,
 * and both were wrong.
 *
 * I got this twice before landing here: first proposing $900/$100 from the
 * Truist side alone, then RETRACTING it on seeing two $500 credits in Relay and
 * concluding the $500/$500 split was right. Both readings were partial. The
 * Relay credits and the Zelle payments are both real and both $1,000 — they are
 * the same money at two different stages, four days apart.
 *
 * SO: restate the gifts to what the donor actually gave, and mark the two Relay
 * credits as the internal transfer they are. `status:"excluded"` is what keeps
 * them out of book value (`signedBookCents` returns 0) now that they no longer
 * carry a gift link — the org's Truist is not a tracked account, so there is no
 * opposite leg to pair them with, and excluding with an explanation is honest
 * where inventing a phantom outflow would not be.
 *
 * Book value does not move: the same $1,000 of revenue, the same $0 from those
 * two rows. Only the donor record gets truer.
 *
 * ═══ 2. THE POP THE BALLOON CASH APP TICKETS WERE NEVER RECORDED ════════════
 *
 * 39 guests paid for Pop The Balloon by Cash App at $20 = $780, per the owner's
 * guest list. None of it is in the books: the Givebutter sync covers only what
 * went through Givebutter, and no Dec-2025 Cash App inflow exists in the ledger
 * (the single "Cash App" row is $174.87 dated 2026-08-07, unrelated).
 *
 * Recorded as TICKET ORDERS, not gifts. They were ticket purchases, and the
 * July CSV backfill's habit of booking PTB ticket sales as donations is exactly
 * what #533 spent the day unwinding — repeating it here would re-inflate giving
 * by $780 and understate the event.
 *
 * ONE order carrying 39 admissions rather than 39 orders. `ticketOrders.email`
 * is required, the guest list has no emails, and 39 rows with a placeholder
 * address would be 39 fabricated contact records — worse than none. The names
 * are preserved where they belong instead: `items[].attendeeNames`, which the
 * schema defines as index-aligned per-admission names for exactly this.
 *
 * BOOK VALUE WILL RISE $780 AGAINST NO BANK MOVEMENT, and that is the correct
 * outcome, not a bug: the event earned the money, and it is sitting in whoever
 * collected it rather than in an org account. The gap between book and bank is
 * the honest measure of that. When it does land, link the deposit to it the way
 * the Truist credits are handled above.
 *
 * Delete this module once run.
 */
import { internalMutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { NEW_YORK_CHAPTER_SLUG } from "./lib/seed/historical/mapping";
import { editGiftRow } from "./lib/givingDonors";

/** What the donor actually gave, from the Truist statement. */
const GIFT_RESTATEMENTS = [
  { externalRef: "genesis:truist:1", fromCents: 50000, toCents: 90000 },
  { externalRef: "genesis:truist:2", fromCents: 50000, toCents: 10000 },
] as const;

/** 2025-09-15 12:00 UTC — the day both Zelle payments left Truist. */
const ZELLE_DAY_MS = Date.UTC(2025, 8, 15, 12, 0, 0);

const ZELLE_NOTE =
  "Zelle to Global Echo Charitable Organization, memo \"Seyi Olujide – Public Worship Donation\". " +
  "Reached Relay on 2025-09-19 as two $500 ACH credits from the org's Truist account — those credits " +
  "are the internal transfer of this gift, not a second gift.";

/** The two Relay credits that are the org moving its own money. */
const INTERNAL_TRANSFER_DAY = "2025-09-19";
const INTERNAL_TRANSFER_CENTS = 50000;
const INTERNAL_TRANSFER_NOTE =
  "Internal transfer: the org's Truist account moving the 2025-09-15 Zelle gifts into Relay. " +
  "Excluded from book value because the money is already counted as those gifts — the Truist " +
  "account is not tracked in this ledger, so there is no opposite leg to pair this with.";

const PTB_PAGE_SLUG = "pop-the-balloon";
const CASH_APP_TICKET_CENTS = 2000;
const CASH_APP_TYPE_NAME = "Audience Ticket (paid outside Givebutter)";
const CASH_APP_ORDER_REF = "ptb:cashapp:2025-12";
/** From the owner's guest list: Platform = Cash App, payment verified, less
 *  Charisma (listed as Cash App but the Venmo collector — her $820 lump is
 *  already recorded as a Givebutter donation). */
const CASH_APP_ATTENDEES = [
  "KylaY", "Dami", "Shannon Marshall", "Chima", "Faith Holmes", "Lilo Matos",
  "Anaïka Bien-aime", "Stephanie", "Nerely Matos", "Styve Lekane",
  "Linn Desmarais", "Jasmine", "Christie Jean Louis", "Marie G", "Shania",
  "Gozienna Okeke", "Aliah Kimbro", "Faith", "Chris Haris", "Miguel Brown",
  "Sayo Bless", "Melissa Pierre", "Chavyn Jaice", "Tony", "Rosa C",
  "Britney Merlain", "Kanika", "Jatee", "Angel Davis", "Jade",
  "Ashley Sarah Eliassaint", "Esther", "Neema", "Zipporah", "Archelle",
  "Jenny", "Seyi", "Shaina Brown", "Sherika",
];
/** 2025-12-07 — the second and main day of the event. */
const PTB_SOLD_AT = Date.UTC(2025, 11, 7, 12, 0, 0);

export const runSeptemberAndCashApp = internalMutation({
  args: {
    /** Stamped on the restated gifts as `editedBy` — a money correction leaves
     *  an attributable trail. Passed in because this runs from the CLI, which
     *  carries the deployment admin key and has no session to derive it from. */
    editedBy: v.id("users"),
    execute: v.optional(v.boolean()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    giftsRestated: v.number(),
    creditsExcluded: v.number(),
    cashAppOrderCreated: v.boolean(),
    cashAppCents: v.number(),
    cashAppTickets: v.number(),
    problems: v.array(v.string()),
  }),
  handler: async (ctx, { editedBy, execute }) => {
    const write = execute ?? false;
    const problems: string[] = [];

    const chapter = await ctx.db
      .query("chapters")
      .withIndex("by_slug", (q) => q.eq("slug", NEW_YORK_CHAPTER_SLUG))
      .first();
    if (!chapter) {
      throw new ConvexError({ code: "NO_CHAPTER", message: "NY chapter not found." });
    }

    // ── 1a. Restate the two gifts ───────────────────────────────────────────
    let giftsRestated = 0;
    for (const r of GIFT_RESTATEMENTS) {
      const gift = await ctx.db
        .query("gifts")
        .withIndex("by_externalRef", (q) => q.eq("externalRef", r.externalRef))
        .first();
      if (!gift) {
        problems.push(`${r.externalRef}: not found`);
        continue;
      }
      if (gift.amountCents === r.toCents) continue; // already restated
      if (gift.amountCents !== r.fromCents) {
        problems.push(
          `${r.externalRef}: expected ${r.fromCents}¢, found ${gift.amountCents}¢ — SKIPPED`,
        );
        continue;
      }
      if (write) {
        // Drop the bank link FIRST: `editGiftRow` locks a system-written gift
        // (one carrying `transactionId`) against money edits, and this gift now
        // points at a credit that is an internal transfer rather than its
        // arrival. Clearing it is the correction, not a workaround.
        await ctx.db.patch(gift._id, { transactionId: undefined });
        await editGiftRow(ctx, {
          giftId: gift._id,
          amountCents: r.toCents,
          receivedAt: ZELLE_DAY_MS,
          method: "zelle",
          note: ZELLE_NOTE,
          editedBy,
        });
      }
      giftsRestated += 1;
    }

    // ── 1b. Exclude the two Relay credits ───────────────────────────────────
    const credits = (
      await ctx.db
        .query("transactions")
        .withIndex("by_chapter_and_postedAt", (q) => q.eq("chapterId", chapter._id))
        .take(6000)
    ).filter(
      (t) =>
        t.flow === "inflow" &&
        t.amountCents === INTERNAL_TRANSFER_CENTS &&
        new Date(t.postedAt).toISOString().slice(0, 10) === INTERNAL_TRANSFER_DAY,
    );
    if (credits.length !== 2) {
      problems.push(
        `expected 2 credits of $500 on ${INTERNAL_TRANSFER_DAY}, found ${credits.length} — SKIPPED`,
      );
    }
    let creditsExcluded = 0;
    if (credits.length === 2) {
      for (const c of credits) {
        if (c.status === "excluded") continue;
        if (write) {
          await ctx.db.patch(c._id, {
            status: "excluded",
            note: INTERNAL_TRANSFER_NOTE,
          });
        }
        creditsExcluded += 1;
      }
    }

    // ── 2. The Cash App tickets ─────────────────────────────────────────────
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
    const existingOrder = await ctx.db
      .query("ticketOrders")
      .withIndex("by_external_ref", (q) => q.eq("externalRef", CASH_APP_ORDER_REF))
      .unique();

    const cashAppTickets = CASH_APP_ATTENDEES.length;
    const cashAppCents = cashAppTickets * CASH_APP_TICKET_CENTS;
    let cashAppOrderCreated = false;
    if (!existingOrder) {
      cashAppOrderCreated = true;
      if (write) {
        const now = Date.now();
        // A NATIVE tier, not a Givebutter mirror: this money never touched
        // Givebutter, and reusing a mirror type would attribute it to a
        // provider that never saw it. Inactive because it is a historical
        // record, not something still on sale.
        const ticketTypeId = await ctx.db.insert("ticketTypes", {
          eventId: page.eventId,
          chapterId: chapter._id,
          name: CASH_APP_TYPE_NAME,
          description:
            "Tickets collected by Cash App at the door / in advance, recorded from the guest list.",
          priceCents: CASH_APP_TICKET_CENTS,
          currency: "usd",
          soldCount: cashAppTickets,
          sortOrder: 100,
          isActive: false,
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("ticketOrders", {
          eventId: page.eventId,
          chapterId: chapter._id,
          name: "Pop The Balloon — Cash App collections",
          email: "seyi@publicworship.life",
          items: [
            {
              ticketTypeId,
              name: CASH_APP_TYPE_NAME,
              quantity: cashAppTickets,
              unitPriceCents: CASH_APP_TICKET_CENTS,
              attendeeNames: CASH_APP_ATTENDEES,
            },
          ],
          totalCents: cashAppCents,
          currency: "usd",
          status: "paid",
          externalRef: CASH_APP_ORDER_REF,
          createdAt: PTB_SOLD_AT,
          updatedAt: now,
        });
        await ctx.db.patch(page._id, {
          ticketsSoldCount: page.ticketsSoldCount + cashAppTickets,
          revenueCents: page.revenueCents + cashAppCents,
          updatedAt: now,
        });
      }
    }

    return {
      dryRun: !write,
      giftsRestated,
      creditsExcluded,
      cashAppOrderCreated,
      cashAppCents,
      cashAppTickets,
      problems,
    };
  },
});
