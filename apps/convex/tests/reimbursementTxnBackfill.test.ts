/// <reference types="vite/client" />
/**
 * Reimbursement payout rows should carry the reimbursement's own data.
 *
 * A paid reimbursement posts a single `flow:"transfer"` transaction (see
 * `increase.ts#postReimbursementTransfer`). Historically that row was written
 * BARE — no category, no "For", no purpose, no receipt, no merchant — so every
 * paid reimbursement showed up in Reconcile as an "Unlabeled charge /
 * Uncategorized / For: None / missing receipt", inflating the missing-receipt +
 * uncategorized backlogs even though all of it lives on the reimbursement.
 *
 * These tests cover the one-shot backfill (`reimbursementBackfill.ts`), which
 * fills those blanks from the reimbursement + its line items using the same
 * derivation the live insert path now uses: purpose → note, the request's
 * budget → "For", a single line's text → merchant, unanimous per-line category
 * → the row, first line receipt → representative receipt. The backfill is
 * fill-BLANKS-ONLY (never clobbers a human edit), dry-run by default, and
 * idempotent.
 */
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, storeBlob, type ChapterSetup } from "./setup.helpers";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

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

async function seedCategory(s: ChapterSetup, fundId: Id<"funds">, name: string): Promise<Id<"budgetCategories">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("budgetCategories", {
      chapterId: s.chapterId,
      fundId,
      name,
      kind: "lineItem",
      sortOrder: 0,
      createdAt: Date.now(),
    }),
  );
}

async function seedBudget(s: ChapterSetup): Promise<Id<"budgets">> {
  return run(s.t, (ctx) =>
    ctx.db.insert("budgets", {
      chapterId: s.chapterId,
      amountCents: 500000,
      label: "Operating Expenses",
      type: "recurring",
      cadence: "monthly",
      year: 2026,
      createdBy: s.userId,
      createdAt: Date.now(),
    }),
  );
}

async function seedPaidReimbursement(
  s: ChapterSetup,
  opts: {
    purpose?: string;
    budgetId?: Id<"budgets">;
    lines: Array<{
      description: string;
      amountCents: number;
      categoryId?: Id<"budgetCategories">;
      fundId?: Id<"funds">;
      withReceipt?: boolean;
    }>;
    txnOverrides?: Record<string, unknown>;
  },
): Promise<{ reimbursementId: Id<"reimbursementRequests">; txnId: Id<"transactions"> }> {
  // Storage writes need an action ctx (StorageWriter has no `store` in a
  // mutation), so mint the receipt ids up front via the helper, then thread
  // them into the row inserts.
  const receiptIds: (Id<"_storage"> | undefined)[] = [];
  for (const line of opts.lines) {
    receiptIds.push(line.withReceipt ? await storeBlob(s.t) : undefined);
  }
  return run(s.t, async (ctx) => {
    const total = opts.lines.reduce((sum, l) => sum + l.amountCents, 0);
    const reimbursementId = await ctx.db.insert("reimbursementRequests", {
      chapterId: s.chapterId,
      token: `tok-${opts.lines.length}-${total}`,
      status: "paid",
      payeeName: "Sarah",
      purpose: opts.purpose,
      budgetId: opts.budgetId,
      totalCents: total,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    let order = 0;
    for (const line of opts.lines) {
      await ctx.db.insert("reimbursementLineItems", {
        chapterId: s.chapterId,
        reimbursementId,
        description: line.description,
        amountCents: line.amountCents,
        categoryId: line.categoryId,
        fundId: line.fundId,
        receiptStorageId: receiptIds[order],
        transactionDate: Date.now(),
        order,
        createdAt: Date.now(),
      });
      order++;
    }

    const txnId = await ctx.db.insert("transactions", {
      chapterId: s.chapterId,
      source: "reimbursement",
      flow: "transfer",
      amountCents: total,
      postedAt: Date.now(),
      reimbursementId,
      status: "reconciled",
      createdAt: Date.now(),
      ...(opts.txnOverrides ?? {}),
    });

    return { reimbursementId, txnId };
  });
}

describe("reimbursement payout backfill", () => {
  test("ports purpose, For, merchant, category, and receipt onto a single-line payout", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const fundId = await seedFund(s);
    const categoryId = await seedCategory(s, fundId, "Food & Meals");
    const budgetId = await seedBudget(s);

    const { txnId } = await seedPaidReimbursement(s, {
      purpose: "Monthly team dinner",
      budgetId,
      lines: [{ description: "Dig Inn", amountCents: 30386, categoryId, withReceipt: true }],
    });

    // Dry run reports the work but writes nothing.
    const dry = await t.mutation(internal.reimbursementBackfill.backfillReimbursementTxnData, {});
    expect(dry.patched).toBe(1);
    const before = await run(t, (ctx) => ctx.db.get(txnId));
    expect(before?.note).toBeUndefined();

    const done = await t.mutation(internal.reimbursementBackfill.backfillReimbursementTxnData, {
      execute: true,
    });
    expect(done.patched).toBe(1);
    expect(done.isDone).toBe(true);

    const after = await run(t, (ctx) => ctx.db.get(txnId));
    expect(after?.note).toBe("Monthly team dinner");
    expect(after?.merchantName).toBe("Dig Inn");
    expect(after?.budgetId).toBe(budgetId);
    expect(after?.categoryId).toBe(categoryId);
    expect(after?.receiptStorageId).not.toBeUndefined();
    expect(after?.status).toBe("reconciled"); // never re-opens a closed row
  });

  test("multi-line: payee merchant label, only a unanimous category ports, still gets a receipt", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const fundId = await seedFund(s);
    const catA = await seedCategory(s, fundId, "Supplies");
    const catB = await seedCategory(s, fundId, "Travel");

    const { txnId } = await seedPaidReimbursement(s, {
      purpose: "Retreat supplies",
      lines: [
        { description: "Target", amountCents: 5000, categoryId: catA, withReceipt: true },
        { description: "Costco", amountCents: 8000, categoryId: catB, withReceipt: true },
      ],
    });

    await t.mutation(internal.reimbursementBackfill.backfillReimbursementTxnData, { execute: true });
    const after = await run(t, (ctx) => ctx.db.get(txnId));
    expect(after?.merchantName).toBe("Reimbursement to Sarah");
    expect(after?.categoryId).toBeUndefined(); // categories disagree → bookkeeper decides
    expect(after?.receiptStorageId).not.toBeUndefined();
    expect(after?.note).toBe("Retreat supplies");
  });

  test("fill-blanks-only: never clobbers a field a human already set", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const fundId = await seedFund(s);
    const humanCat = await seedCategory(s, fundId, "Human choice");
    const lineCat = await seedCategory(s, fundId, "Line choice");

    const { txnId } = await seedPaidReimbursement(s, {
      purpose: "Dinner",
      lines: [{ description: "Dig Inn", amountCents: 1000, categoryId: lineCat, withReceipt: true }],
      txnOverrides: { categoryId: humanCat, note: "already noted" },
    });

    await t.mutation(internal.reimbursementBackfill.backfillReimbursementTxnData, { execute: true });
    const after = await run(t, (ctx) => ctx.db.get(txnId));
    expect(after?.categoryId).toBe(humanCat); // untouched
    expect(after?.note).toBe("already noted"); // untouched
    expect(after?.merchantName).toBe("Dig Inn"); // blank → filled
  });

  test("idempotent: a second execute run patches nothing new", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await seedPaidReimbursement(s, {
      purpose: "Dinner",
      lines: [{ description: "Dig Inn", amountCents: 1000, withReceipt: true }],
    });
    await t.mutation(internal.reimbursementBackfill.backfillReimbursementTxnData, { execute: true });
    const second = await t.mutation(internal.reimbursementBackfill.backfillReimbursementTxnData, {
      execute: true,
    });
    expect(second.patched).toBe(0);
  });
});
