import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { runBookRepaymentCoverageBySession } from "../migrations/0074_book_repayment_coverage_by_session";

/**
 * MIGRATION 0074 — the correction 0073 refused to guess at.
 *
 * 0073 searched for a settled repayment of $6.00 and found none, because the
 * $6.00 was two $3.00 charges bundled into one checkout: an amount that only
 * exists as a sum cannot be found by looking for a row that holds it. So this
 * pins the SESSION.
 *
 * The tests are about the pin's honesty rather than its arithmetic. It states
 * both what the payer owed and what they were charged over it, and the first is
 * checkable — so the question each test asks is: when the rows stop matching
 * what was written down, does it stop?
 */

const SESSION_A =
  "cs_live_b1JlvVjpDnyYdLL9xqtuysYde4EahPkfGYIqS4WNc2YQW12DttT8aJWDOR";

async function seedBundled(
  s: ChapterSetup,
  sessionId: string,
  amounts: number[],
  opts: { settled?: boolean } = {},
) {
  const settled = opts.settled ?? true;
  const payerPersonId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Payer",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  for (const amountCents of amounts) {
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
        isPersonal: true,
        status: "reconciled",
        createdAt: now,
      }),
    );
    const creditTransactionId = settled
      ? await run(s.t, (ctx) =>
          ctx.db.insert("transactions", {
            chapterId: s.chapterId,
            source: "repayment",
            flow: "transfer",
            amountCents,
            currency: "usd",
            postedAt: now,
            personId: payerPersonId,
            status: "reconciled",
            createdAt: now,
          }),
        )
      : undefined;
    await run(s.t, (ctx) =>
      ctx.db.insert("personalRepayments", {
        chapterId: s.chapterId,
        transactionId,
        payerPersonId,
        amountCents,
        method: "card",
        status: settled ? "paid" : "pending",
        stripeCheckoutSessionId: sessionId,
        ...(creditTransactionId ? { creditTransactionId } : {}),
        createdAt: now,
        updatedAt: now,
      }),
    );
  }
}

async function coverageRows(s: ChapterSetup) {
  return run(s.t, (ctx) =>
    ctx.db
      .query("transactions")
      .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
      .collect(),
  ).then((rows) => rows.filter((r) => r.feeCoverageOrigin === "repayment"));
}

describe("it books the bundled payment 0073 could not find", () => {
  test("two $3.00 charges in one checkout get the 49¢ their total was charged", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBundled(s, SESSION_A, [300, 300]);

    const result = await run(s.t, (ctx) => runBookRepaymentCoverageBySession(ctx));

    // The second pinned session isn't in this fixture, so it refuses — which is
    // itself the behaviour under test everywhere below.
    expect(result.booked).toBe(1);
    expect(result.centsBooked).toBe(49);

    const rows = await coverageRows(s);
    expect(rows).toHaveLength(1);
    expect(rows[0].amountCents).toBe(49);
    expect(rows[0].flow).toBe("inflow");
    expect(rows[0].externalId).toBe(
      `stripe_repayment_fee_coverage:${SESSION_A}`,
    );
  });

  test("running it twice books the money once", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBundled(s, SESSION_A, [300, 300]);

    await run(s.t, (ctx) => runBookRepaymentCoverageBySession(ctx));
    await run(s.t, (ctx) => runBookRepaymentCoverageBySession(ctx));

    expect(await coverageRows(s)).toHaveLength(1);
  });
});

describe("it refuses when the rows stop matching what was written down", () => {
  test("a session whose debts no longer sum to the recorded total is refused", async () => {
    // The pin says $6.00 across this session. If it settles $9.00, this is not
    // the payment it was told about, and 49¢ is not its coverage.
    const t = newT();
    const s = await setupChapter(t);
    await seedBundled(s, SESSION_A, [300, 300, 300]);

    const result = await run(s.t, (ctx) => runBookRepaymentCoverageBySession(ctx));

    expect(result.booked).toBe(0);
    expect(result.refused).toBe(2); // both pinned sessions unbookable here
    expect(await coverageRows(s)).toHaveLength(0);
  });

  test("an unsettled session is not booked", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBundled(s, SESSION_A, [300, 300], { settled: false });

    const result = await run(s.t, (ctx) => runBookRepaymentCoverageBySession(ctx));

    expect(result.booked).toBe(0);
    expect(await coverageRows(s)).toHaveLength(0);
  });

  test("an unrelated session is left alone entirely", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedBundled(s, "cs_live_somethingelse", [300, 300]);

    const result = await run(s.t, (ctx) => runBookRepaymentCoverageBySession(ctx));

    expect(result.booked).toBe(0);
    expect(await coverageRows(s)).toHaveLength(0);
  });
});
