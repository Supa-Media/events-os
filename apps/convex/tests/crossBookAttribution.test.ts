/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { CENTRAL } from "@events-os/shared";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * CROSS-BOOK ATTRIBUTION — one book pays, another book's budget absorbs it.
 *
 * Founder request (2026-08-05): "a transaction should know its true book based
 * on what budget it's in … if I spent something using a public worship card, if
 * it's attached to a local budget it's part of the local book, and then we can
 * calculate in the backend what transfers need to be made."
 *
 * The model this pins down is TWO FACTS PER ROW, never collapsed into one:
 *
 *  - CUSTODY (`transactions.chapterId`, surfaced as `row.book`) — whose
 *    card/account actually paid. Bank reality. Governs WRITES
 *    (`requireReconcileTxn`) and is never rewritten by coding.
 *  - ATTRIBUTION (the linked budget's `chapterId`, surfaced as
 *    `row.chargedTo`) — whose programme it counts against. Governs BUDGET
 *    ACTUALS and the org roll-up.
 *
 * Where they differ, one book fronted money for another and the difference is
 * a receivable — `transfers.interScopeBalances` nets it into a settlement.
 *
 * Collapsing them into a single budget-derived "book" would break three things,
 * which is why these tests assert custody survives coding:
 *  1. an unreviewed txn has no budget, so the whole review queue would have no
 *     book at all;
 *  2. `canEdit` would flip mid-reconcile as a row is coded;
 *  3. a book's rows would stop summing to its own bank statement.
 */

async function seedSelfPerson(s: ChapterSetup): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Kansi",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
}

async function grantRole(
  s: ChapterSetup,
  personId: Id<"people">,
  role: "viewer" | "bookkeeper" | "manager",
  scope: "chapter" | "central" = "chapter",
): Promise<void> {
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope,
      createdAt: Date.now(),
    }),
  );
}

/** The founder's real configuration: central FM *and* chapter treasurer. */
async function asDualHatManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
  await grantRole(s, personId, "manager", "chapter");
  await grantRole(s, personId, "manager", "central");
  return personId;
}

/** An APPROVED recurring budget owned by the caller's chapter. */
async function makeChapterBudget(
  s: ChapterSetup,
  amountCents: number,
): Promise<Id<"budgets">> {
  const budgetId = await s.as.mutation(api.finances.createBudget, {
    amountCents,
    type: "recurring",
    cadence: "monthly",
    year: 2026,
  });
  await run(s.t, (ctx) => ctx.db.patch(budgetId, { approvalStatus: "approved" }));
  return budgetId;
}

/** A central-owned charge, optionally already coded to `budgetId`. */
async function centralCharge(
  s: ChapterSetup,
  amountCents: number,
  budgetId?: Id<"budgets">,
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: CENTRAL,
      source: "manual",
      flow: "outflow",
      amountCents,
      postedAt: Date.now(),
      status: budgetId ? "categorized" : "unreviewed",
      budgetId,
      createdAt: Date.now(),
    }),
  );
}

describe("the write gate — central card, chapter budget", () => {
  test("a central charge can be coded to a chapter budget, and custody is untouched", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asDualHatManager(s);
    const budgetId = await makeChapterBudget(s, 200_000);
    const txnId = await centralCharge(s, 50_000);

    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txnId,
      budgetId,
    });

    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    // The whole point: the money still left CENTRAL's account. Coding moves
    // attribution, never custody — otherwise the central book would stop
    // matching its own bank statement.
    expect(txn?.chapterId).toBe(CENTRAL);
    expect(txn?.budgetId).toBe(budgetId);
  });

  test("central's own budgets still work, unchanged", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asDualHatManager(s);
    const centralBudgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 100_000,
      type: "recurring",
      cadence: "monthly",
      year: 2026,
      central: true,
    });
    await run(s.t, (ctx) =>
      ctx.db.patch(centralBudgetId, { approvalStatus: "approved" }),
    );
    const txnId = await centralCharge(s, 10_000);

    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txnId,
      budgetId: centralBudgetId,
    });
    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.budgetId).toBe(centralBudgetId);
  });

  test("an UNAPPROVED chapter budget is still refused (the approval gate is not bypassed)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asDualHatManager(s);
    // Created but never approved — `assertBudgetApprovedForAttribution`.
    const draftBudgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 100_000,
      type: "recurring",
      cadence: "monthly",
      year: 2026,
    });
    const txnId = await centralCharge(s, 5_000);

    await expect(
      s.as.mutation(api.finances.categorizeTransaction, {
        transactionId: txnId,
        budgetId: draftBudgetId,
      }),
    ).rejects.toThrow(ConvexError);
  });

  test("a chapter charge can still be coded to a central budget — the original direction", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asDualHatManager(s);
    const centralBudgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 100_000,
      type: "recurring",
      cadence: "monthly",
      year: 2026,
      central: true,
    });
    await run(s.t, (ctx) =>
      ctx.db.patch(centralBudgetId, { approvalStatus: "approved" }),
    );
    const txnId = await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 7_000,
        postedAt: Date.now(),
        status: "unreviewed",
        createdAt: Date.now(),
      }),
    );

    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txnId,
      budgetId: centralBudgetId,
    });
    const txn = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(txn?.chapterId).toBe(s.chapterId);
    expect(txn?.budgetId).toBe(centralBudgetId);
  });
});

describe("budget actuals see the cross-book charge", () => {
  test("a chapter budget counts a charge another book paid for", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asDualHatManager(s);
    const budgetId = await makeChapterBudget(s, 200_000);

    // Two charges against the SAME New York budget — one paid by New York,
    // one paid by central. Both are commitments against New York's plan.
    await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 30_000,
        postedAt: Date.now(),
        status: "categorized",
        budgetId,
        createdAt: Date.now(),
      }),
    );
    await centralCharge(s, 50_000, budgetId);

    // THE REGRESSION: before this change every chapter-budget actual was
    // summed from the chapter's OWN transactions, so the central-paid 50,000
    // was invisible and the card read 30,000 / 200,000.
    const dash = await s.as.query(api.finances.dashboardChapter, {});
    const card = dash.recurringBudgets.find((b) => b.id === budgetId);
    expect(card?.spentCents).toBe(80_000);

    // The team-wide "budgets at a glance" screen must agree with the
    // treasurer's dashboard — a cardholder checking room-left sees one number.
    const glance = await s.as.query(api.finances.budgetsGlance, {});
    const glanceRow = glance.recurring.find((b) => b.id === budgetId);
    expect(glanceRow?.spentCents).toBe(80_000);
  });

  test("the chapter's own SPEND tile stays custody-scoped — the difference is the receivable", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asDualHatManager(s);
    const budgetId = await makeChapterBudget(s, 200_000);
    await centralCharge(s, 50_000, budgetId);

    const dash = await s.as.query(api.finances.dashboardChapter, {});
    const spentTile = dash.tiles.find((x) => x.label.startsWith("Spent"));

    // Deliberate: no money has left NEW YORK's account, so its "Spent" tile
    // reads zero even though its budget has absorbed 50,000. Those are two
    // different questions — cash out vs commitments against the plan — and the
    // gap between them is exactly what central is owed. Merging them would
    // hide the receivable and break bank reconciliation.
    expect(spentTile?.subValueCents).toBe(0);

    const card = dash.recurringBudgets.find((b) => b.id === budgetId);
    expect(card?.spentCents).toBe(50_000);
  });

  test("a chapter's own charge is never double-counted by the union", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asDualHatManager(s);
    const budgetId = await makeChapterBudget(s, 200_000);
    await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 30_000,
        postedAt: Date.now(),
        status: "categorized",
        budgetId,
        createdAt: Date.now(),
      }),
    );

    // The cross-book scan reads `by_budget`, which also returns the chapter's
    // OWN rows — they're skipped explicitly, or every budget on the page would
    // read double.
    const dash = await s.as.query(api.finances.dashboardChapter, {});
    const card = dash.recurringBudgets.find((b) => b.id === budgetId);
    expect(card?.spentCents).toBe(30_000);
  });
});

describe("the settlement follows automatically", () => {
  test("a cross-book charge becomes a balance central can settle", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asDualHatManager(s);
    const budgetId = await makeChapterBudget(s, 200_000);
    const txnId = await centralCharge(s, 50_000);
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txnId,
      budgetId,
    });

    // Negative = this chapter owes central (direction (b) — see
    // `interScopeBalances`' doc comment). No math changed to make this work:
    // the term was always computed, it just could never be non-zero before.
    const balances = await s.as.query(api.transfers.interScopeBalances, {});
    const row = balances.find((b) => b.chapterId === s.chapterId);
    expect(row?.netCents).toBe(-50_000);
  });

  test("coding it back to a central budget clears the balance again", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asDualHatManager(s);
    const chapterBudgetId = await makeChapterBudget(s, 200_000);
    const centralBudgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 200_000,
      type: "recurring",
      cadence: "monthly",
      year: 2026,
      central: true,
    });
    await run(s.t, (ctx) =>
      ctx.db.patch(centralBudgetId, { approvalStatus: "approved" }),
    );

    const txnId = await centralCharge(s, 50_000);
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txnId,
      budgetId: chapterBudgetId,
    });
    expect(
      (await s.as.query(api.transfers.interScopeBalances, {})).find(
        (b) => b.chapterId === s.chapterId,
      )?.netCents,
    ).toBe(-50_000);

    // A miscode is correctable: re-point it at central's own budget and the
    // debt disappears, because the balance is a live ledger read, not an
    // accrual someone has to reverse.
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txnId,
      budgetId: centralBudgetId,
    });
    expect(
      (await s.as.query(api.transfers.interScopeBalances, {})).find(
        (b) => b.chapterId === s.chapterId,
      )?.netCents,
    ).toBe(0);
  });
});

describe("Reconcile shows both facts", () => {
  test("a cross-book row reports paid-from and charged-to separately", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asDualHatManager(s);
    const budgetId = await makeChapterBudget(s, 200_000);
    const txnId = await centralCharge(s, 50_000, budgetId);

    const grid = await s.as.query(api.finances.listReconcile, {
      filter: "all",
      scope: "all",
    });
    const row = grid.rows.find((r) => r.id === txnId);

    expect(row?.book.id).toBe(CENTRAL); // paid from
    expect(row?.chargedTo?.id).toBe(s.chapterId); // counts against
    expect(row?.chargedTo?.name).toBeTruthy();
  });

  test("an unattributed row has no chargedTo at all — the review queue is exactly this", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asDualHatManager(s);
    const txnId = await centralCharge(s, 50_000);

    const grid = await s.as.query(api.finances.listReconcile, {
      filter: "to_review",
      scope: "all",
    });
    const row = grid.rows.find((r) => r.id === txnId);
    // The reason `book` can't be budget-derived: this row is real, needs
    // reviewing, and has no budget to derive anything from.
    expect(row?.book.id).toBe(CENTRAL);
    expect(row?.chargedTo).toBeNull();
  });

  test("a same-book row reports chargedTo equal to its book (no false flag)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asDualHatManager(s);
    const budgetId = await makeChapterBudget(s, 200_000);
    const txnId = await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 20_000,
        postedAt: Date.now(),
        status: "categorized",
        budgetId,
        createdAt: Date.now(),
      }),
    );

    const grid = await s.as.query(api.finances.listReconcile, { filter: "all" });
    const row = grid.rows.find((r) => r.id === txnId);
    expect(row?.chargedTo?.id).toBe(row?.book.id);
  });
});
