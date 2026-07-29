/// <reference types="vite/client" />
/**
 * Reimbursement payouts are SPEND (founder report, 2026-07-26).
 *
 * A paid reimbursement is the chapter buying something — someone fronted the
 * money and is being paid back. No card charge ever syncs for it, so the
 * payout row (`increase.ts#postReimbursementSpend`) is the ONLY place that
 * expense can enter the ledger. It used to post `flow:"transfer"`, which
 * `countsAsSpend` excludes from every budget/category total, on a
 * double-count theory that assumed the line items were booked somewhere else.
 * They never were: no rollup reads `reimbursementLineItems`, and
 * `matchedTransactionId` is never written. The visible symptom was a payout
 * showing a budget, a category and an amount in the UI while both bars stayed
 * at $0.
 *
 * These tests pin the behavior end to end — the payout posts as `outflow`,
 * the ported category/budget actually move the dashboard's numbers, a bounced
 * ACH takes the spend back out, and genuine transfers (skim/grant legs,
 * personal-charge repayment credits) still don't count.
 *
 * Migration 0044 (the historical flip) is covered in `migrations0044.test.ts`.
 */
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/** Eastern-noon timestamp on a given day — the period bucketing `inPeriod`
 *  uses is Eastern, so noon keeps the day unambiguous either side of DST. */
function tsOnDay(year: number, month: number, day: number): number {
  return Date.parse(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T16:00:00Z`);
}

async function seedManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Treasurer",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

async function seedPerson(s: ChapterSetup, name: string): Promise<Id<"people">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("people", { chapterId: s.chapterId, name, createdAt: Date.now() }),
  );
}

async function seedFund(s: ChapterSetup): Promise<Id<"funds">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("funds", {
      chapterId: s.chapterId,
      name: "General",
      restriction: "unrestricted",
      sortOrder: 0,
      createdAt: Date.now(),
    }),
  );
}

async function seedCategory(
  s: ChapterSetup,
  fundId: Id<"funds">,
  name: string,
): Promise<Id<"budgetCategories">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("budgetCategories", {
      chapterId: s.chapterId,
      fundId,
      name,
      kind: "category",
      sortOrder: 0,
      createdAt: Date.now(),
    }),
  );
}

/** `createBudget` starts every budget at `"draft"`, and only an APPROVED
 *  budget accepts attribution — same direct patch `financeTxnAttribution`
 *  uses, for the same reason (these tests are about money math, not the
 *  approval workflow). */
async function seedApprovedMonthlyBudget(
  s: ChapterSetup,
  opts: { amountCents: number; year: number; month: number },
): Promise<Id<"budgets">> {
  const budgetId = await s.as.mutation(api.finances.createBudget, {
    amountCents: opts.amountCents,
    type: "recurring",
    cadence: "monthly",
    year: opts.year,
    month: opts.month,
    label: "Operating Expenses",
  });
  await run(s.t, (ctx) => ctx.db.patch(budgetId, { approvalStatus: "approved" }));
  return budgetId;
}

/** An `approved` reimbursement with one line item, coded like the real form
 *  does: a "For" budget on the request, a category on the line. */
async function seedApprovedReimbursement(
  s: ChapterSetup,
  opts: {
    payeePersonId: Id<"people">;
    amountCents: number;
    budgetId?: Id<"budgets">;
    categoryId?: Id<"budgetCategories">;
    lineDescription?: string;
  },
): Promise<Id<"reimbursementRequests">> {
  const now = Date.now();
  const reimbursementId = await run(s.t, (ctx) =>
    ctx.db.insert("reimbursementRequests", {
      chapterId: s.chapterId,
      token: crypto.randomUUID(),
      status: "approved",
      payeeName: "Sarah",
      payeeEmail: "sarah@example.com",
      personId: opts.payeePersonId,
      budgetId: opts.budgetId,
      totalCents: opts.amountCents,
      approvedCents: opts.amountCents,
      bankAccountLast4: "1234",
      submittedAt: now,
      approvedAt: now,
      createdAt: now,
      updatedAt: now,
    }),
  );
  await run(s.t, (ctx) =>
    ctx.db.insert("reimbursementLineItems", {
      chapterId: s.chapterId,
      reimbursementId,
      description: opts.lineDescription ?? "Dig Inn",
      amountCents: opts.amountCents,
      categoryId: opts.categoryId,
      order: 0,
      createdAt: now,
    }),
  );
  return reimbursementId;
}

/** Pin the payout row's `postedAt` into the month under test. The insert
 *  stamps `Date.now()`, so without this every assertion below would silently
 *  depend on the wall clock still being July 2026. */
async function postPayoutOn(
  s: ChapterSetup,
  reimbursementId: Id<"reimbursementRequests">,
  postedAt: number,
): Promise<void> {
  const txn = await payoutTxn(s, reimbursementId);
  if (!txn) throw new Error("expected a payout transaction to pin");
  await run(s.t, (ctx) => ctx.db.patch(txn._id, { postedAt }));
}

async function payoutTxn(s: ChapterSetup, reimbursementId: Id<"reimbursementRequests">) {
  return run(s.t, (ctx) =>
    ctx.db
      .query("transactions")
      .withIndex("by_reimbursement", (q) => q.eq("reimbursementId", reimbursementId))
      .first(),
  );
}

describe("a paid reimbursement registers as spend", () => {
  test("the payout posts as outflow and lands in the budget + category it's coded to", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const sarah = await seedPerson(s, "Sarah");
    const fundId = await seedFund(s);
    const categoryId = await seedCategory(s, fundId, "Food & Meals");
    const budgetId = await seedApprovedMonthlyBudget(s, {
      amountCents: 30_000,
      year: 2026,
      month: 7,
    });

    const reimbursementId = await seedApprovedReimbursement(s, {
      payeePersonId: sarah,
      amountCents: 30_386,
      budgetId,
      categoryId,
    });

    await s.as.mutation(api.increasePayouts.markPaidManually, { reimbursementId });
    await postPayoutOn(s, reimbursementId, tsOnDay(2026, 7, 22));

    // The ledger row itself: an expense, not a transfer.
    const txn = await payoutTxn(s, reimbursementId);
    expect(txn?.flow).toBe("outflow");
    expect(txn?.amountCents).toBe(30_386);
    expect(txn?.budgetId).toBe(budgetId);
    expect(txn?.categoryId).toBe(categoryId);

    // ...and the dashboard agrees. This is the whole point: before the fix
    // the card read $0 while the modal showed the budget and category above.
    const dash = await s.as.query(api.finances.dashboardChapter, { year: 2026, month: 7 });
    const card = dash.recurringBudgets.find((b) => b.id === budgetId);
    expect(card?.spentCents).toBe(30_386);
    expect(card?.categories?.find((c) => c.name === "Food & Meals")?.spentCents).toBe(30_386);
  });

  test("a bounced ACH takes the spend back out of the budget", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const sarah = await seedPerson(s, "Sarah");
    const fundId = await seedFund(s);
    const categoryId = await seedCategory(s, fundId, "Food & Meals");
    const budgetId = await seedApprovedMonthlyBudget(s, {
      amountCents: 30_000,
      year: 2026,
      month: 7,
    });
    const reimbursementId = await seedApprovedReimbursement(s, {
      payeePersonId: sarah,
      amountCents: 30_386,
      budgetId,
      categoryId,
    });

    // Pay via ACH: seed the in-flight payout the webhook settles, mirroring
    // `increase.test.ts`'s own `seedProcessingPayout` shape.
    const payoutId = await run(s.t, (ctx) =>
      ctx.db.insert("payouts", {
        chapterId: s.chapterId,
        reimbursementId,
        provider: "increase",
        status: "processing",
        amountCents: 30_386,
        increaseTransferId: "ach_bounce_1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await run(s.t, (ctx) => ctx.db.patch(reimbursementId, { status: "paying", payoutId }));

    await s.t.mutation(internal.increasePayouts.onIncreaseWebhookEvent, {
      eventType: "ach_transfer.updated",
      transferId: "ach_bounce_1",
      status: "submitted",
    });
    await postPayoutOn(s, reimbursementId, tsOnDay(2026, 7, 22));
    const paidDash = await s.as.query(api.finances.dashboardChapter, { year: 2026, month: 7 });
    expect(paidDash.recurringBudgets.find((b) => b.id === budgetId)?.spentCents).toBe(30_386);

    // Days later the credit bounces — the money never left, so neither does
    // the expense.
    await s.t.mutation(internal.increasePayouts.onIncreaseWebhookEvent, {
      eventType: "ach_transfer.returned",
      transferId: "ach_bounce_1",
      status: "returned",
    });
    expect(await payoutTxn(s, reimbursementId)).toBeNull();
    const bouncedDash = await s.as.query(api.finances.dashboardChapter, { year: 2026, month: 7 });
    expect(bouncedDash.recurringBudgets.find((b) => b.id === budgetId)?.spentCents).toBe(0);
  });

  test("real transfers still don't count — only the reimbursement flow moved", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedManager(s);
    const budgetId = await seedApprovedMonthlyBudget(s, {
      amountCents: 30_000,
      year: 2026,
      month: 7,
    });

    // A transfer leg (skim / launch grant / settlement / repayment credit all
    // share this flow) attributed to the same budget stays out of the total.
    const transferId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "transfer",
      amountCents: 50_000,
      postedAt: tsOnDay(2026, 7, 22),
    });
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: transferId,
      budgetId,
    });

    const dash = await s.as.query(api.finances.dashboardChapter, { year: 2026, month: 7 });
    expect(dash.recurringBudgets.find((b) => b.id === budgetId)?.spentCents).toBe(0);
  });
});
