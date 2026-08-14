/// <reference types="vite/client" />
/**
 * THE PAYER COVERS STRIPE'S CUT on a personal-charge repayment.
 *
 * Founder, 2026-08-14: "make sure that we add any Stripe fees that are
 * associated with that, because they're reimbursing — we have to get back
 * whatever Stripe fees we lose from that transaction."
 *
 * Before this, a $100 personal charge was billed at exactly $100.00 and the
 * org netted $96.71 — the volunteer's mistake cost the ministry $3.29 to
 * correct. Four things have to hold, and each has cost real money somewhere
 * when it didn't:
 *
 *  1. THE ORG NETS THE DEBT WHOLE. Grossing up (`grossUpCents`) rather than
 *     adding the fee on top, because the rail charges its percentage on the
 *     larger number too.
 *  2. ONE FEE PER BATCH, NOT PER LINE. Stripe's fixed 30¢ is per PAYMENT.
 *     Grossing each charge up separately over-collects 30¢ for every charge
 *     past the first. This is the likeliest way to get it subtly wrong, so
 *     it's pinned directly.
 *  3. THE QUOTE IS THE BILL. `quoteRepayment` (what the payer agrees to) and
 *     `prepareRepaymentCheckout` (what Stripe charges) must agree to the cent
 *     for the same selection — two code paths computing money always agree
 *     until someone edits one.
 *  4. THE WEBHOOK DOESN'T CRY WOLF. `applyRepaymentPaidFromStripe` logs a
 *     loud discrepancy when Stripe's total doesn't match the debts; the fee
 *     line makes them differ BY DESIGN, so the coverage has to be subtracted
 *     before that comparison or the alarm fires on every single fee-covered
 *     payment — on the exact path it exists to police.
 */
import { describe, expect, test, vi } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { grossUpCents } from "@events-os/shared";

/** Stripe's published US card rate — what `DEFAULT_FEE_SCHEDULE` resolves to
 *  when no `processorFeeSchedule` override row exists. */
const STRIPE_CARD = { percentBps: 290, fixedCents: 30 };

async function seedPayer(s: ChapterSetup): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Payer",
      userId: s.userId,
      isTeamMember: true,
      pwEmail: "payer@publicworship.life",
      createdAt: Date.now(),
    }),
  );
}

async function seedRepayment(
  s: ChapterSetup,
  payerPersonId: Id<"people">,
  amountCents: number,
): Promise<Id<"personalRepayments">> {
  const now = Date.now();
  const transactionId = await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents,
      currency: "usd",
      postedAt: now,
      personId: payerPersonId,
      merchantName: "Corner Store",
      status: "reconciled",
      createdAt: now,
    }),
  );
  const repaymentId = await run(s.t, (ctx) =>
    ctx.db.insert("personalRepayments", {
      chapterId: s.chapterId,
      transactionId,
      payerPersonId,
      amountCents,
      method: "card",
      status: "pending",
      createdAt: now,
      updatedAt: now,
    }),
  );
  await run(s.t, (ctx) => ctx.db.patch(transactionId, { isPersonal: true, repaymentId }));
  return repaymentId;
}

describe("repayment fee coverage", () => {
  test("the org nets the debt whole — $100.00 owed is billed $103.30", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPayer(s);
    const repaymentId = await seedRepayment(s, payer, 10_000);

    const prepared = await s.as.mutation(internal.cards.prepareRepaymentCheckout, {
      repaymentIds: [repaymentId],
    });

    expect(prepared.totalCents).toBe(10_000);
    expect(prepared.chargeCents).toBe(grossUpCents(10_000, STRIPE_CARD));
    // The number in the founder's own example, spelled out rather than
    // derived, so a change to the algebra fails HERE with a readable diff.
    expect(prepared.chargeCents).toBe(10_330);
    expect(prepared.feeCents).toBe(330);
    expect(prepared.feeRateLabel).toContain("2.9%");
  });

  test("ONE fee per batch, not one per line — three charges are grossed up together", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPayer(s);
    const ids = [
      await seedRepayment(s, payer, 5_000),
      await seedRepayment(s, payer, 3_000),
      await seedRepayment(s, payer, 2_000),
    ];

    const prepared = await s.as.mutation(internal.cards.prepareRepaymentCheckout, {
      repaymentIds: ids,
    });

    expect(prepared.totalCents).toBe(10_000);
    // Batched: one 30¢ fixed component.
    expect(prepared.chargeCents).toBe(grossUpCents(10_000, STRIPE_CARD));
    // Per-line would have added the fixed 30¢ three times over. Assert the
    // difference explicitly — this is the bug, not an abstract inequality.
    const perLine =
      grossUpCents(5_000, STRIPE_CARD) +
      grossUpCents(3_000, STRIPE_CARD) +
      grossUpCents(2_000, STRIPE_CARD);
    expect(perLine).toBeGreaterThan(prepared.chargeCents);
    expect(perLine - prepared.chargeCents).toBeGreaterThanOrEqual(60);
  });

  test("a stored fee-schedule override is what gets charged — not the published default", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPayer(s);
    const repaymentId = await seedRepayment(s, payer, 10_000);
    // The whole point of `processorFeeSchedule` is that the treasurer can
    // correct the rate without a deploy. If the repayment rail read the
    // published default instead, every repayment would quietly under- or
    // over-collect after the first negotiated rate change.
    await run(s.t, (ctx) =>
      ctx.db.insert("processorFeeSchedule", {
        processor: "stripe",
        method: "card",
        percentBps: 200,
        fixedCents: 0,
        updatedAt: Date.now(),
      }),
    );

    const prepared = await s.as.mutation(internal.cards.prepareRepaymentCheckout, {
      repaymentIds: [repaymentId],
    });
    expect(prepared.chargeCents).toBe(
      grossUpCents(10_000, { percentBps: 200, fixedCents: 0 }),
    );
    expect(prepared.chargeCents).toBeLessThan(10_330);
  });

  test("the quote the payer agrees to is the amount the checkout bills", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPayer(s);
    const a = await seedRepayment(s, payer, 4_237);
    const b = await seedRepayment(s, payer, 911);

    const quote = await s.as.query(api.cards.quoteRepayment, {
      repaymentIds: [a, b],
    });
    const prepared = await s.as.mutation(internal.cards.prepareRepaymentCheckout, {
      repaymentIds: [a, b],
    });

    expect(quote.count).toBe(2);
    expect(quote.totalCents).toBe(prepared.totalCents);
    expect(quote.feeCents).toBe(prepared.feeCents);
    expect(quote.chargeCents).toBe(prepared.chargeCents);
  });

  test("the quote ignores ids that aren't the caller's own outstanding debt", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPayer(s);
    const mine = await seedRepayment(s, payer, 1_000);
    const alreadyPaid = await seedRepayment(s, payer, 5_000);
    await run(s.t, (ctx) =>
      ctx.db.patch(alreadyPaid, { status: "paid", updatedAt: Date.now() }),
    );
    // Someone else's debt, on the same chapter's roster.
    const otherPerson = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Someone Else",
        isTeamMember: true,
        createdAt: Date.now(),
      }),
    );
    const theirs = await seedRepayment(s, otherPerson, 9_900);

    const quote = await s.as.query(api.cards.quoteRepayment, {
      // The same id twice, too — a double-tapped checkbox must not double the
      // amount the payer is quoted.
      repaymentIds: [mine, mine, alreadyPaid, theirs],
    });
    expect(quote.count).toBe(1);
    expect(quote.totalCents).toBe(1_000);
  });

  test("an empty selection quotes zero rather than a bare 30¢ fee", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPayer(s);
    const quote = await s.as.query(api.cards.quoteRepayment, { repaymentIds: [] });
    expect(quote).toEqual({
      count: 0,
      totalCents: 0,
      feeCents: 0,
      chargeCents: 0,
      feeRateLabel: null,
    });
  });

  test("the webhook's discrepancy alarm does NOT fire on a fee-covered payment", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPayer(s);
    const a = await seedRepayment(s, payer, 5_000);
    const b = await seedRepayment(s, payer, 5_000);
    const prepared = await s.as.mutation(internal.cards.prepareRepaymentCheckout, {
      repaymentIds: [a, b],
    });

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await t.mutation(internal.cards.applyRepaymentPaidFromStripe, {
        repaymentIds: [a, b],
        sessionId: "cs_fee_ok",
        paymentIntentId: "pi_fee_ok",
        // What Stripe reports: the debt PLUS the coverage line.
        amountTotalCents: prepared.chargeCents,
        feeCoverageCents: prepared.feeCents,
      });
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }

    const settled = await run(s.t, (ctx) =>
      Promise.all([ctx.db.get(a), ctx.db.get(b)]),
    );
    expect(settled[0]?.status).toBe("paid");
    expect(settled[1]?.status).toBe("paid");
    // Each settles at ITS OWN stored amount — the fee coverage is Stripe's
    // money, never credited against anyone's debt.
    expect(settled[0]?.amountCents).toBe(5_000);
    expect(settled[1]?.amountCents).toBe(5_000);
  });

  test("a REAL discrepancy still fires the alarm, fee coverage notwithstanding", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPayer(s);
    const a = await seedRepayment(s, payer, 5_000);

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await t.mutation(internal.cards.applyRepaymentPaidFromStripe, {
        repaymentIds: [a],
        sessionId: "cs_fee_short",
        amountTotalCents: 4_000, // short, even before coverage
        feeCoverageCents: 150,
      });
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
    // Settled anyway at the stored amount — Stripe already captured the money,
    // and refusing to credit the payer would leave the org holding funds
    // against no debt. Same posture as before fee coverage existed.
    const settled = await run(s.t, (ctx) => ctx.db.get(a));
    expect(settled?.status).toBe("paid");
  });

  test("a session created before fee coverage shipped still reconciles cleanly", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPayer(s);
    const a = await seedRepayment(s, payer, 2_500);

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await t.mutation(internal.cards.applyRepaymentPaidFromStripe, {
        repaymentIds: [a],
        sessionId: "cs_legacy",
        amountTotalCents: 2_500,
        // `feeCoverageCents` omitted entirely — the pre-2026-08-14 shape.
      });
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
