/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, disarmCodingPolicy } from "./setup.helpers";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * THE MIS-SCOPED-ROWS REPORT.
 *
 * The scope work refuses a cross-scope coding at the door, so a row like the
 * ones below can no longer be CREATED — which is exactly why the fixtures here
 * insert them directly. This is a forensic tool for history, and the only way
 * to test a forensic tool is to manufacture the history it exists to find.
 *
 * What matters is that it distinguishes the three situations, because they have
 * three different and non-interchangeable remedies:
 *  - nothing sent yet          → cancel and re-compose, costs nothing
 *  - money left the wrong book → an inter-book TRANSFER, a real financial act
 *  - the month is published    → an amendment, governed by Bylaws Article XI
 */

async function seedScoped(): Promise<{
  t: ReturnType<typeof newT>;
  chapterId: Id<"chapters">;
  chapterBudgetId: Id<"budgets">;
  centralBudgetId: Id<"budgets">;
}> {
  const t = newT();
  const s = await setupChapter(t);
  await disarmCodingPolicy(t);
  const chapterBudgetId = await run(t, (ctx) =>
    ctx.db.insert("budgets", {
      chapterId: s.chapterId,
      amountCents: 500_000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      label: "Chapter production",
      createdAt: Date.now(),
    }),
  );
  const centralBudgetId = await run(t, (ctx) =>
    ctx.db.insert("budgets", {
      chapterId: "central",
      amountCents: 5_000_000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      label: "City Launch Fund",
      createdAt: Date.now(),
    }),
  );
  return { t, chapterId: s.chapterId, chapterBudgetId, centralBudgetId };
}

/** A pre-fix row: booked to a chapter, funded by a central budget. */
async function seedLegacyPayment(
  t: ReturnType<typeof newT>,
  args: {
    chapterId: Id<"chapters">;
    budgetId: Id<"budgets">;
    status: "approved" | "paid";
  },
): Promise<Id<"contractorPayments">> {
  return await run(t, (ctx) =>
    ctx.db.insert("contractorPayments", {
      chapterId: args.chapterId,
      token: `tok_${Math.random()}`,
      status: args.status,
      origin: "staff_prefilled",
      payeeName: "Jane Contractor",
      serviceDescription: "Mixing and mastering the launch record",
      agreedAmountCents: 120_000,
      agreementTermsVersion: 1,
      budgetId: args.budgetId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

describe("the mis-scoped contractor payment report", () => {
  test("a clean deployment reports nothing to do", async () => {
    const { t, chapterId, chapterBudgetId } = await seedScoped();
    await seedLegacyPayment(t, {
      chapterId,
      budgetId: chapterBudgetId,
      status: "approved",
    });

    const out = await t.query(internal.contractorScopeAudit.report, {});
    expect(out.mismatchedCount).toBe(0);
    expect(out.clean).toBe(1);
    expect(out.note).toContain("No migration is needed");
  });

  test("an unpaid mis-scoped payment is the cheap case", async () => {
    const { t, chapterId, centralBudgetId } = await seedScoped();
    await seedLegacyPayment(t, {
      chapterId,
      budgetId: centralBudgetId,
      status: "approved",
    });

    const out = await t.query(internal.contractorScopeAudit.report, {});
    expect(out.mismatchedCount).toBe(1);
    const row = out.mismatched[0];
    expect(row.fundedBy).toBe("Central");
    expect(row.moneyMoved).toBe(false);
    expect(row.monthPublished).toBe(false);
    // Nothing was sent, so there is nothing to unwind.
    expect(row.suggestedFix).toContain("re-compose");
  });

  test("money that left the wrong book asks for a transfer, not a relabel", async () => {
    const { t, chapterId, centralBudgetId } = await seedScoped();
    const paymentId = await seedLegacyPayment(t, {
      chapterId,
      budgetId: centralBudgetId,
      status: "paid",
    });
    // The bank event: funds really did leave THIS chapter's account.
    await run(t, (ctx) =>
      ctx.db.insert("payouts", {
        chapterId,
        contractorPaymentId: paymentId,
        amountCents: 120_000,
        provider: "manual",
        status: "paid",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await run(t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId,
        source: "contractor_payment",
        flow: "outflow",
        amountCents: 120_000,
        currency: "usd",
        postedAt: Date.now(),
        contractorPaymentId: paymentId,
        budgetId: centralBudgetId,
        status: "reconciled",
        createdAt: Date.now(),
      }),
    );

    const out = await t.query(internal.contractorScopeAudit.report, {});
    const row = out.mismatched[0];
    expect(row.moneyMoved).toBe(true);
    expect(row.paidFromScope).not.toBe("Central");
    // THE POINT. Rewriting `payouts.chapterId` would make the database claim
    // funds left an account they never touched — a worse defect than the one
    // being fixed.
    expect(row.suggestedFix).toContain("transfer");
    expect(row.suggestedFix).toContain("do not relabel the payout");
  });

  test("a published month is flagged as an amendment, and sorts first", async () => {
    const { t, chapterId, centralBudgetId } = await seedScoped();
    const postedAt = Date.now();

    // One unpaid mismatch, and one whose month is already public.
    await seedLegacyPayment(t, {
      chapterId,
      budgetId: centralBudgetId,
      status: "approved",
    });
    const publishedId = await seedLegacyPayment(t, {
      chapterId,
      budgetId: centralBudgetId,
      status: "paid",
    });
    await run(t, (ctx) =>
      ctx.db.insert("payouts", {
        chapterId,
        contractorPaymentId: publishedId,
        amountCents: 120_000,
        provider: "manual",
        status: "paid",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await run(t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId,
        source: "contractor_payment",
        flow: "outflow",
        amountCents: 120_000,
        currency: "usd",
        postedAt,
        contractorPaymentId: publishedId,
        budgetId: centralBudgetId,
        status: "reconciled",
        createdAt: Date.now(),
      }),
    );
    const periodKey = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
    })
      .format(postedAt)
      .slice(0, 7);
    await run(t, (ctx) =>
      ctx.db.insert("financePublications", {
        scope: chapterId,
        periodKey,
        status: "published",
        liveRevision: 1,
        isLive: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const out = await t.query(internal.contractorScopeAudit.report, {});
    expect(out.mismatchedCount).toBe(2);
    // Worst first — a published month is the one that needs a human soonest.
    expect(out.mismatched[0].contractorPaymentId).toBe(publishedId);
    expect(out.mismatched[0].monthPublished).toBe(true);
    expect(out.mismatched[0].suggestedFix).toContain("PUBLISHED");
  });

  test("an uncoded request is not a mismatch", async () => {
    const { t, chapterId } = await seedScoped();
    await run(t, (ctx) =>
      ctx.db.insert("contractorPayments", {
        chapterId,
        token: "tok_uncoded",
        status: "submitted",
        origin: "self_serve",
        payeeName: "Someone",
        serviceDescription: "Sound engineering for the spring concert",
        agreedAmountCents: 40_000,
        agreementTermsVersion: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const out = await t.query(internal.contractorScopeAudit.report, {});
    // `approve` already refuses to release money until a human codes it, so an
    // uncoded row is a queue item, not a books problem.
    expect(out.uncoded).toBe(1);
    expect(out.mismatchedCount).toBe(0);
  });
});
