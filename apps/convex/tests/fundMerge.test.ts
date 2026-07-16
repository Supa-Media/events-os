/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { seedChapterFinance } from "../lib/seed/finance";

/**
 * WP-1.4 "defund the UI" tests:
 *  - the chapter seed creates exactly ONE fund (General Fund, unrestricted),
 *  - the `runMergeFundsIntoGeneral` migration merges every extra fund a
 *    chapter already has into its General Fund, repointing every reference
 *    (`budgetCategories.fundId` — required, `budgets.fundId`,
 *    `transactions.fundId` + a stale `aiSuggestion.fundId` on the same row,
 *    `reimbursementLineItems.fundId`, `legacyAccounts.defaultFundId`) before
 *    deleting the extra fund docs,
 *  - the whole migration is idempotent (a settled re-run is a no-op) and safe
 *    on a fund-less chapter or a chapter already down to one fund.
 */

async function fundsFor(s: ChapterSetup, chapterId: Id<"chapters">) {
  return await run(s.t, (ctx) =>
    ctx.db
      .query("funds")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .collect(),
  );
}

async function insertFund(
  s: ChapterSetup,
  opts: { name: string; restriction: "unrestricted" | "designated"; sortOrder: number },
): Promise<Id<"funds">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("funds", {
      chapterId: s.chapterId,
      name: opts.name,
      restriction: opts.restriction,
      sortOrder: opts.sortOrder,
      isActive: true,
      createdAt: Date.now(),
    }),
  );
}

describe("seedChapterFinance seeds exactly one fund", () => {
  test("creates a single unrestricted General Fund (no Designated fund)", async () => {
    const t = newT();
    const s = await setupChapter(t);

    const result = await run(s.t, (ctx) =>
      seedChapterFinance(ctx, s.chapterId, s.userId, Date.now()),
    );

    const funds = await fundsFor(s, s.chapterId);
    expect(funds).toHaveLength(1);
    expect(funds[0].name).toBe("General Fund");
    expect(funds[0].restriction).toBe("unrestricted");
    expect(funds[0]._id).toBe(result.generalFundId);
    // The old two-fund return shape is gone.
    expect("designatedFundId" in result).toBe(false);
  });
});

describe("runMergeFundsIntoGeneral (WP-1.4 fund merge migration)", () => {
  test("merges a 2-fund chapter: repoints every reference, deletes the extra fund", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const generalId = await insertFund(s, {
      name: "General Fund",
      restriction: "unrestricted",
      sortOrder: 0,
    });
    const designatedId = await insertFund(s, {
      name: "Designated",
      restriction: "designated",
      sortOrder: 1,
    });

    // A category REQUIRED to live under the extra fund (required field).
    const categoryId = await run(s.t, (ctx) =>
      ctx.db.insert("budgetCategories", {
        chapterId: s.chapterId,
        fundId: designatedId,
        name: "Missions",
        kind: "category",
        sortOrder: 0,
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    // A budget narrowed to the extra fund.
    const budgetId = await run(s.t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 10000,
        type: "recurring",
        cadence: "monthly",
        year: 2026,
        fundId: designatedId,
        createdAt: Date.now(),
      }),
    );
    // A transaction coded to the extra fund, WITH a stale AI suggestion
    // pointing at the same extra fund.
    const txnId = await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 500,
        postedAt: Date.now(),
        fundId: designatedId,
        aiSuggestion: { fundId: designatedId, categoryId },
        status: "categorized",
        createdAt: Date.now(),
      }),
    );
    // A reimbursement line item on the extra fund.
    const reimbursementId = await run(s.t, (ctx) =>
      ctx.db.insert("reimbursementRequests", {
        chapterId: s.chapterId,
        token: "tok_1",
        status: "submitted",
        payeeName: "Dana Rivers",
        payeeEmail: "dana@example.com",
        totalCents: 200,
        submittedAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const lineId = await run(s.t, (ctx) =>
      ctx.db.insert("reimbursementLineItems", {
        chapterId: s.chapterId,
        reimbursementId,
        description: "Supplies",
        amountCents: 200,
        fundId: designatedId,
        order: 0,
        createdAt: Date.now(),
      }),
    );
    // A legacy account defaulting new syncs to the extra fund.
    const accountId = await run(s.t, (ctx) =>
      ctx.db.insert("legacyAccounts", {
        chapterId: s.chapterId,
        stripeFcAccountId: "fca_test_1",
        defaultFundId: designatedId,
        status: "active",
        createdAt: Date.now(),
      }),
    );

    const result = await t.mutation(
      internal.finances.runMergeFundsIntoGeneral,
      {},
    );
    expect(result.chaptersMerged).toBe(1);
    expect(result.fundsDeleted).toBe(1);
    expect(result.categoriesRepointed).toBe(1);
    expect(result.budgetsRepointed).toBe(1);
    expect(result.transactionsRepointed).toBe(1);
    expect(result.reimbursementLineItemsRepointed).toBe(1);
    expect(result.legacyAccountsRepointed).toBe(1);

    // Every reference now points at the keeper (General Fund).
    expect(
      (await run(s.t, (ctx) => ctx.db.get(categoryId)))?.fundId,
    ).toBe(generalId);
    expect((await run(s.t, (ctx) => ctx.db.get(budgetId)))?.fundId).toBe(
      generalId,
    );
    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.fundId).toBe(generalId);
    expect(txn?.aiSuggestion?.fundId).toBe(generalId);
    expect((await run(s.t, (ctx) => ctx.db.get(lineId)))?.fundId).toBe(
      generalId,
    );
    expect(
      (await run(s.t, (ctx) => ctx.db.get(accountId)))?.defaultFundId,
    ).toBe(generalId);

    // The extra fund is gone; the chapter has exactly one fund left.
    const funds = await fundsFor(s, s.chapterId);
    expect(funds).toHaveLength(1);
    expect(funds[0]._id).toBe(generalId);
    expect(await run(s.t, (ctx) => ctx.db.get(designatedId))).toBeNull();
  });

  test("idempotent: a re-run on an already-merged chapter is a no-op", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await insertFund(s, { name: "General Fund", restriction: "unrestricted", sortOrder: 0 });
    await insertFund(s, { name: "Designated", restriction: "designated", sortOrder: 1 });

    const first = await t.mutation(internal.finances.runMergeFundsIntoGeneral, {});
    expect(first.chaptersMerged).toBe(1);

    const second = await t.mutation(internal.finances.runMergeFundsIntoGeneral, {});
    expect(second.chaptersMerged).toBe(0);
    expect(second.fundsDeleted).toBe(0);
    expect(second.categoriesRepointed).toBe(0);
    expect(second.budgetsRepointed).toBe(0);
    expect(second.transactionsRepointed).toBe(0);
    expect(second.reimbursementLineItemsRepointed).toBe(0);
    expect(second.legacyAccountsRepointed).toBe(0);
    expect(await fundsFor(s, s.chapterId)).toHaveLength(1);
  });

  test("a chapter already at one fund is untouched", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const onlyFund = await insertFund(s, {
      name: "General Fund",
      restriction: "unrestricted",
      sortOrder: 0,
    });

    const result = await t.mutation(internal.finances.runMergeFundsIntoGeneral, {
      chapterId: s.chapterId,
    });
    expect(result.chaptersMerged).toBe(0);
    const funds = await fundsFor(s, s.chapterId);
    expect(funds).toHaveLength(1);
    expect(funds[0]._id).toBe(onlyFund);
  });

  test("a fund-less chapter is skipped without error", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const result = await t.mutation(internal.finances.runMergeFundsIntoGeneral, {
      chapterId: s.chapterId,
    });
    expect(result.chaptersMerged).toBe(0);
    expect(await fundsFor(s, s.chapterId)).toHaveLength(0);
  });

  test("passing chapterId scopes the merge to just that chapter", async () => {
    const t = newT();
    const s1 = await setupChapter(t, { email: "leader1@publicworship.life" });
    await insertFund(s1, { name: "General Fund", restriction: "unrestricted", sortOrder: 0 });
    const s1Extra = await insertFund(s1, { name: "Designated", restriction: "designated", sortOrder: 1 });

    const s2 = await setupChapter(t, { email: "leader2@publicworship.life", chapterName: "Other" });
    await insertFund(s2, { name: "General Fund", restriction: "unrestricted", sortOrder: 0 });
    await insertFund(s2, { name: "Designated", restriction: "designated", sortOrder: 1 });

    const result = await t.mutation(internal.finances.runMergeFundsIntoGeneral, {
      chapterId: s1.chapterId,
    });
    expect(result.chaptersScanned).toBe(1);
    expect(result.chaptersMerged).toBe(1);
    expect(await fundsFor(s1, s1.chapterId)).toHaveLength(1);
    expect(await run(s1.t, (ctx) => ctx.db.get(s1Extra))).toBeNull();
    // The OTHER chapter's extra fund is untouched.
    expect(await fundsFor(s2, s2.chapterId)).toHaveLength(2);
  });
});
