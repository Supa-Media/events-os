/// <reference types="vite/client" />
/**
 * THE BANK-TRANSFER REPAYMENT RAIL, and the days-long gap it introduces.
 *
 * Founder, 2026-08-14, on being shown that card costs the payer 2.9% + 30¢
 * against ACH's 0.8% capped at $5.00: "yes, add Stripe ACH next."
 *
 * A card payment settles in the same instant the payer finishes the form, so
 * for two years this codebase could treat "checkout completed" and "money
 * arrived" as one event. A bank debit breaks that: `checkout.session.completed`
 * fires when the payer authorises it, and about four business days later one of
 * `async_payment_succeeded` / `async_payment_failed` says what actually
 * happened. Everything that can go wrong with repayments lives in that gap, so
 * that is what these tests are about:
 *
 *  · AUTHORISED IS NOT PAID. No credit, no cleared flag, nothing in the ledger
 *    until the money lands — the same rule the giving side already enforces.
 *  · AUTHORISED IS NOT UNPAID EITHER. The charge moves to `processing`, which
 *    is what stops the payer opening the page next morning, reading "you owe
 *    $248", and paying it a second time.
 *  · A REFUSED DEBIT PUTS THE DEBT BACK. `failed`, not silently `pending`, so
 *    the payer can be told their bank refused it.
 *  · AN ABANDONED SESSION LEAVES NO SCARS, and cannot knock a LATER live
 *    payment back to unpaid.
 */
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { grossUpCents } from "@events-os/shared";

/** Stripe's published US rates — what `DEFAULT_FEE_SCHEDULE` resolves to with
 *  no `processorFeeSchedule` override row present. */
const CARD = { percentBps: 290, fixedCents: 30 };
const ACH = { percentBps: 80, fixedCents: 0, capCents: 500 };

async function seedPayer(s: ChapterSetup): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Payer",
      userId: s.userId,
      isTeamMember: true,
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

describe("repayment rails — pricing", () => {
  test("the bank rail is quoted at the bank rate, and it is much cheaper", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPayer(s);
    // The founder's own example: a $248 charge.
    const repaymentId = await seedRepayment(s, payer, 24_800);

    const quote = await s.as.query(api.cards.quoteRepayment, {
      repaymentIds: [repaymentId],
    });

    expect(quote.totalCents).toBe(24_800);
    expect(quote.card.chargeCents).toBe(grossUpCents(24_800, CARD));
    expect(quote.ach.chargeCents).toBe(grossUpCents(24_800, ACH));
    // Spelled out as well as derived, because these are the numbers the choice
    // is actually made on. Note they are the GROSS-UP, slightly above the fee
    // the org would otherwise absorb ($7.49 / $1.98): covering a fee means
    // paying the rail's percentage on the larger amount too. See
    // `grossUpCents`'s own doc for why adding the fee on top undercharges.
    expect(quote.card.feeCents).toBe(772);
    expect(quote.ach.feeCents).toBe(200);
    expect(quote.ach.rateLabel).toContain("0.8%");
    // The whole argument for offering the slower rail.
    expect(quote.card.feeCents - quote.ach.feeCents).toBeGreaterThan(500);
  });

  test("above the cap, the bank fee stops growing and the card fee doesn't", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPayer(s);
    // ACH caps at $5.00; the cap binds well before this.
    const repaymentId = await seedRepayment(s, payer, 200_000);

    const quote = await s.as.query(api.cards.quoteRepayment, {
      repaymentIds: [repaymentId],
    });
    expect(quote.ach.feeCents).toBe(500);
    expect(quote.card.feeCents).toBeGreaterThan(5_000);
  });

  test("the checkout bills the rail the payer picked, not always the card", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPayer(s);
    const repaymentId = await seedRepayment(s, payer, 24_800);

    const card = await s.as.mutation(internal.cards.prepareRepaymentCheckout, {
      repaymentIds: [repaymentId],
      method: "card",
    });
    expect(card.chargeCents).toBe(grossUpCents(24_800, CARD));
    // Card takes Stripe's default method list, so wallets stay available.
    expect(card.paymentMethodTypes).toBeNull();

    const ach = await s.as.mutation(internal.cards.prepareRepaymentCheckout, {
      repaymentIds: [repaymentId],
      method: "ach",
    });
    expect(ach.chargeCents).toBe(grossUpCents(24_800, ACH));
    expect(ach.paymentMethodTypes).toEqual(["us_bank_account"]);

    // The chosen rail is stamped on the row, so the record says how it was
    // actually paid rather than what it was flagged as.
    const stored = await run(s.t, (ctx) => ctx.db.get(repaymentId));
    expect(stored?.method).toBe("ach");
  });
});

describe("repayment rails — the days-long gap", () => {
  test("an authorised bank debit is PROCESSING: no credit, no cleared flag", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPayer(s);
    const repaymentId = await seedRepayment(s, payer, 24_800);

    await t.mutation(internal.cards.markRepaymentsProcessing, {
      repaymentIds: [repaymentId],
      sessionId: "cs_ach_pending",
    });

    const row = await run(s.t, (ctx) => ctx.db.get(repaymentId));
    expect(row?.status).toBe("processing");
    // Nothing about the ledger has moved. The debt is still the org's to
    // collect and the charge is still personal.
    expect(row?.creditTransactionId).toBeUndefined();
    const credits = await run(s.t, (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    ).then((rows) => rows.filter((r) => r.source === "repayment"));
    expect(credits).toHaveLength(0);
  });

  test("a charge already clearing cannot be put into a SECOND checkout", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPayer(s);
    const clearing = await seedRepayment(s, payer, 24_800);
    const untouched = await seedRepayment(s, payer, 1_000);

    await t.mutation(internal.cards.markRepaymentsProcessing, {
      repaymentIds: [clearing],
      sessionId: "cs_ach_pending",
    });

    // This is the double-collection this state exists to prevent: the debt is
    // still outstanding by every accounting measure, and must not be billable.
    const prepared = await s.as.mutation(internal.cards.prepareRepaymentCheckout, {
      repaymentIds: [clearing, untouched],
      method: "card",
    });
    expect(prepared.lines).toHaveLength(1);
    expect(prepared.lines[0].repaymentId).toBe(untouched);

    // …and the quote agrees, so the payer is never shown a total they cannot
    // be charged.
    const quote = await s.as.query(api.cards.quoteRepayment, {
      repaymentIds: [clearing, untouched],
    });
    expect(quote.count).toBe(1);
    expect(quote.totalCents).toBe(1_000);
  });

  test("it is still OUTSTANDING while clearing — the org hasn't been paid yet", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPayer(s);
    const repaymentId = await seedRepayment(s, payer, 24_800);
    // The aggregate is a manager-facing read (viewer+), so the caller needs a
    // grant — this test is about what the COLLECTOR sees, not the payer.
    await run(s.t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId: payer,
        role: "viewer",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );
    await t.mutation(internal.cards.markRepaymentsProcessing, {
      repaymentIds: [repaymentId],
      sessionId: "cs_ach_pending",
    });

    // The collections aggregate must still count it. A chapter whose "personal
    // charges outstanding" dropped the moment somebody clicked pay would be
    // reporting money it does not have.
    const agg = await s.as.query(api.cards.personalRepaymentsOutstanding, {});
    expect(agg.count).toBe(1);
    expect(agg.totalCents).toBe(24_800);
  });

  test("the debit clears days later and settles exactly as a card would", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPayer(s);
    const repaymentId = await seedRepayment(s, payer, 24_800);
    const prepared = await s.as.mutation(internal.cards.prepareRepaymentCheckout, {
      repaymentIds: [repaymentId],
      method: "ach",
    });
    await t.mutation(internal.cards.markRepaymentsProcessing, {
      repaymentIds: [repaymentId],
      sessionId: "cs_ach",
    });

    await t.mutation(internal.cards.applyRepaymentPaidFromStripe, {
      repaymentIds: [repaymentId],
      sessionId: "cs_ach",
      paymentIntentId: "pi_ach",
      amountTotalCents: prepared.chargeCents,
      feeCoverageCents: prepared.feeCents,
    });

    const row = await run(s.t, (ctx) => ctx.db.get(repaymentId));
    expect(row?.status).toBe("paid");
    expect(row?.creditTransactionId).toBeTruthy();
    const credits = await run(s.t, (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    ).then((rows) => rows.filter((r) => r.source === "repayment"));

    // TWO rows, and the difference between them is the whole point.
    //
    // The CREDIT is still exactly the debt — a debt cannot be overpaid, and
    // widening it would stop the pair netting the personal charge. That half
    // of the old assertion was right and is unchanged.
    //
    // What was missing is the COVERAGE. The monthly fee sweep books every cent
    // Stripe took, this payment's cut included, so a coverage that went
    // unrecorded left the fee expense unfunded and sank book value by exactly
    // it — 49¢ on a $6.00 repayment, and the org's own cash reading as
    // unexplained (founder, 2026-08-14). It arrived; it is booked.
    expect(credits).toHaveLength(2);

    const credit = credits.find((r) => r.feeCoverageOrigin == null);
    expect(credit?.amountCents).toBe(24_800);
    expect(credit?.flow).toBe("transfer");

    const coverage = credits.find((r) => r.feeCoverageOrigin === "repayment");
    expect(coverage?.amountCents).toBe(prepared.feeCents);
    // INFLOW, not transfer: nobody owed it and it came from outside the org,
    // so it has to carry positive signed value or it cannot offset the fee.
    expect(coverage?.flow).toBe("inflow");
    expect(coverage?.externalId).toBe("stripe_repayment_fee_coverage:cs_ach");
    // Together they equal what the payer was actually charged.
    expect((credit?.amountCents ?? 0) + (coverage?.amountCents ?? 0)).toBe(
      prepared.chargeCents,
    );
  });

  test("a redelivered webhook does not book the coverage twice", async () => {
    // Stripe delivers at least once. The credit is guarded by
    // `creditTransactionId`, but the coverage row is posted outside that loop
    // and needed its own guard — without it a redelivery credits the org money
    // nobody sent, which is the same bug this whole change exists to fix,
    // pointed the other way.
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPayer(s);
    const repaymentId = await seedRepayment(s, payer, 24_800);
    const prepared = await s.as.mutation(internal.cards.prepareRepaymentCheckout, {
      repaymentIds: [repaymentId],
      method: "ach",
    });
    await t.mutation(internal.cards.markRepaymentsProcessing, {
      repaymentIds: [repaymentId],
      sessionId: "cs_ach_dupe",
    });

    for (let i = 0; i < 3; i++) {
      await t.mutation(internal.cards.applyRepaymentPaidFromStripe, {
        repaymentIds: [repaymentId],
        sessionId: "cs_ach_dupe",
        paymentIntentId: "pi_ach_dupe",
        amountTotalCents: prepared.chargeCents,
        feeCoverageCents: prepared.feeCents,
      });
    }

    const rows = await run(s.t, (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    ).then((all) => all.filter((r) => r.feeCoverageOrigin === "repayment"));
    expect(rows).toHaveLength(1);
    expect(rows[0].amountCents).toBe(prepared.feeCents);
  });

  test("a REFUSED debit puts the debt back, marked failed", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPayer(s);
    const repaymentId = await seedRepayment(s, payer, 24_800);
    await t.mutation(internal.cards.markRepaymentsProcessing, {
      repaymentIds: [repaymentId],
      sessionId: "cs_ach_bounce",
    });

    await t.mutation(internal.cards.releaseRepaymentCheckout, {
      sessionId: "cs_ach_bounce",
      outcome: "failed",
    });

    const row = await run(s.t, (ctx) => ctx.db.get(repaymentId));
    // `failed`, not `pending`: "your bank refused this" is something the payer
    // needs told, and a row that quietly reverted would leave them wondering
    // why a payment they made never happened.
    expect(row?.status).toBe("failed");
    expect(row?.creditTransactionId).toBeUndefined();

    // And it is payable again — the whole point of putting it back.
    const quote = await s.as.query(api.cards.quoteRepayment, {
      repaymentIds: [repaymentId],
    });
    expect(quote.count).toBe(1);
  });

  test("an ABANDONED session goes back to plain pending — nothing was attempted", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPayer(s);
    const repaymentId = await seedRepayment(s, payer, 5_000);
    await t.mutation(internal.cards.markRepaymentsProcessing, {
      repaymentIds: [repaymentId],
      sessionId: "cs_walked_away",
    });

    await t.mutation(internal.cards.releaseRepaymentCheckout, {
      sessionId: "cs_walked_away",
      outcome: "expired",
    });

    const row = await run(s.t, (ctx) => ctx.db.get(repaymentId));
    expect(row?.status).toBe("pending");
  });

  test("a stale failure for an OLD session cannot knock a newer payment back", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPayer(s);
    const repaymentId = await seedRepayment(s, payer, 5_000);

    // First attempt: abandoned, but its expiry event is slow to arrive.
    await t.mutation(internal.cards.markRepaymentsProcessing, {
      repaymentIds: [repaymentId],
      sessionId: "cs_first",
    });
    // The payer starts again and this one is clearing.
    await t.mutation(internal.cards.markRepaymentsProcessing, {
      repaymentIds: [repaymentId],
      sessionId: "cs_second",
    });

    // NOW the first session's expiry lands. It must not touch the live one —
    // the release is scoped by the session the row is actually holding.
    await t.mutation(internal.cards.releaseRepaymentCheckout, {
      sessionId: "cs_first",
      outcome: "expired",
    });

    const row = await run(s.t, (ctx) => ctx.db.get(repaymentId));
    expect(row?.status).toBe("processing");
    expect(row?.stripeCheckoutSessionId).toBe("cs_second");
  });

  test("a late failure never un-settles money that already arrived", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const payer = await seedPayer(s);
    const repaymentId = await seedRepayment(s, payer, 5_000);
    await t.mutation(internal.cards.markRepaymentsProcessing, {
      repaymentIds: [repaymentId],
      sessionId: "cs_settled_then_failed",
    });
    await t.mutation(internal.cards.applyRepaymentPaidFromStripe, {
      repaymentIds: [repaymentId],
      sessionId: "cs_settled_then_failed",
      amountTotalCents: 5_000,
    });

    await t.mutation(internal.cards.releaseRepaymentCheckout, {
      sessionId: "cs_settled_then_failed",
      outcome: "failed",
    });

    const row = await run(s.t, (ctx) => ctx.db.get(repaymentId));
    expect(row?.status).toBe("paid");
    expect(row?.creditTransactionId).toBeTruthy();
  });
});
