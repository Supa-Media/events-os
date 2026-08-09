/**
 * One-time: record a year of Cash App money the books never saw (2026-08-09).
 *
 * The org has collected through Cash App since October 2025 and recorded none of
 * the payments. Only the three BANK WITHDRAWALS reached the ledger, as
 * undifferentiated cash. So today there are donors with no gift rows and
 * therefore no acknowledgement letters, $900 of Pop The Balloon ticket revenue
 * attributed to nobody, and merch and snack money that never reached the sales
 * layer. `lib/seed/historical/cashApp2026.ts` holds the transcription and the
 * reasoning behind every judgement; this runs it.
 *
 * Four things get recorded, in the layer each one belongs to:
 *
 *   1. 40 October payments → ONE Pop The Balloon ticket order, $900 / 45
 *      admissions, REPLACING the $780 / 39-admission estimate built from the
 *      Partiful guest list (owner decision, 2026-08-09).
 *   2. Six gifts, $440, through `matchOrCreateDonor` + `recordGiftForDonor`.
 *   3. Three sales, $37, on the `sales` table.
 *   4. The Cash App fee on each cohort, $43.15 total, as a real expense.
 *
 * ── THE DOUBLE-COUNT THIS EXISTS TO AVOID ───────────────────────────────────
 * Revenue is counted at the giving/ticketing/sales layer, and the ledger row
 * where that same money ARRIVES in a bank account must therefore contribute
 * nothing (`lib/bookBalance.ts#signedBookCents` returns 0 for an inflow carrying
 * `payoutProcessor`). Two of the three Cash App withdrawals already carry that
 * label. The third — $174.87, posted 2026-08-07, description "Cash App" — does
 * not, and is counting as ordinary income right now.
 *
 * Recording the payments underneath it while it stays unlabelled would book the
 * same $174.87 twice. So the label is part of THIS change, not a follow-up:
 * exactly the error `markPtbPayout.ts` fixed for the Stripe payout, on the other
 * rail.
 *
 * And the runner will not write revenue it cannot prove is un-double-counted.
 * Before anything is inserted it resolves all three withdrawals in the ledger
 * and labels any that are unlabelled; if any one of them cannot be resolved to
 * exactly one row, NOTHING is written and the reason is reported. A missing
 * withdrawal means the cash side is not what the transcription assumed, and
 * adding revenue on top of an assumption that has already failed is how a
 * reconciliation gets worse instead of better. That gate has already earned its
 * keep: the first production dry run refused, because the third withdrawal is on
 * CENTRAL's book rather than New York's (see the lookup below).
 *
 * ── THE ARITHMETIC IS CHECKED, NOT ASSERTED ─────────────────────────────────
 * Each cohort's payments less its fee must equal its withdrawal, to the cent:
 *
 *     $900.00 − $29.40 = $870.60   posted 2025-11-06, New York
 *     $297.00 −  $8.62 = $288.38   posted 2026-01-06, New York
 *     $180.00 −  $5.13 = $174.87   posted 2026-08-07, Central
 *
 * `cohortReconciles` recomputes that from the transcribed rows themselves, the
 * unit suite asserts it, and this runner re-checks it against the LIVE
 * withdrawal amounts before writing — a ledger row that disagrees with the
 * transcription stops the run.
 *
 * Book value rises $378.98. The cash side says the same number from independent
 * figures: $1,333.85 withdrawn, of which $954.87 was already booked (the $780
 * estimate plus the $174.87 unlabelled credit).
 *
 * NOTHING IS WRITTEN ON A PATTERN. Every row this touches is re-verified against
 * the amount in the data module first, and a row that disagrees is REPORTED in
 * `problems` and skipped — the standing rule since a real $500 deposit was
 * deleted earlier in this reconciliation for matching a duplicate's amount and
 * date. Gifts go through the giving helpers rather than `ctx.db.insert`, because
 * donor lifetime totals, scope rollups, donor status, cross-chapter identity and
 * the territory launch pot all hang off them.
 *
 * `execute` omitted / false = a zero-write dry run that reports exactly what a
 * real run would do. Delete this module once run.
 */
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import { CENTRAL, effectiveBudgetApprovalStatus } from "@events-os/shared";
import { NEW_YORK_CHAPTER_SLUG } from "./lib/seed/historical/mapping";
import {
  findDonorInScope,
  matchOrCreateDonor,
  recordGiftForDonor,
} from "./lib/givingDonors";
import {
  COHORTS,
  ESTIMATED_ORDER_ADMISSIONS,
  ESTIMATED_ORDER_CENTS,
  ESTIMATED_ORDER_REF,
  GIFTS,
  PTB_PAGE_SLUG,
  SALES,
  TICKET_ADMISSIONS,
  TICKET_ATTENDEE_NAMES,
  TICKET_GROSS_CENTS,
  TICKET_ORDER_DAY,
  TICKET_ORDER_REF,
  TICKET_PRICE_CENTS,
  WITHDRAWAL_MATCH_WINDOW_DAYS,
  type Cohort,
  withdrawalWindow,
  cohortGrossCents,
  cohortFeeCents,
  cohortPaymentCount,
  paymentFeeCents,
  utcNoon,
} from "./lib/seed/historical/cashApp2026";

/** The ticket tier the replaced order already uses — reused, not duplicated. */
const CASH_APP_TYPE_NAME = "Audience Ticket (paid outside Givebutter)";
/** `ticketOrders.email` is required and the payers gave none. The collector's
 *  own address is the honest stand-in: 40 invented addresses would be 40
 *  fabricated contact records, which is what `attendeeNames` exists to avoid. */
const COLLECTOR_EMAIL = "seyi@publicworship.life";

/** Every book money can sit on: central plus the chapters. A handful today. */
const SCOPE_SCAN_LIMIT = 200;
/** One book's rows inside a five-day window — tens, not thousands. */
const WINDOW_SCAN_LIMIT = 500;

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** One withdrawal as this run found it. */
type ResolvedWithdrawal = {
  cohort: Cohort;
  row: Doc<"transactions">;
  /** True when this run had to add the `payoutProcessor` label itself. */
  labelledNow: boolean;
};

const withdrawalReport = v.object({
  cohort: v.string(),
  amountCents: v.number(),
  postedDay: v.string(),
  /** Which book the cash actually landed on — New York for the Relay era,
   *  Central for the Increase era. Reported because it is the fact that made
   *  the first version of this runner miss a withdrawal entirely. */
  book: v.string(),
  alreadyLabelled: v.boolean(),
  labelledNow: v.boolean(),
});

/**
 * What happened to each donor name — the answer to "are we merging into the
 * people we already have, or quietly making duplicates?"
 *
 * Reported per RUN rather than assumed from the data module, because the answer
 * depends on the live donor table and is the single thing most worth eyeballing
 * before `execute: true`. A dry run prints it without writing anything.
 */
const donorReport = v.object({
  donor: v.string(),
  /** True = joined a donor already in this scope; false = a new record. */
  matchedExisting: v.boolean(),
  /** The matched donor's lifetime BEFORE this run, for recognising the person. */
  existingLifetimeCents: v.number(),
  giftCents: v.number(),
});

const cohortReport = v.object({
  cohort: v.string(),
  grossCents: v.number(),
  feeCents: v.number(),
  withdrawalCents: v.number(),
  /** gross − fee === withdrawal. False anywhere means the run refused to write. */
  reconciles: v.boolean(),
});

export const runCashAppBackfill = internalMutation({
  args: {
    /** Stamped on the gifts as `recordedBy` — a money entry leaves an
     *  attributable trail. Passed in because this runs from the CLI, which
     *  carries the deployment admin key and has no session to derive it from. */
    recordedBy: v.id("users"),
    execute: v.optional(v.boolean()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    /** False when a withdrawal could not be resolved — nothing was written. */
    proceeded: v.boolean(),
    withdrawals: v.array(withdrawalReport),
    cohorts: v.array(cohortReport),
    estimatedOrderRemoved: v.boolean(),
    ticketOrderCreated: v.boolean(),
    ticketCents: v.number(),
    ticketAdmissions: v.number(),
    giftsRecorded: v.number(),
    giftCents: v.number(),
    /** Per donor name: merged into an existing record, or opened a new one. */
    donors: v.array(donorReport),
    salesRecorded: v.number(),
    saleCents: v.number(),
    feeRowsWritten: v.number(),
    feeCents: v.number(),
    /** The book-value change this run accounts for, in cents. */
    bookValueDeltaCents: v.number(),
    /** Anything that disagreed with the data module — skipped, never guessed. */
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

    // ── 0. The withdrawals — the gate on everything else ─────────────────────
    //
    // SEARCHED ACROSS BOOKS, NOT WITHIN NEW YORK. The revenue is New York's and
    // every row this backfill writes is New-York-scoped — but where the CASH
    // landed is a separate question, and the answer changed when the banking
    // did:
    //
    //     $870.60  2025-11-06  New York  relay_csv
    //     $288.38  2026-01-06  New York  relay_csv
    //     $174.87  2026-08-07  CENTRAL   increase_ach
    //
    // The two older sweeps arrived through Relay while Relay was the operating
    // bank and were imported against New York. The newest arrived in Increase,
    // and every payout lands in central's account — that is the premise the
    // whole balance-settlement model rests on. So Cash App withdrawals genuinely
    // change books when the banking changes, and a scope-pinned search silently
    // misses whichever era it is not looking at. The first version of this
    // scanned New York only and reported the third withdrawal as missing.
    //
    // This is a widening of WHERE to look, not of what counts as a match.
    // Widening the scan widens the chance of a same-amount collision, so the
    // "exactly one, org-wide" requirement matters MORE here than it did on one
    // book: two matches still refuses rather than picking one.
    //
    // Bounded by a DATE WINDOW off the Cash App feed's own date rather than an
    // unbounded scan — banks post one to two days after initiation, so the day
    // itself is not a reliable key while a few days around it is (see
    // `WITHDRAWAL_MATCH_WINDOW_DAYS`).
    const allChapters = await ctx.db.query("chapters").take(SCOPE_SCAN_LIMIT);
    const scopes: (Id<"chapters"> | typeof CENTRAL)[] = [
      CENTRAL,
      ...allChapters.map((c) => c._id),
    ];
    const scopeName = new Map<string, string>([
      [CENTRAL, "Central"],
      ...allChapters.map((c) => [c._id as string, c.name] as const),
    ]);

    const resolved: ResolvedWithdrawal[] = [];
    const withdrawals: {
      cohort: string;
      amountCents: number;
      postedDay: string;
      book: string;
      alreadyLabelled: boolean;
      labelledNow: boolean;
    }[] = [];
    for (const cohort of COHORTS) {
      const { fromMs, toMs } = withdrawalWindow(cohort);
      const matches: Doc<"transactions">[] = [];
      for (const scope of scopes) {
        const rows = await ctx.db
          .query("transactions")
          .withIndex("by_chapter_and_postedAt", (q) =>
            q.eq("chapterId", scope).gte("postedAt", fromMs).lte("postedAt", toMs),
          )
          .take(WINDOW_SCAN_LIMIT);
        matches.push(
          ...rows.filter(
            (t) => t.flow === "inflow" && t.amountCents === cohort.withdrawalCents,
          ),
        );
      }
      if (matches.length !== 1) {
        problems.push(
          `${cohort.key}: expected exactly 1 inflow of ${usd(cohort.withdrawalCents)} ` +
            `org-wide between ${cohort.initiatedDay} and ${cohort.initiatedDay} + ` +
            `${WITHDRAWAL_MATCH_WINDOW_DAYS}d (the withdrawal to ${cohort.destination}, ` +
            `last seen on ${cohort.landedOn}), found ${matches.length} — SKIPPED`,
        );
        continue;
      }
      const row = matches[0];
      const gross = cohortGrossCents(cohort.key);
      if (gross - cohortFeeCents(cohort.key) !== row.amountCents) {
        problems.push(
          `${cohort.key}: ${usd(gross)} gross less ${usd(cohortFeeCents(cohort.key))} fee is ` +
            `${usd(gross - cohortFeeCents(cohort.key))}, but the ledger row is ${usd(row.amountCents)} — SKIPPED`,
        );
        continue;
      }
      const alreadyLabelled = row.payoutProcessor != null;
      resolved.push({ cohort, row, labelledNow: !alreadyLabelled });
      withdrawals.push({
        cohort: cohort.key,
        amountCents: row.amountCents,
        postedDay: new Date(row.postedAt).toISOString().slice(0, 10),
        book: scopeName.get(row.chapterId) ?? String(row.chapterId),
        alreadyLabelled,
        labelledNow: !alreadyLabelled,
      });
    }

    const cohorts = COHORTS.map((c) => ({
      cohort: c.key,
      grossCents: cohortGrossCents(c.key),
      feeCents: cohortFeeCents(c.key),
      withdrawalCents: c.withdrawalCents,
      reconciles: cohortGrossCents(c.key) - cohortFeeCents(c.key) === c.withdrawalCents,
    }));

    // ALL OR NOTHING. Each cohort's revenue is only safe to record because its
    // withdrawal is known to contribute zero; recording two cohorts while the
    // third's withdrawal is unaccounted for would leave the books in a state
    // nobody planned and nobody can read. A dry run reports the same problems,
    // so diagnosing this costs nothing.
    const proceeded = resolved.length === COHORTS.length;
    if (!proceeded) {
      problems.push(
        `${resolved.length}/${COHORTS.length} withdrawals resolved — refusing to record ` +
          `revenue whose bank arrival is not accounted for. Nothing was written.`,
      );
      return {
        dryRun: !write,
        proceeded: false,
        withdrawals,
        cohorts,
        estimatedOrderRemoved: false,
        ticketOrderCreated: false,
        ticketCents: 0,
        ticketAdmissions: 0,
        giftsRecorded: 0,
        giftCents: 0,
        donors: [],
        salesRecorded: 0,
        saleCents: 0,
        feeRowsWritten: 0,
        feeCents: 0,
        bookValueDeltaCents: 0,
        problems,
      };
    }

    // A labelled payout deposit is the cash arrival of revenue counted at the
    // giving/ticketing/sales layer, so it contributes 0 to book value. Doing
    // this FIRST means the revenue below is never momentarily double-counted.
    let unlabelledIncomeRemovedCents = 0;
    for (const { cohort, row, labelledNow } of resolved) {
      if (!labelledNow) continue;
      unlabelledIncomeRemovedCents += row.amountCents;
      if (write) {
        await ctx.db.patch(row._id, {
          payoutProcessor: "other",
          status: "reconciled",
          note:
            `Cash App withdrawal to ${cohort.destination}: ${usd(cohortGrossCents(cohort.key))} ` +
            `collected (${cohort.label}) less ${usd(cohortFeeCents(cohort.key))} of Cash App business fees. ` +
            `Labelled a payout so the money is counted once — at the gifts, tickets and sales ` +
            `it is made of, which the 2026-08-09 Cash App backfill recorded.`,
        });
      }
    }

    // ── 1. The Pop The Balloon tickets ───────────────────────────────────────
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

    const alreadyRecorded = await ctx.db
      .query("ticketOrders")
      .withIndex("by_external_ref", (q) => q.eq("externalRef", TICKET_ORDER_REF))
      .unique();
    const estimate = await ctx.db
      .query("ticketOrders")
      .withIndex("by_external_ref", (q) => q.eq("externalRef", ESTIMATED_ORDER_REF))
      .unique();

    let estimatedOrderRemoved = false;
    let ticketOrderCreated = false;
    let ticketDeltaCents = 0;
    let ticketDeltaAdmissions = 0;

    if (alreadyRecorded) {
      // A second run. Nothing to do — and deliberately no attempt to "fix" the
      // estimate a second time: if it is still present alongside the real order
      // that is a state a human needs to see, not one to silently resolve.
      if (estimate) {
        problems.push(
          `${ESTIMATED_ORDER_REF} still present alongside ${TICKET_ORDER_REF} — both orders ` +
            `are counting. Remove the estimate by hand.`,
        );
      }
    } else {
      // Reuse the estimate's own ticket tier rather than minting a second one:
      // it is the same tier ("tickets paid for outside Givebutter"), the price
      // is unchanged at $20, and two tiers for one thing would split every
      // per-tier report of this event forever.
      let ticketTypeId: Id<"ticketTypes"> | null = null;
      let estimateUsable = true;

      if (estimate) {
        const admissions = estimate.items.reduce((a, i) => a + i.quantity, 0);
        if (
          estimate.totalCents !== ESTIMATED_ORDER_CENTS ||
          admissions !== ESTIMATED_ORDER_ADMISSIONS
        ) {
          problems.push(
            `${ESTIMATED_ORDER_REF}: expected ${usd(ESTIMATED_ORDER_CENTS)} / ` +
              `${ESTIMATED_ORDER_ADMISSIONS} admissions, found ${usd(estimate.totalCents)} / ` +
              `${admissions} — SKIPPED (tickets not recorded)`,
          );
          estimateUsable = false;
        } else {
          ticketTypeId = estimate.items[0]?.ticketTypeId ?? null;
        }
      } else {
        // The estimate was never written to this deployment. Recording the real
        // money is still right; there is simply nothing to replace.
        problems.push(
          `${ESTIMATED_ORDER_REF}: not found — recording the real payments with nothing to ` +
            `replace. Ticket revenue rises by the full ${usd(TICKET_GROSS_CENTS)}, not ` +
            `${usd(TICKET_GROSS_CENTS - ESTIMATED_ORDER_CENTS)}.`,
        );
      }

      if (estimateUsable) {
        ticketDeltaCents = TICKET_GROSS_CENTS - (estimate ? ESTIMATED_ORDER_CENTS : 0);
        ticketDeltaAdmissions =
          TICKET_ADMISSIONS - (estimate ? ESTIMATED_ORDER_ADMISSIONS : 0);
        ticketOrderCreated = true;
        estimatedOrderRemoved = estimate != null;

        if (write) {
          const now = Date.now();
          if (estimate) await ctx.db.delete(estimate._id);
          if (ticketTypeId == null) {
            ticketTypeId = await ctx.db.insert("ticketTypes", {
              eventId: page.eventId,
              chapterId: chapter._id,
              name: CASH_APP_TYPE_NAME,
              description:
                "Tickets paid for by Cash App, recorded from the payment feed (2026-08-09).",
              priceCents: TICKET_PRICE_CENTS,
              currency: "usd",
              soldCount: TICKET_ADMISSIONS,
              sortOrder: 100,
              isActive: false,
              createdAt: now,
              updatedAt: now,
            });
          } else {
            const tier = await ctx.db.get(ticketTypeId);
            if (tier) {
              await ctx.db.patch(ticketTypeId, {
                soldCount: tier.soldCount - ESTIMATED_ORDER_ADMISSIONS + TICKET_ADMISSIONS,
                updatedAt: now,
              });
            }
          }
          await ctx.db.insert("ticketOrders", {
            eventId: page.eventId,
            chapterId: chapter._id,
            name: "Pop The Balloon — Cash App ticket payments (October 2025)",
            email: COLLECTOR_EMAIL,
            // ONE LINE, not one per payment. `reconciliation.ts` renders an
            // order's detail as `quantity× name` joined across items, so 40
            // lines would print a 40-clause sentence for one collection. The
            // per-payer detail lives where the schema puts it — index-aligned
            // `attendeeNames`, one entry per admission.
            items: [
              {
                ticketTypeId,
                name: CASH_APP_TYPE_NAME,
                quantity: TICKET_ADMISSIONS,
                unitPriceCents: TICKET_PRICE_CENTS,
                attendeeNames: TICKET_ATTENDEE_NAMES,
              },
            ],
            totalCents: TICKET_GROSS_CENTS,
            currency: "usd",
            status: "paid",
            externalRef: TICKET_ORDER_REF,
            createdAt: utcNoon(TICKET_ORDER_DAY),
            updatedAt: now,
          });
          // The page's rollups move by the NET delta, so a run that replaced the
          // estimate and one that found none both leave the page consistent.
          await ctx.db.patch(page._id, {
            ticketsSoldCount: page.ticketsSoldCount + ticketDeltaAdmissions,
            revenueCents: page.revenueCents + ticketDeltaCents,
            updatedAt: now,
          });
        }
      }
    }

    // ── 2. The gifts ─────────────────────────────────────────────────────────
    // The 40 ticket payers are NOT donors and never touch this table — a ticket
    // buyer bought a ticket. Only the five gift donors below can match or create
    // a `donors` row, which is why the duplicate-donor surface of this whole
    // backfill is five names rather than forty-five.
    let giftsRecorded = 0;
    let giftCents = 0;
    const donorMatches = new Map<
      string,
      { donor: string; matchedExisting: boolean; existingLifetimeCents: number; giftCents: number }
    >();
    for (const g of GIFTS) {
      const existing = await ctx.db
        .query("gifts")
        .withIndex("by_externalRef", (q) => q.eq("externalRef", g.externalRef))
        .first();
      if (existing) continue; // a second run

      // Resolved BEFORE the write so a dry run reports the same answer a real
      // run will act on. `findDonorInScope` is the very function
      // `matchOrCreateDonor` uses, called read-only — asking it rather than
      // re-implementing its rule is what keeps the report honest if that rule
      // ever changes. These gifts carry no email and no phone, so the name is
      // the only key it has to work with.
      const priorDonor = await findDonorInScope(ctx, chapter._id, { name: g.donor });
      const slot = donorMatches.get(g.donor) ?? {
        donor: g.donor,
        matchedExisting: priorDonor != null,
        existingLifetimeCents: priorDonor?.lifetimeCents ?? 0,
        giftCents: 0,
      };
      slot.giftCents += g.amountCents;
      donorMatches.set(g.donor, slot);

      giftsRecorded += 1;
      giftCents += g.amountCents;
      if (write) {
        const donorId = await matchOrCreateDonor(ctx, {
          scope: chapter._id,
          name: g.donor,
          source: "manual",
        });
        await recordGiftForDonor(ctx, {
          donorId,
          amountCents: g.amountCents,
          receivedAt: utcNoon(g.day),
          method: "cash_app",
          externalRef: g.externalRef,
          recordedBy,
          note:
            `Cash App payment on ${g.day}, memo "${g.memo}". Recorded 2026-08-09 from the ` +
            `owner's Cash App activity screenshots; settled to the bank in the ` +
            `${usd(COHORTS.find((c) => c.key === g.cohort)!.withdrawalCents)} withdrawal of ` +
            `${COHORTS.find((c) => c.key === g.cohort)!.ledgerDay}.`,
        });
      }
    }

    // ── 3. The sales ─────────────────────────────────────────────────────────
    let salesRecorded = 0;
    let saleCents = 0;
    for (const s of SALES) {
      const existing = await ctx.db
        .query("sales")
        .withIndex("by_external_ref", (q) => q.eq("externalRef", s.externalRef))
        .first();
      if (existing) continue; // a second run
      salesRecorded += 1;
      saleCents += s.amountCents;
      if (write) {
        await ctx.db.insert("sales", {
          chapterId: chapter._id,
          ...(s.attachToPtb ? { eventId: page.eventId } : {}),
          externalRef: s.externalRef,
          soldAt: utcNoon(s.day),
          grossCents: s.amountCents,
          // The fee Cash App took on THIS payment: 2.6% + $0.15, so 25¢ of a $4
          // bag of snacks. The schema says a sale's fee is read, never derived —
          // that rule exists because an earlier attempt inferred fees by
          // subtracting recorded revenue from banked deposits, which measures
          // "fees minus unrecorded sales" rather than fees. This is not that: the
          // formula comes off two of Cash App's own payment-detail screens and
          // reproduces all three withdrawals to the cent, which is as close to
          // reading it as a rail with no API allows.
          //
          // It does NOT double-count against the ledger fee row below. Book value
          // counts a sale's GROSS (`reconciliation.ts#accountBalances`) and takes
          // the expense from the ledger; this field feeds the sales page's net
          // column and nothing else.
          feeCents: paymentFeeCents(s.amountCents),
          items: s.items,
          itemSource: s.itemSource,
          channel: "in_person",
          createdAt: Date.now(),
        });
      }
    }

    // ── 4. The Cash App fees, as an expense ──────────────────────────────────
    // Following `processorFees.ts`: revenue is recorded GROSS everywhere in this
    // codebase, so the processor's cut has to appear as a real expense or book
    // value silently overstates by it. Same shape as the Stripe fee rows — a
    // manual outflow coded to Bank & Fees, keyed on an `externalId` so a re-run
    // updates rather than duplicates.
    //
    // THE FEE IS COMPUTED PER PAYMENT AND BOOKED PER COHORT, and those are two
    // different decisions. Cash App charges 2.6% + $0.15 on EVERY payment (read
    // off two of the owner's payment-detail screens — see the data module), so
    // `cohortFeeCents` derives each cohort's figure by summing its rows: the
    // arithmetic is visible line by line and a reader can check any single $20
    // ticket at 67¢.
    //
    // ON NEW YORK'S BOOK, even for the cohort whose cash landed on Central. The
    // expense belongs where the revenue is: New York earned the $180 and New
    // York bore the $5.13 it cost to collect it. That central holds the cash is
    // a custody fact, and the balance-settlement model is what squares custody
    // with ownership — booking the fee against central instead would make
    // central look $5.13 worse off for money it never earned.
    //
    // The LEDGER rows stay at cohort granularity — three, not forty-nine —
    // following `processorFees.ts`'s monthly precedent and for its reason: the
    // fee is a cost of the rail, not a decision anyone makes per transaction,
    // and fifty sub-dollar rows would bury the reconcile grid in entries nobody
    // codes or reads. The cohort rather than the month, because two of the three
    // withdrawals sweep payments from more than one month, so a monthly split
    // would be a number we invented. Each row is dated on its own withdrawal, so
    // the fee sits beside the money it was taken from.
    const category = (
      await ctx.db
        .query("budgetCategories")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapter._id))
        .collect()
    ).find((c) => c.name === "Bank & Fees");
    if (!category) {
      problems.push(
        `no "Bank & Fees" budget category on the NY chapter — fee rows will be uncoded`,
      );
    }

    // Looked up one at a time on `by_external_id` rather than by scanning a
    // book — three point reads, and it finds an existing fee row wherever it
    // sits, which matters now that the withdrawals are not all on one book.
    const priorFeeRows = new Map<string, Doc<"transactions">>();
    for (const c of COHORTS) {
      const prior = await ctx.db
        .query("transactions")
        .withIndex("by_external_id", (q) => q.eq("externalId", c.feeExternalId))
        .first();
      if (prior) priorFeeRows.set(c.feeExternalId, prior);
    }
    let feeRowsWritten = 0;
    let feeCents = 0;
    // What the fee rows move book value by THIS run — which on a second run is
    // zero, even though `feeCents` still reports the $43.15 the backfill
    // accounts for in total. Keeping the two apart is what makes
    // `bookValueDeltaCents` mean "what this run changed" rather than "what the
    // backfill would change from nothing".
    let feeDeltaCents = 0;
    for (const { cohort, row } of resolved) {
      const note =
        `Cash App business fee on the ${cohort.ledgerDay} withdrawal to ${cohort.destination}: ` +
        `${usd(cohortGrossCents(cohort.key))} collected (${cohort.label}) less ` +
        `${usd(cohortFeeCents(cohort.key))} arrived as ${usd(cohort.withdrawalCents)}. ` +
        `Cash App charges 2.6% + $0.15 on every payment (confirmed from the payment-detail ` +
        `screens: $50.00 → $1.45, $100.00 → $2.75), so this is the sum of the fees on this ` +
        `cohort's ${cohortPaymentCount(cohort.key)} payments — booked as one row because the ` +
        `fee is a cost of the rail, not a per-payment decision. It reproduces the withdrawal ` +
        `to the cent, so nothing here is unexplained. Revenue is recorded gross, which is why ` +
        `this has to appear as a real expense rather than a haircut on what was given.`;

      const prior = priorFeeRows.get(cohort.feeExternalId);
      feeCents += cohortFeeCents(cohort.key);
      if (prior) {
        if (
          prior.amountCents === cohortFeeCents(cohort.key) &&
          prior.postedAt === row.postedAt &&
          prior.note === note
        ) {
          continue;
        }
        if (write) {
          await ctx.db.patch(prior._id, {
            amountCents: cohortFeeCents(cohort.key),
            postedAt: row.postedAt,
            note,
          });
        }
        feeDeltaCents += cohortFeeCents(cohort.key) - prior.amountCents;
        feeRowsWritten += 1;
        continue;
      }
      feeRowsWritten += 1;
      feeDeltaCents += cohortFeeCents(cohort.key);
      if (write) {
        await ctx.db.insert("transactions", {
          chapterId: chapter._id,
          source: "manual",
          flow: "outflow",
          amountCents: cohortFeeCents(cohort.key),
          currency: "usd",
          postedAt: row.postedAt,
          description: `Cash App processing fees — ${cohort.ledgerDay} withdrawal`,
          merchantName: "Cash App",
          note,
          status: "categorized",
          ...(category ? { categoryId: category._id } : {}),
          // A rail's cut, not a decision — so it is never asked which budget it
          // belongs to. See `finances.ts#needsBudget`.
          feeOrigin: "cash_app_processing",
          externalId: cohort.feeExternalId,
          createdAt: Date.now(),
        });
      }
    }

    const bookValueDeltaCents =
      ticketDeltaCents + giftCents + saleCents - feeDeltaCents - unlabelledIncomeRemovedCents;

    return {
      dryRun: !write,
      proceeded: true,
      withdrawals,
      cohorts,
      estimatedOrderRemoved,
      ticketOrderCreated,
      ticketCents: ticketOrderCreated ? TICKET_GROSS_CENTS : 0,
      ticketAdmissions: ticketOrderCreated ? TICKET_ADMISSIONS : 0,
      giftsRecorded,
      giftCents,
      donors: [...donorMatches.values()],
      salesRecorded,
      saleCents,
      feeRowsWritten,
      feeCents,
      bookValueDeltaCents,
      problems,
    };
  },
});

