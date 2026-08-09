/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { CENTRAL } from "@events-os/shared";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { NEW_YORK_CHAPTER_SLUG } from "../lib/seed/historical/mapping";
import {
  COHORTS,
  ESTIMATED_ORDER_ADMISSIONS,
  ESTIMATED_ORDER_CENTS,
  ESTIMATED_ORDER_REF,
  EXPECTED_BOOK_VALUE_DELTA_CENTS,
  GIFTS,
  PTB_PAGE_SLUG,
  SALES,
  TICKET_ADMISSIONS,
  TICKET_ATTENDEE_NAMES,
  TICKET_GROSS_CENTS,
  TICKET_ORDER_REF,
  TICKET_PAYMENTS,
  TOTAL_FEE_CENTS,
  TOTAL_GROSS_CENTS,
  cohortFeeCents,
  cohortGrossCents,
  cohortPaymentAmounts,
  cohortPaymentCount,
  cohortReconciles,
  paymentFeeCents,
  utcNoon,
} from "../lib/seed/historical/cashApp2026";

/**
 * The 2026-08-09 Cash App backfill.
 *
 * The thing this suite exists to hold still is the ARITHMETIC, not the code
 * shape. A year of Cash App money is being recorded from screenshots that carry
 * no balance, so the only proof any of it is complete is that each cohort's
 * payments, less the fee booked for that cohort, equal the withdrawal already
 * sitting in the ledger. Every assertion below is in cents, and the cohort
 * identity is asserted with `toBe`, never a tolerance — the fee is measured
 * from the withdrawals themselves, so there is nothing left over to tolerate.
 *
 * The second thing it holds still is the double-count guard: revenue must not
 * be written while the withdrawal that banked it is still counting as income.
 */

// ── The data module, no database needed ──────────────────────────────────────

describe("cashApp2026 — the transcription reconciles to the withdrawals", () => {
  test("each cohort: payments − fee === the withdrawal, exactly", () => {
    for (const c of COHORTS) {
      expect(cohortGrossCents(c.key) - cohortFeeCents(c.key)).toBe(c.withdrawalCents);
      expect(cohortReconciles(c)).toBe(true);
    }
    // The three observed withdrawals, so a wrong fee can't hide behind a
    // self-consistent derivation.
    expect(cohortFeeCents("oct2025")).toBe(2940);
    expect(cohortFeeCents("dec2025_jan2026")).toBe(862);
    expect(cohortFeeCents("feb_may2026")).toBe(513);
  });

  test("the three cohorts total $1,377.00 gross and $43.15 of fees", () => {
    expect(TOTAL_GROSS_CENTS).toBe(137700);
    expect(TOTAL_FEE_CENTS).toBe(4315);
    // And the three withdrawals are what is left.
    expect(TOTAL_GROSS_CENTS - TOTAL_FEE_CENTS).toBe(
      COHORTS.reduce((a, c) => a + c.withdrawalCents, 0),
    );
  });

  test("October is 40 payments, $900.00 and 45 admissions", () => {
    // The source note says 41 payments. Forty is what the money and the
    // admissions both require, and this is the assertion that says so.
    expect(TICKET_PAYMENTS.length).toBe(40);
    expect(TICKET_GROSS_CENTS).toBe(90000);
    expect(TICKET_ADMISSIONS).toBe(45);
    expect(TICKET_PAYMENTS.filter((p) => p.amountCents === 4000)).toHaveLength(5);
    expect(TICKET_PAYMENTS.every((p) => p.amountCents % 2000 === 0)).toBe(true);
  });

  test("every admission has a name slot, and the five extra ones say whose", () => {
    expect(TICKET_ATTENDEE_NAMES).toHaveLength(TICKET_ADMISSIONS);
    const guests = TICKET_ATTENDEE_NAMES.filter((n) => n.startsWith("Guest of "));
    expect(guests).toHaveLength(5);
    // A guest slot names a real payer rather than a person nobody can identify.
    for (const g of guests) {
      const payer = g.slice("Guest of ".length);
      expect(TICKET_PAYMENTS.some((p) => p.payer === payer && p.amountCents === 4000)).toBe(true);
    }
    // The first 40 slots are the payers, in payment order.
    expect(TICKET_ATTENDEE_NAMES.slice(0, 40)).toEqual(TICKET_PAYMENTS.map((p) => p.payer));
  });

  test("the per-payment fee matches Cash App's own payment-detail screens", () => {
    // The two receipts the formula is read off. If these ever stop holding, the
    // fee changed and every cohort total below is suspect.
    expect(paymentFeeCents(5000)).toBe(145); // $50.00 → $1.45 fee, $48.55 deposited
    expect(paymentFeeCents(10000)).toBe(275); // $100.00 → $2.75 fee, $97.25 deposited
    // A $20 ticket, the unit almost every October row is made of.
    expect(paymentFeeCents(2000)).toBe(67);
    expect(paymentFeeCents(4000)).toBe(119);
  });

  test("a cohort's fee is the sum of its payments' fees, not a stored number", () => {
    for (const c of COHORTS) {
      const summed = cohortPaymentAmounts(c.key).reduce((a, amt) => a + paymentFeeCents(amt), 0);
      expect(cohortFeeCents(c.key)).toBe(summed);
    }
    // The fixed 15¢ is what makes the payment COUNT checkable: October only
    // reconciles at 40 rows — a 41st would push the fee 15¢ past $29.40.
    expect(cohortFeeCents("oct2025") + 15).not.toBe(2940);
    expect(cohortPaymentCount("oct2025")).toBe(40);
  });

  test("payment counts add up to the 49 payments transcribed", () => {
    expect(COHORTS.reduce((a, c) => a + cohortPaymentCount(c.key), 0)).toBe(
      TICKET_PAYMENTS.length + GIFTS.length + SALES.length,
    );
  });

  test("Ja'Brilyn's apostrophe is the CURLY one the live donor record uses", () => {
    // U+2019, not U+0027. Exact name matching is the only key these gifts have,
    // so this single byte decides whether her giving history stays on one donor
    // record or splits across two.
    const hers = GIFTS.filter((g) => g.donor.includes("Brilyn"));
    expect(hers).toHaveLength(2);
    for (const g of hers) {
      expect(g.donor).toBe("Ja’Brilyn Chandler");
      expect(g.donor).not.toContain("'");
    }
  });

  test("every external ref is unique — they are the idempotency keys", () => {
    const refs = [...GIFTS.map((g) => g.externalRef), ...SALES.map((s) => s.externalRef)];
    expect(new Set(refs).size).toBe(refs.length);
  });

  test("book value moves $378.98, and the cash side agrees independently", () => {
    // The revenue side.
    const fromRows =
      TICKET_GROSS_CENTS -
      ESTIMATED_ORDER_CENTS +
      GIFTS.reduce((a, g) => a + g.amountCents, 0) +
      SALES.reduce((a, s) => a + s.amountCents, 0) -
      TOTAL_FEE_CENTS -
      COHORTS[2].withdrawalCents; // the credit that stops counting as income
    expect(fromRows).toBe(EXPECTED_BOOK_VALUE_DELTA_CENTS);

    // The cash side, sharing no arithmetic with the above: everything withdrawn,
    // less what the books had already counted (the $780 estimate and the
    // unlabelled $174.87 credit).
    const withdrawn = COHORTS.reduce((a, c) => a + c.withdrawalCents, 0);
    const alreadyBooked = ESTIMATED_ORDER_CENTS + COHORTS[2].withdrawalCents;
    expect(withdrawn - alreadyBooked).toBe(EXPECTED_BOOK_VALUE_DELTA_CENTS);
  });
});

// ── The runner, against a database ───────────────────────────────────────────

type Seeded = ChapterSetup & {
  eventId: Id<"events">;
  pageId: Id<"eventPages">;
};

/** How the withdrawals are seeded — omit one to test the refusal. */
type SeedOpts = {
  /** Cohort keys whose withdrawal should exist. Default: all three. */
  withdrawals?: string[];
  /** Seed the $780 estimated order (default true). */
  estimate?: boolean;
  /** Donor names to pre-create in the chapter's scope. */
  existingDonors?: string[];
  /** Add a second inflow at the third withdrawal's amount, on the other book. */
  decoyWithdrawal?: boolean;
};

/**
 * The NY chapter as the runner expects to find it: resolved by SLUG, with the
 * Pop The Balloon page, the Bank & Fees category, the three Cash App
 * withdrawals (two already labelled, the third NOT — which is the production
 * state this backfill has to handle), and the estimated ticket order.
 */
async function seed(opts: SeedOpts = {}): Promise<Seeded> {
  const t = newT();
  const s = await setupChapter(t);
  const wanted = opts.withdrawals ?? COHORTS.map((c) => c.key);
  const ids = await run(t, async (ctx) => {
    const now = Date.now();
    await ctx.db.patch(s.chapterId, { slug: NEW_YORK_CHAPTER_SLUG });

    const fundId = await ctx.db.insert("funds", {
      chapterId: s.chapterId,
      name: "General Fund",
      restriction: "unrestricted",
      sortOrder: 0,
      isActive: true,
      createdAt: now,
    });
    await ctx.db.insert("budgetCategories", {
      chapterId: s.chapterId,
      fundId,
      name: "Bank & Fees",
      kind: "category",
      sortOrder: 0,
      isActive: true,
      createdAt: now,
    });

    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Pop The Balloon",
      slug: "pop-the-balloon",
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: "Pop The Balloon",
      eventDate: utcNoon("2025-12-06"),
      status: "completed",
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    const pageId = await ctx.db.insert("eventPages", {
      eventId,
      chapterId: s.chapterId,
      slug: PTB_PAGE_SLUG,
      published: true,
      goingCount: 0,
      maybeCount: 0,
      notGoingCount: 0,
      ticketsSoldCount: opts.estimate === false ? 0 : ESTIMATED_ORDER_ADMISSIONS,
      revenueCents: opts.estimate === false ? 0 : ESTIMATED_ORDER_CENTS,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });

    if (opts.estimate !== false) {
      const ticketTypeId = await ctx.db.insert("ticketTypes", {
        eventId,
        chapterId: s.chapterId,
        name: "Audience Ticket (paid outside Givebutter)",
        priceCents: 2000,
        currency: "usd",
        soldCount: ESTIMATED_ORDER_ADMISSIONS,
        sortOrder: 100,
        isActive: false,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("ticketOrders", {
        eventId,
        chapterId: s.chapterId,
        name: "Pop The Balloon — Cash App collections",
        email: "seyi@publicworship.life",
        items: [
          {
            ticketTypeId,
            name: "Audience Ticket (paid outside Givebutter)",
            quantity: ESTIMATED_ORDER_ADMISSIONS,
            unitPriceCents: 2000,
            attendeeNames: [],
          },
        ],
        totalCents: ESTIMATED_ORDER_CENTS,
        currency: "usd",
        status: "paid",
        externalRef: ESTIMATED_ORDER_REF,
        createdAt: utcNoon("2025-12-07"),
        updatedAt: now,
      });
    }

    // The production shape, exactly: the two Relay-era sweeps landed on New
    // York, the Increase-era one on CENTRAL, and only the first two are
    // labelled. A runner that pins the scan to New York misses the third.
    for (const c of COHORTS) {
      if (!wanted.includes(c.key)) continue;
      const onCentral = c.key === "feb_may2026";
      await ctx.db.insert("transactions", {
        chapterId: onCentral ? CENTRAL : s.chapterId,
        source: onCentral ? "increase_ach" : "relay_csv",
        flow: "inflow",
        amountCents: c.withdrawalCents,
        currency: "usd",
        postedAt: utcNoon(c.ledgerDay),
        description: "Cash App",
        status: "unreviewed",
        ...(onCentral ? {} : { payoutProcessor: "other" as const }),
        createdAt: now,
      });
    }
    if (opts.decoyWithdrawal) {
      // A same-amount inflow on the OTHER book, inside the window. Widening the
      // search widens the collision surface, so this must refuse — not pick one.
      await ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "inflow",
        amountCents: COHORTS[2].withdrawalCents,
        currency: "usd",
        postedAt: utcNoon(COHORTS[2].ledgerDay),
        description: "Something else entirely",
        status: "unreviewed",
        createdAt: now,
      });
    }

    for (const name of opts.existingDonors ?? []) {
      await ctx.db.insert("donors", {
        scope: s.chapterId,
        kind: "individual",
        name,
        status: "active",
        lifetimeCents: 2500,
        giftCount: 1,
        createdAt: now,
      });
    }
    return { eventId, pageId };
  });
  return { ...s, ...ids };
}

function runner(s: Seeded, execute: boolean) {
  return s.t.mutation(internal.cashAppBackfill.runCashAppBackfill, {
    recordedBy: s.userId,
    execute,
  });
}

describe("runCashAppBackfill", () => {
  test("a dry run reports the whole plan and writes nothing", async () => {
    const s = await seed();
    const res = await runner(s, false);

    expect(res.dryRun).toBe(true);
    expect(res.proceeded).toBe(true);
    expect(res.problems).toEqual([]);
    expect(res.ticketCents).toBe(TICKET_GROSS_CENTS);
    expect(res.ticketAdmissions).toBe(TICKET_ADMISSIONS);
    expect(res.giftsRecorded).toBe(GIFTS.length);
    expect(res.salesRecorded).toBe(SALES.length);
    expect(res.feeRowsWritten).toBe(COHORTS.length);
    expect(res.bookValueDeltaCents).toBe(EXPECTED_BOOK_VALUE_DELTA_CENTS);

    const after = await run(s.t, async (ctx) => ({
      gifts: (await ctx.db.query("gifts").collect()).length,
      sales: (await ctx.db.query("sales").collect()).length,
      orders: (await ctx.db.query("ticketOrders").collect()).length,
      feeRows: (await ctx.db.query("transactions").collect()).filter(
        (t) => t.externalId?.startsWith("cashapp-fees:"),
      ).length,
      unlabelled: (await ctx.db.query("transactions").collect()).filter(
        (t) => t.flow === "inflow" && t.payoutProcessor == null,
      ).length,
    }));
    expect(after).toEqual({ gifts: 0, sales: 0, orders: 1, feeRows: 0, unlabelled: 1 });
  });

  test("an executed run books every cohort and the arithmetic closes", async () => {
    const s = await seed();
    const res = await runner(s, true);

    expect(res.proceeded).toBe(true);
    expect(res.problems).toEqual([]);
    expect(res.estimatedOrderRemoved).toBe(true);
    expect(res.ticketOrderCreated).toBe(true);
    expect(res.bookValueDeltaCents).toBe(EXPECTED_BOOK_VALUE_DELTA_CENTS);
    for (const c of res.cohorts) expect(c.reconciles).toBe(true);

    const state = await run(s.t, async (ctx) => {
      const orders = await ctx.db.query("ticketOrders").collect();
      const gifts = await ctx.db.query("gifts").collect();
      const sales = await ctx.db.query("sales").collect();
      const txns = await ctx.db.query("transactions").collect();
      const page = (await ctx.db.get(s.pageId))!;
      return { orders, gifts, sales, txns, page };
    });

    // ── the tickets ──
    expect(state.orders).toHaveLength(1);
    const order = state.orders[0];
    expect(order.externalRef).toBe(TICKET_ORDER_REF);
    expect(order.totalCents).toBe(TICKET_GROSS_CENTS);
    expect(order.items[0].quantity).toBe(TICKET_ADMISSIONS);
    expect(order.items[0].attendeeNames).toEqual(TICKET_ATTENDEE_NAMES);
    // The page's rollups move by the NET of the replacement, not the gross.
    expect(state.page.revenueCents).toBe(TICKET_GROSS_CENTS);
    expect(state.page.ticketsSoldCount).toBe(TICKET_ADMISSIONS);

    // ── the gifts ──
    expect(state.gifts).toHaveLength(GIFTS.length);
    expect(state.gifts.reduce((a, g) => a + g.amountCents, 0)).toBe(44000);
    expect(state.gifts.every((g) => g.method === "cash_app")).toBe(true);
    // A donation is not event revenue — owner decision 1.
    expect(state.gifts.every((g) => g.eventId == null)).toBe(true);

    // ── the sales ──
    expect(state.sales).toHaveLength(SALES.length);
    expect(state.sales.reduce((a, x) => a + x.grossCents, 0)).toBe(3700);
    // No Stripe charge id on a payment Stripe never saw; the fee is booked once
    // per cohort in the ledger, so a per-sale fee would double-count it.
    expect(state.sales.every((x) => x.stripeChargeId == null)).toBe(true);
    expect(state.sales.every((x) => x.externalRef?.startsWith("cashapp:sale:"))).toBe(true);
    expect(state.sales.filter((x) => x.eventId === s.eventId)).toHaveLength(2);
    // Each sale carries the fee Cash App took on THAT payment — 25¢ on $4, 23¢
    // on $3, 93¢ on $30 — so the sales page's net column is true.
    expect(state.sales.map((x) => x.feeCents).sort((a, b) => a - b)).toEqual([23, 25, 93]);

    // ── the fees ──
    const feeRows = state.txns.filter((t) => t.externalId?.startsWith("cashapp-fees:"));
    expect(feeRows).toHaveLength(COHORTS.length);
    expect(feeRows.every((t) => t.flow === "outflow")).toBe(true);
    expect(feeRows.reduce((a, t) => a + t.amountCents, 0)).toBe(TOTAL_FEE_CENTS);

    // ── the double-count guard: every withdrawal is now labelled ──
    const withdrawals = state.txns.filter(
      (t) => t.flow === "inflow" && COHORTS.some((c) => c.withdrawalCents === t.amountCents),
    );
    expect(withdrawals).toHaveLength(COHORTS.length);
    expect(withdrawals.every((t) => t.payoutProcessor === "other")).toBe(true);
    // Including the one on CENTRAL's book — the whole point of searching across
    // books rather than within New York.
    const central = withdrawals.find((t) => t.chapterId === CENTRAL)!;
    expect(central.amountCents).toBe(COHORTS[2].withdrawalCents);
    expect(central.payoutProcessor).toBe("other");
    expect(res.withdrawals.find((w) => w.cohort === "feb_may2026")?.book).toBe("Central");
    expect(res.withdrawals.find((w) => w.cohort === "oct2025")?.book).toBe("New York");
    // The fee rows stay on New York, which earned the revenue, even for the
    // cohort whose cash landed on Central.
    expect(feeRows.every((t) => t.chapterId === s.chapterId)).toBe(true);

    // ── and the per-cohort identity, asserted against what actually landed ──
    for (const c of COHORTS) {
      const recorded =
        (c.key === "oct2025" ? order.totalCents : 0) +
        state.gifts
          .filter((g) => GIFTS.find((x) => x.externalRef === g.externalRef)?.cohort === c.key)
          .reduce((a, g) => a + g.amountCents, 0) +
        state.sales
          .filter((x) => SALES.find((y) => y.externalRef === x.externalRef)?.cohort === c.key)
          .reduce((a, x) => a + x.grossCents, 0);
      const fee = feeRows.find((t) => t.externalId === c.feeExternalId)!.amountCents;
      expect(fee).toBe(cohortFeeCents(c.key));
      expect(recorded - fee).toBe(c.withdrawalCents);
    }
  });

  test("gifts merge onto the donors that already exist, and only those", async () => {
    // Both live donors, exactly as production spells them — Ja'Brilyn with the
    // curly apostrophe that exact matching turns on.
    const s = await seed({
      existingDonors: ["Lola Osunseemi", "Ja’Brilyn Chandler"],
    });
    const res = await runner(s, true);

    const byName = new Map(res.donors.map((d) => [d.donor, d]));
    expect(byName.get("Lola Osunseemi")?.matchedExisting).toBe(true);
    expect(byName.get("Ja’Brilyn Chandler")?.matchedExisting).toBe(true);
    expect(byName.get("Kafilat Oladiran")?.matchedExisting).toBe(false);
    expect(byName.get("Tahlea")?.matchedExisting).toBe(false);
    expect(byName.get("David Aodu")?.matchedExisting).toBe(false);
    // Her two gifts are reported against one donor, not two.
    expect(byName.get("Ja’Brilyn Chandler")?.giftCents).toBe(20000);

    const donors = await run(s.t, (ctx) => ctx.db.query("donors").collect());
    // Five names, two of which already existed → three new records.
    expect(donors).toHaveLength(5);
    expect(donors.filter((d) => d.name.includes("Brilyn"))).toHaveLength(1);
    // And her lifetime carries both the pre-existing giving and the new gifts.
    const jab = donors.find((d) => d.name.includes("Brilyn"))!;
    expect(jab.lifetimeCents).toBe(2500 + 20000);
  });

  test("a straight apostrophe would have split her record — the guard is real", async () => {
    // The failure mode the curly character prevents, demonstrated rather than
    // asserted in prose: seed the donor with the WRONG apostrophe and she does
    // not match.
    const s = await seed({ existingDonors: ["Ja'Brilyn Chandler"] });
    const res = await runner(s, true);
    expect(res.donors.find((d) => d.donor.includes("Brilyn"))?.matchedExisting).toBe(false);
    const donors = await run(s.t, (ctx) => ctx.db.query("donors").collect());
    expect(donors.filter((d) => d.name.includes("Brilyn"))).toHaveLength(2);
  });

  test("re-running changes nothing", async () => {
    const s = await seed();
    await runner(s, true);
    const before = await run(s.t, async (ctx) => ({
      gifts: (await ctx.db.query("gifts").collect()).length,
      sales: (await ctx.db.query("sales").collect()).length,
      orders: (await ctx.db.query("ticketOrders").collect()).length,
      txns: (await ctx.db.query("transactions").collect()).length,
      revenueCents: (await ctx.db.get(s.pageId))!.revenueCents,
    }));

    const second = await runner(s, true);
    expect(second.giftsRecorded).toBe(0);
    expect(second.salesRecorded).toBe(0);
    expect(second.ticketOrderCreated).toBe(false);
    expect(second.feeRowsWritten).toBe(0);
    expect(second.bookValueDeltaCents).toBe(0);

    const after = await run(s.t, async (ctx) => ({
      gifts: (await ctx.db.query("gifts").collect()).length,
      sales: (await ctx.db.query("sales").collect()).length,
      orders: (await ctx.db.query("ticketOrders").collect()).length,
      txns: (await ctx.db.query("transactions").collect()).length,
      revenueCents: (await ctx.db.get(s.pageId))!.revenueCents,
    }));
    expect(after).toEqual(before);
  });

  test("a missing withdrawal stops the whole run — nothing is written", async () => {
    const s = await seed({ withdrawals: ["oct2025", "dec2025_jan2026"] });
    const res = await runner(s, true);

    expect(res.proceeded).toBe(false);
    expect(res.bookValueDeltaCents).toBe(0);
    expect(res.problems.join(" ")).toContain("refusing to record");

    const state = await run(s.t, async (ctx) => ({
      gifts: (await ctx.db.query("gifts").collect()).length,
      sales: (await ctx.db.query("sales").collect()).length,
      orders: (await ctx.db.query("ticketOrders").collect()).map((o) => o.externalRef),
    }));
    // The estimated order is untouched and no revenue was added.
    expect(state).toEqual({ gifts: 0, sales: 0, orders: [ESTIMATED_ORDER_REF] });
  });

  test("two rows at the same amount refuse rather than picking one", async () => {
    // The cost of searching across books instead of within one. `exactly one`
    // has to hold ORG-WIDE, or the widening would have traded a missed row for
    // a wrong one.
    const s = await seed({ decoyWithdrawal: true });
    const res = await runner(s, true);

    expect(res.proceeded).toBe(false);
    expect(res.problems.join(" ")).toContain("found 2");
    const state = await run(s.t, async (ctx) => ({
      gifts: (await ctx.db.query("gifts").collect()).length,
      sales: (await ctx.db.query("sales").collect()).length,
    }));
    expect(state).toEqual({ gifts: 0, sales: 0 });
  });

  test("a withdrawal outside the date window is not matched", async () => {
    // The window is anchored on the Cash App feed's own date; a bank row weeks
    // away is a different payment, and pretending otherwise is how a
    // reconciliation matches the wrong row.
    const s = await seed({ withdrawals: ["oct2025", "dec2025_jan2026"] });
    await run(s.t, async (ctx) => {
      await ctx.db.insert("transactions", {
        chapterId: CENTRAL,
        source: "increase_ach",
        flow: "inflow",
        amountCents: COHORTS[2].withdrawalCents,
        currency: "usd",
        postedAt: utcNoon("2026-09-20"),
        description: "Cash App",
        status: "unreviewed",
        createdAt: Date.now(),
      });
    });
    const res = await runner(s, true);
    expect(res.proceeded).toBe(false);
    expect(res.problems.join(" ")).toContain("found 0");
  });

  test("an estimate that isn't $780 / 39 is reported, not overwritten", async () => {
    const s = await seed();
    await run(s.t, async (ctx) => {
      const order = (await ctx.db.query("ticketOrders").collect())[0];
      await ctx.db.patch(order._id, { totalCents: 66000 });
    });
    const res = await runner(s, true);

    expect(res.ticketOrderCreated).toBe(false);
    expect(res.problems.join(" ")).toContain(ESTIMATED_ORDER_REF);
    const orders = await run(s.t, (ctx) => ctx.db.query("ticketOrders").collect());
    // The disagreeing order survives; the gifts and sales still land, because
    // they are independent of it.
    expect(orders.map((o) => o.externalRef)).toEqual([ESTIMATED_ORDER_REF]);
    expect(res.giftsRecorded).toBe(GIFTS.length);
  });

  test("with no estimate to replace, the full $900 is new revenue", async () => {
    const s = await seed({ estimate: false });
    const res = await runner(s, true);

    expect(res.estimatedOrderRemoved).toBe(false);
    expect(res.ticketOrderCreated).toBe(true);
    expect(res.problems.join(" ")).toContain(ESTIMATED_ORDER_REF);
    // $900 rather than the $120 net, and the reported delta says so.
    expect(res.bookValueDeltaCents).toBe(
      EXPECTED_BOOK_VALUE_DELTA_CENTS + ESTIMATED_ORDER_CENTS,
    );
    const page = await run(s.t, (ctx) => ctx.db.get(s.pageId));
    expect(page!.revenueCents).toBe(TICKET_GROSS_CENTS);
  });
});
