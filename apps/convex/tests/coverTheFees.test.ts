import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { newT, run, setupChapter, type TestConvex } from "./setup.helpers";
import { grossUpCents, DEFAULT_FEE_SCHEDULE, type FeeRate } from "@events-os/shared";
import type { Id } from "../_generated/dataModel";

/**
 * COVER THE FEES — one payment, two meanings.
 *
 * The decision this file pins down: a gift is recorded at what the donor MEANT
 * to give, and the coverage sits beside it. `amountCents + feeCoverageCents` is
 * what the card was charged.
 *
 * The alternative — booking the whole charge as the gift — is the tempting one
 * and it is wrong in a way that gets worse over time. A $100 gift would start
 * reporting as $103.30; every year-on-year giving comparison would inflate
 * silently as adoption grew; and "did giving go up, or did more people tick a
 * box?" would become unanswerable from the data. Same arrangement as
 * `sales.donationCents` and `ticketOrders.donationCents`, for the same reason.
 *
 * So the assertions here are mostly INVARIANTS rather than examples: the split
 * adds up, giving totals are unmoved by the feature, and a malformed split can
 * only ever fall back to the old behaviour.
 */

const CARD = DEFAULT_FEE_SCHEDULE.find(
  (r) => r.processor === "stripe" && r.method === "card",
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

describe("the split", () => {
  test("the gift is what they MEANT to give, not what the card was charged", async () => {
    const t = newT();
    const donorId = await seedDonor(t, "central");
    // $100 intended, covered on the card rate → $103.30 charged.
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
    expect(gifts[0].amountCents).toBe(10_000);
    expect(gifts[0].feeCoverageCents).toBe(330);
  });

  test("gift + coverage is EXACTLY the charge — money counted once", async () => {
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
    expect(gift.amountCents + (gift.feeCoverageCents ?? 0)).toBe(charged);
  });

  test("the donor's lifetime total counts the GIFT, never the coverage", async () => {
    // Otherwise a donor's giving history quietly inflates by whatever they paid
    // Stripe on the org's behalf — which is not something they gave the org.
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
    expect(donor?.lifetimeCents).toBe(10_000);
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
});

describe("total giving is verifiable across the launch of the feature", () => {
  /**
   * THE PROOF the accounting decision asked for. Two donors give $100 each;
   * one covers the fees and one doesn't. Reported giving must be $200 — the
   * same as it would have been before this feature existed — while the org's
   * gross receipts differ by exactly the coverage.
   */
  test("same donors, same amounts, same reported giving — only the NET moves", async () => {
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
    const grossReceipts = gifts.reduce(
      (sum, g) => sum + g.amountCents + (g.feeCoverageCents ?? 0),
      0,
    );

    // Both gave $100. Giving reports say $200, exactly as they would have
    // before anyone could tick the box.
    expect(reportedGiving).toBe(20_000);
    // The bank saw $203.30 — and the difference is the coverage, to the cent.
    expect(grossReceipts).toBe(20_000 + 330);
    expect(grossReceipts - reportedGiving).toBe(330);
  });
});

describe("a malformed split can only fall back, never invent", () => {
  /**
   * `intendedCents` arrives from Stripe session METADATA, which is a string
   * map an earlier deploy wrote. Every bad shape has to degrade to "the whole
   * charge was the gift" — the pre-feature behaviour, which can understate the
   * org's net but can never book a gift larger than the money that arrived.
   */
  const bad: Array<[string, number]> = [
    ["larger than the charge", 99_999],
    ["zero", 0],
    ["negative", -500],
    ["fractional", 1234.5],
  ];

  for (const [label, intended] of bad) {
    test(`${label} → the whole charge is booked as the gift`, async () => {
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
      // And never more than actually arrived.
      expect(gift.amountCents).toBeLessThanOrEqual(10_330);
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

describe("the public wall shows the gift, not the charge", () => {
  test("a donor who covered fees is shown giving what they gave", async () => {
    // They consented to show a $100 gift. They did not consent to announce
    // that they also paid $3.30 to a card processor.
    const t = newT();
    const s = await setupChapter(t);
    const prepared = await t.mutation(internal.givingDonations.prepareGiveDonation, {
      scope: s.chapterId,
      amountCents: 10_000,
      name: "Fee Coverer",
      email: "coverer@example.com",
    });
    await t.mutation(internal.givingActivity.recordPendingActivity, {
      refKey: "give:cs_wall",
      scope: s.chapterId,
      kind: "gift",
      amountCents: 10_000,
      displayName: "A Neighbour",
      consent: true,
    });

    await t.mutation(internal.givingActivity.markActivityVisible, {
      refKey: "give:cs_wall",
      amountCents: 10_000, // the intended half, as http.ts now passes
    });
    void prepared;

    const wall = await run(t, (ctx) => ctx.db.query("givingActivity").collect());
    expect(wall[0].status).toBe("visible");
    expect(wall[0].amountCents).toBe(10_000);
  });
});
