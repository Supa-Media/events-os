import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { newT, run, setupChapter, type TestConvex } from "./setup.helpers";
import { grossUpCents, DEFAULT_FEE_SCHEDULE, type FeeRate } from "@events-os/shared";
import type { Id } from "../_generated/dataModel";

/**
 * COVER THE FEES — the gift is the gross, and it is quoted at the donor's rail.
 *
 * ── WHAT THIS FILE USED TO PIN DOWN, AND WHY IT CHANGED ─────────────────────
 * It used to assert the opposite of most of what is below: that a gift was
 * booked at what the donor MEANT to give, with the coverage parked beside it
 * outside every total, so that year-on-year giving comparisons wouldn't inflate
 * as adoption of the feature grew.
 *
 * That comparability was fictional, and #732 is what it cost. Charisma Stevens
 * was charged $309.27 — a $300 gift grossed up at the CARD rate — paid it by
 * BANK, where the fee was $2.47, and the ledger reported a $300.00 gift while
 * her receipt said $309.27. Two things were wrong at once and both are pinned
 * here now:
 *
 *   1. THE GIFT IS THE WHOLE CHARGE. Every cent left her account and landed
 *      with us. The processor's cut is an expense of the org, exactly as it is
 *      on the uncovered gift beside it. `feeCoverageCents` is a NOTE on the
 *      gift, inside `amountCents`, never a subtraction from it.
 *   2. THE COVERAGE IS QUOTED AT THE RAIL THEY PICKED. Stripe won't say which
 *      rail until after the session exists, so the form asks first and pins
 *      `payment_method_types` to the answer. Quoting card at everyone
 *      overcharged bank givers, by $6.80 on a $300 gift and by $145 on a
 *      $5,000 one.
 *
 * So the assertions are mostly INVARIANTS rather than examples: the charge is
 * the gift, the note adds up, the rail decides the quote, and malformed
 * metadata can only ever lose a footnote — never move money.
 */

const CARD = DEFAULT_FEE_SCHEDULE.find(
  (r) => r.processor === "stripe" && r.method === "card",
)! as FeeRate;
const ACH = DEFAULT_FEE_SCHEDULE.find(
  (r) => r.processor === "stripe" && r.method === "ach_debit",
)! as FeeRate;

async function seedDonor(t: TestConvex, scope: Id<"chapters"> | "central") {
  const prepared = await t.mutation(internal.givingDonations.prepareGiveDonation, {
    scope,
    amountCents: 10_000,
    name: "Fee Coverer",
    email: "coverer@example.com",
  });
  return prepared.donorId;
}

async function allGifts(t: TestConvex) {
  return run(t, (ctx) => ctx.db.query("gifts").collect());
}

describe("the gift is the whole charge", () => {
  test("a covered gift books at what was CHARGED, with the coverage noted", async () => {
    const t = newT();
    const donorId = await seedDonor(t, "central");
    // $100 typed, covered at the card rate → $103.30 charged.
    const charged = grossUpCents(10_000, CARD);
    expect(charged).toBe(10_330);

    await t.mutation(internal.givingDonations.recordGiveDonationPaid, {
      sessionId: "cs_cov",
      amountTotalCents: charged,
      donorId: String(donorId),
      scope: "central",
      intendedCents: 10_000,
    });

    const gifts = await allGifts(t);
    expect(gifts).toHaveLength(1);
    expect(gifts[0].amountCents).toBe(10_330);
    expect(gifts[0].feeCoverageCents).toBe(330);
  });

  test("the note is INSIDE the gift — nothing sums the two", async () => {
    // The bug this replaces was `amountCents + feeCoverageCents = the charge`.
    // Now the charge IS `amountCents`, so any call site that adds them would
    // count the coverage twice.
    const t = newT();
    const donorId = await seedDonor(t, "central");
    const charged = grossUpCents(10_000, CARD);

    await t.mutation(internal.givingDonations.recordGiveDonationPaid, {
      sessionId: "cs_cov",
      amountTotalCents: charged,
      donorId: String(donorId),
      scope: "central",
      intendedCents: 10_000,
    });

    const gift = (await allGifts(t))[0];
    expect(gift.amountCents).toBe(charged);
    expect(gift.feeCoverageCents).toBeLessThan(gift.amountCents);
  });

  test("the donor's lifetime total counts every cent they gave", async () => {
    // Including the part they added to absorb the fee. They gave it; it left
    // their account; it landed with us. A giving history that omits it is
    // telling the donor they gave less than they did.
    const t = newT();
    const donorId = await seedDonor(t, "central");

    await t.mutation(internal.givingDonations.recordGiveDonationPaid, {
      sessionId: "cs_cov",
      amountTotalCents: grossUpCents(10_000, CARD),
      donorId: String(donorId),
      scope: "central",
      intendedCents: 10_000,
    });

    const donor = await run(t, (ctx) => ctx.db.get(donorId));
    expect(donor?.lifetimeCents).toBe(10_330);
    expect(donor?.giftCount).toBe(1);
  });

  test("an UNCOVERED gift is untouched — no coverage field at all", async () => {
    const t = newT();
    const donorId = await seedDonor(t, "central");

    await t.mutation(internal.givingDonations.recordGiveDonationPaid, {
      sessionId: "cs_plain",
      amountTotalCents: 10_000,
      donorId: String(donorId),
      scope: "central",
    });

    const gift = (await allGifts(t))[0];
    expect(gift.amountCents).toBe(10_000);
    expect(gift.feeCoverageCents).toBeUndefined();
  });

  test("reported giving equals what the bank received", async () => {
    /**
     * THE PROOF the correction asked for, and the exact inverse of the old
     * file's. Two donors give; one covers the fee, one doesn't. Reported giving
     * is the sum of the two CHARGES — there is no second figure, and nothing
     * about a gift is invisible to a report.
     */
    const t = newT();
    const plain = await run(t, (ctx) =>
      ctx.db.insert("donors", {
        scope: "central",
        kind: "individual",
        name: "Plain Giver",
        email: "plain@example.com",
        status: "prospect",
        lifetimeCents: 0,
        giftCount: 0,
        createdAt: Date.now(),
      }),
    );
    const coverer = await seedDonor(t, "central");
    const charged = grossUpCents(10_000, CARD);

    await t.mutation(internal.givingDonations.recordGiveDonationPaid, {
      sessionId: "cs_a",
      amountTotalCents: 10_000,
      donorId: String(plain),
      scope: "central",
    });
    await t.mutation(internal.givingDonations.recordGiveDonationPaid, {
      sessionId: "cs_b",
      amountTotalCents: charged,
      donorId: String(coverer),
      scope: "central",
      intendedCents: 10_000,
    });

    const gifts = await allGifts(t);
    const reportedGiving = gifts.reduce((sum, g) => sum + g.amountCents, 0);
    const chargedTotal = 10_000 + charged;

    expect(reportedGiving).toBe(chargedTotal);
    expect(reportedGiving).toBe(20_330);
  });
});

describe("the coverage is quoted at the rail the donor picked", () => {
  /**
   * The arithmetic, asserted directly against the shared helper — the same one
   * `startGiveDonationCheckout` calls. An action that talks to Stripe can't run
   * under convex-test, so what is pinned here is the CHOICE OF RATE, which is
   * the half that was wrong: the code picks `rates.ach` for `ach_debit` and
   * `rates.card` otherwise, and these are the two answers it has to produce.
   */
  test("the same gift costs far less to cover by bank than by card", async () => {
    expect(grossUpCents(30_000, CARD) - 30_000).toBe(927); // Charisma's $9.27
    expect(grossUpCents(30_000, ACH) - 30_000).toBe(242); // what it should have been
  });

  test("the gap is the whole point on a large gift — the ACH cap binds", async () => {
    // $5,000: card takes 2.9% + 30¢ of a bigger number every time; ACH stops
    // at $5.00 flat. Quoting card to a bank giver here overcharges by $144.64.
    const byCard = grossUpCents(500_000, CARD) - 500_000;
    const byAch = grossUpCents(500_000, ACH) - 500_000;
    expect(byCard).toBe(14_964); // $149.64
    expect(byAch).toBe(500); // $5.00 — the cap, flat
    expect(byCard - byAch).toBe(14_464);
  });

  test("covering nets the org exactly what the donor typed, on either rail", async () => {
    // The invariant that makes the feature honest rather than approximate.
    for (const rate of [CARD, ACH]) {
      for (const intended of [2_500, 10_000, 30_000, 62_100, 500_000]) {
        const gross = grossUpCents(intended, rate);
        const fee =
          Math.min(
            Math.round((gross * rate.percentBps) / 10_000) + rate.fixedCents,
            rate.capCents ?? Number.POSITIVE_INFINITY,
          );
        expect(gross - fee).toBe(intended);
      }
    }
  });
});

describe("a malformed coverage note can only be dropped, never invented", () => {
  /**
   * `intendedCents` arrives from Stripe session METADATA, which is a string map
   * an earlier deploy wrote. Every bad shape has to degrade to "book the charge
   * with no note" — the charge is what actually arrived, so this can lose a
   * footnote but can never book a gift larger or smaller than the money.
   */
  const bad: Array<[string, number]> = [
    ["larger than the charge", 99_999],
    ["zero", 0],
    ["negative", -500],
    ["fractional", 1234.5],
  ];

  for (const [label, intended] of bad) {
    test(`${label} → the charge is booked with no coverage note`, async () => {
      const t = newT();
      const donorId = await seedDonor(t, "central");

      await t.mutation(internal.givingDonations.recordGiveDonationPaid, {
        sessionId: `cs_${label.replace(/\W+/g, "")}`,
        amountTotalCents: 10_330,
        donorId: String(donorId),
        scope: "central",
        intendedCents: intended,
      });

      const gift = (await allGifts(t))[0];
      expect(gift.amountCents).toBe(10_330);
      expect(gift.feeCoverageCents).toBeUndefined();
    });
  }

  test("intended EQUAL to the charge is valid and means zero coverage", async () => {
    const t = newT();
    const donorId = await seedDonor(t, "central");

    await t.mutation(internal.givingDonations.recordGiveDonationPaid, {
      sessionId: "cs_eq",
      amountTotalCents: 10_000,
      donorId: String(donorId),
      scope: "central",
      intendedCents: 10_000,
    });

    const gift = (await allGifts(t))[0];
    expect(gift.amountCents).toBe(10_000);
    expect(gift.feeCoverageCents).toBeUndefined();
  });
});

describe("the public wall shows the same figure as the ledger", () => {
  test("a donor who covered fees is shown the gift they actually gave", async () => {
    // The wall used to show the pre-coverage figure, on the reasoning that
    // consenting to show a $100 gift isn't consenting to announce a payment to
    // Stripe. But the gift IS the charge now, and a public page that disagrees
    // with the ledger about one donation is the same bug in a smaller place.
    const t = newT();
    const s = await setupChapter(t);
    const charged = grossUpCents(10_000, CARD);
    await t.mutation(internal.givingDonations.prepareGiveDonation, {
      scope: s.chapterId,
      amountCents: 10_000,
      name: "Fee Coverer",
      email: "coverer@example.com",
    });
    await t.mutation(internal.givingActivity.recordPendingActivity, {
      refKey: "give:cs_wall",
      scope: s.chapterId,
      kind: "gift",
      amountCents: charged,
      displayName: "A Neighbour",
      consent: true,
    });

    await t.mutation(internal.givingActivity.markActivityVisible, {
      refKey: "give:cs_wall",
      amountCents: charged, // the charge, as http.ts now passes
    });

    const wall = await run(t, (ctx) => ctx.db.query("givingActivity").collect());
    expect(wall[0].status).toBe("visible");
    expect(wall[0].amountCents).toBe(10_330);
  });
});
