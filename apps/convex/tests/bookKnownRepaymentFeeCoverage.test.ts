import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runBookKnownRepaymentFeeCoverage } from "../migrations/0073_book_known_repayment_fee_coverage";
import type { Id } from "../_generated/dataModel";

/**
 * MIGRATION 0073 — booking the 49¢ that already happened.
 *
 * The entry is PINNED (a $6.00 debt, 49¢ of coverage, exactly one row), so what
 * these tests are really about is the guard around it. The hazard is not the
 * arithmetic — the founder read the numbers off Stripe — it is applying them to
 * the WRONG row: a $6.00 repayment that settled at face value before fee
 * coverage existed would be credited money nobody sent, which is this whole bug
 * pointed the other way.
 *
 * So: it books the row it was told about, and in every situation where it
 * cannot be sure which row that is, it books NOTHING and says why.
 */

/** A settled Stripe repayment, as the webhook leaves one. `settledAt` drives
 *  `updatedAt`, which is the migration's "could this have carried coverage?"
 *  bound. */
async function seedSettledRepayment(
  s: ChapterSetup,
  opts: {
    amountCents: number;
    sessionId: string;
    settledAt: number;
    status?: "paid" | "pending";
    withCredit?: boolean;
  },
): Promise<Id<"personalRepayments">> {
  const payerPersonId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Payer",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  const transactionId = await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "manual",
      flow: "outflow",
      amountCents: opts.amountCents,
      currency: "usd",
      postedAt: opts.settledAt,
      personId: payerPersonId,
      merchantName: "MTA",
      isPersonal: true,
      status: "reconciled",
      createdAt: opts.settledAt,
    }),
  );
  const withCredit = opts.withCredit ?? true;
  const creditTransactionId = withCredit
    ? await run(s.t, (ctx) =>
        ctx.db.insert("transactions", {
          chapterId: s.chapterId,
          source: "repayment",
          flow: "transfer",
          amountCents: opts.amountCents,
          currency: "usd",
          postedAt: opts.settledAt,
          personId: payerPersonId,
          status: "reconciled",
          createdAt: opts.settledAt,
        }),
      )
    : undefined;
  return await run(s.t, (ctx) =>
    ctx.db.insert("personalRepayments", {
      chapterId: s.chapterId,
      transactionId,
      payerPersonId,
      amountCents: opts.amountCents,
      method: "card",
      status: opts.status ?? "paid",
      stripeCheckoutSessionId: opts.sessionId,
      ...(creditTransactionId ? { creditTransactionId } : {}),
      createdAt: opts.settledAt,
      updatedAt: opts.settledAt,
    }),
  );
}

/** After fee coverage shipped (#708, 2026-08-13 22:19:56 ET). */
const AFTER = Date.parse("2026-08-14T14:00:00Z");
/** Before it — a repayment billed at face value. */
const BEFORE = Date.parse("2026-08-01T14:00:00Z");

async function coverageRows(s: ChapterSetup) {
  return run(s.t, (ctx) =>
    ctx.db
      .query("transactions")
      .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
      .collect(),
  ).then((rows) => rows.filter((r) => r.feeCoverageOrigin === "repayment"));
}

describe("it books the payment it was told about", () => {
  test("the founder's 49¢ lands on the $6.00 repayment", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSettledRepayment(s, {
      amountCents: 600,
      sessionId: "cs_the_one",
      settledAt: AFTER,
    });

    const result = await run(s.t, (ctx) => runBookKnownRepaymentFeeCoverage(ctx));

    expect(result.booked).toBe(1);
    expect(result.centsBooked).toBe(49);
    expect(result.refused).toBe(0);
    const rows = await coverageRows(s);
    expect(rows).toHaveLength(1);
    expect(rows[0].amountCents).toBe(49);
    // Written by the SAME writer the live webhook uses, so it is
    // indistinguishable from a row a payment produced.
    expect(rows[0].flow).toBe("inflow");
    expect(rows[0].externalId).toBe("stripe_repayment_fee_coverage:cs_the_one");
    expect(rows[0].status).toBe("reconciled");
  });

  test("running it twice books nothing the second time", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSettledRepayment(s, {
      amountCents: 600,
      sessionId: "cs_the_one",
      settledAt: AFTER,
    });

    await run(s.t, (ctx) => runBookKnownRepaymentFeeCoverage(ctx));
    await run(s.t, (ctx) => runBookKnownRepaymentFeeCoverage(ctx));

    // The ledger skips a second run in production; this proves the writer's own
    // `externalId` guard holds even without it.
    expect(await coverageRows(s)).toHaveLength(1);
  });
});

describe("it refuses rather than guessing", () => {
  test("a same-amount repayment from BEFORE fee coverage is not a candidate", async () => {
    // The hazard the pin exists to survive: $6.00 repaid at face value in
    // July. Crediting it 49¢ would invent money nobody sent.
    const t = newT();
    const s = await setupChapter(t);
    await seedSettledRepayment(s, {
      amountCents: 600,
      sessionId: "cs_july",
      settledAt: BEFORE,
    });

    const result = await run(s.t, (ctx) => runBookKnownRepaymentFeeCoverage(ctx));

    // Zero candidates ≠ the expected one, so the entry is refused whole.
    expect(result.booked).toBe(0);
    expect(result.refused).toBe(1);
    expect(await coverageRows(s)).toHaveLength(0);
  });

  test("TWO matching repayments refuse the entry entirely", async () => {
    // The assumption behind the pin — "there is one of these" — is no longer
    // true, so there is no honest way to pick. Neither gets the money.
    const t = newT();
    const s = await setupChapter(t);
    await seedSettledRepayment(s, {
      amountCents: 600,
      sessionId: "cs_a",
      settledAt: AFTER,
    });
    await seedSettledRepayment(s, {
      amountCents: 600,
      sessionId: "cs_b",
      settledAt: AFTER,
    });

    const result = await run(s.t, (ctx) => runBookKnownRepaymentFeeCoverage(ctx));

    expect(result.booked).toBe(0);
    expect(result.refused).toBe(1);
    expect(await coverageRows(s)).toHaveLength(0);
  });

  test("a repayment that never settled is not a candidate", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSettledRepayment(s, {
      amountCents: 600,
      sessionId: "cs_pending",
      settledAt: AFTER,
      status: "pending",
      withCredit: false,
    });

    const result = await run(s.t, (ctx) => runBookKnownRepaymentFeeCoverage(ctx));

    expect(result.booked).toBe(0);
    expect(result.refused).toBe(1);
    expect(await coverageRows(s)).toHaveLength(0);
  });

  test("an unrelated repayment amount is left completely alone", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedSettledRepayment(s, {
      amountCents: 600,
      sessionId: "cs_the_one",
      settledAt: AFTER,
    });
    await seedSettledRepayment(s, {
      amountCents: 24_800,
      sessionId: "cs_other",
      settledAt: AFTER,
    });

    const result = await run(s.t, (ctx) => runBookKnownRepaymentFeeCoverage(ctx));

    expect(result.booked).toBe(1);
    const rows = await coverageRows(s);
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe("stripe_repayment_fee_coverage:cs_the_one");
  });
});
