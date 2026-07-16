/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Phase-1A finance API tests (`finances.ts` real implementation).
 *
 * Covers: budget scope/cadence create + budgetVsActual spent-vs-allocated math,
 * Estimated ≠ Actual (a budget + a matching txn don't double count, transfers
 * excluded from spend), categorize + flagPersonal, integer-cents enforcement,
 * bounded pagination, viewer-rejected-from-manager-write, and cross-chapter id
 * rejection.
 */

async function seedSelfPerson(s: ChapterSetup): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
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

/** A manager-graded caller (person + manager grant). */
async function asManager(s: ChapterSetup): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
  await grantRole(s, personId, "manager");
  return personId;
}

/** A timestamp inside a given Eastern year/month (mid-month noon UTC is safe). */
function tsInMonth(year: number, month: number): number {
  return Date.UTC(year, month - 1, 15, 17, 0, 0);
}

describe("funds / categories / teams CRUD", () => {
  test("manager creates + lists a fund; viewer is rejected from creating", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    const fundId = await s.as.mutation(api.finances.createFund, {
      name: "General",
      restriction: "unrestricted",
      code: "1000",
    });
    const funds = await s.as.query(api.finances.listFunds, {});
    expect(funds.map((f) => f.id)).toContain(fundId);
    expect(funds.find((f) => f.id === fundId)?.code).toBe("1000");

    // A viewer cannot create a fund (manager-only write).
    const viewer = await setupChapter(t, { email: "viewer@publicworship.life" });
    // give the viewer a person in the SAME chapter + a viewer grant
    const vPerson = await run(t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Viewer",
        userId: viewer.userId,
        createdAt: Date.now(),
      }),
    );
    await run(t, (ctx) =>
      ctx.db.insert("userChapters", {
        userId: viewer.userId,
        chapterId: s.chapterId,
        role: "member",
        isActive: true,
        joinedAt: Date.now(),
      }),
    );
    await run(t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId: vPerson,
        role: "viewer",
        scope: "chapter",
        createdAt: Date.now(),
      }),
    );
    await expect(
      viewer.as.mutation(api.finances.createFund, {
        name: "Nope",
        restriction: "unrestricted",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("categories stay acyclic (a parent cycle is rejected)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const fundId = await s.as.mutation(api.finances.createFund, {
      name: "Ops",
      restriction: "unrestricted",
    });
    const parent = await s.as.mutation(api.finances.createCategory, {
      fundId,
      name: "Parent",
      kind: "category",
    });
    const child = await s.as.mutation(api.finances.createCategory, {
      fundId,
      name: "Child",
      kind: "category",
      parentCategoryId: parent,
    });
    // Making the parent's parent the child would form a cycle → reject.
    await expect(
      s.as.mutation(api.finances.updateCategory, {
        categoryId: parent,
        patch: { parentCategoryId: child },
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("central + chapter teams both list for the caller", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const teamId = await s.as.mutation(api.finances.createTeam, {
      name: "Development",
    });
    // Insert a central team (no chapterId) directly.
    await run(t, (ctx) =>
      ctx.db.insert("financeTeams", {
        name: "Central Ops",
        sortOrder: 0,
        createdAt: Date.now(),
      }),
    );
    const teams = await s.as.query(api.finances.listTeams, {});
    const names = teams.map((x) => x.name);
    expect(names).toContain("Development");
    expect(names).toContain("Central Ops");
    expect(teams.map((x) => x.id)).toContain(teamId);
  });
});

describe("budgets + budgetVsActual (Estimated ≠ Actual)", () => {
  test("actual sums matching transactions; transfers + personal are excluded", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const year = 2026;
    const month = 3;

    const fundId = await s.as.mutation(api.finances.createFund, {
      name: "General",
      restriction: "unrestricted",
    });
    const categoryId = await s.as.mutation(api.finances.createCategory, {
      fundId,
      name: "Food",
      kind: "lineItem",
    });

    // A recurring monthly budget narrowed to the Food category: $500.00 allocated.
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 50000,
      type: "recurring",
      cadence: "monthly",
      year,
      month,
      fundId,
      categoryId,
      label: "Food · March",
    });

    // A real $120.00 outflow coded to Food in March, EXPLICITLY linked to the
    // budget → counts as actual (fund/category alone is no longer enough).
    const outflowTxnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 12000,
      postedAt: tsInMonth(year, month),
      fundId,
      categoryId,
    });
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: outflowTxnId,
      budgetId,
    });
    // A $99.99 TRANSFER, ALSO explicitly linked to the same budget → still
    // excluded from spend (the `isSpend`/transfer-excluded invariant holds
    // even for an explicitly-linked row).
    const transferTxnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "transfer",
      amountCents: 9999,
      postedAt: tsInMonth(year, month),
      fundId,
      categoryId,
    });
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: transferTxnId,
      budgetId,
    });

    const rows = await s.as.query(api.finances.budgetVsActual, { year, month });
    const row = rows.find((r) => r.budgetId === budgetId);
    expect(row).toBeDefined();
    // Estimated (allocated) and Actual are reported separately, never summed.
    expect(row?.allocatedCents).toBe(50000);
    expect(row?.actualCents).toBe(12000); // transfer excluded even though linked
    expect(row?.label).toBe("Food · March");

    // Flag the outflow personal → it drops out of actual spend.
    const txns = await s.as.query(api.finances.listTransactions, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    const outflow = txns.page.find((x) => x.flow === "outflow");
    expect(outflow).toBeDefined();
    await s.as.mutation(api.finances.flagPersonal, {
      transactionId: outflow!.id,
      isPersonal: true,
    });
    const rows2 = await s.as.query(api.finances.budgetVsActual, { year, month });
    expect(rows2.find((r) => r.budgetId === budgetId)?.actualCents).toBe(0);
  });

  test("listBudgets returns the created budget; deleteBudget removes it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 200000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
    });
    let budgets = await s.as.query(api.finances.listBudgets, {});
    expect(budgets.map((b) => b.id)).toContain(budgetId);
    await s.as.mutation(api.finances.deleteBudget, { budgetId });
    budgets = await s.as.query(api.finances.listBudgets, {});
    expect(budgets.map((b) => b.id)).not.toContain(budgetId);
  });

  test("deleteBudget clears budgetId on linked transactions — the spend drops back into Unattributed instead of vanishing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const year = 2026;
    const month = 5;

    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 100000,
      type: "recurring",
      cadence: "monthly",
      year,
      month,
      label: "Soon-to-be-deleted",
    });
    const txnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 4200,
      postedAt: tsInMonth(year, month),
    });
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txnId,
      budgetId,
    });

    // Linked: counts toward the budget, absent from Unattributed + needs_budget.
    let dash = await s.as.query(api.finances.dashboardChapter, { year, month });
    expect(dash.unattributedCents).toBe(0);
    let reconcile = await s.as.query(api.finances.listReconcile, { filter: "needs_budget" });
    expect(reconcile.rows.map((r) => r.id)).not.toContain(txnId);

    await s.as.mutation(api.finances.deleteBudget, { budgetId });

    // The txn's `budgetId` is cleared, not left dangling at a deleted doc.
    const txn = await run(t, (ctx) => ctx.db.get(txnId));
    expect(txn?.budgetId).toBeUndefined();

    // The spend re-surfaces loudly in Unattributed + needs_budget — no budget
    // (there is none left) counts it, so it must not just vanish.
    dash = await s.as.query(api.finances.dashboardChapter, { year, month });
    expect(dash.unattributedCents).toBe(4200);
    expect(dash.unattributedCount).toBe(1);
    reconcile = await s.as.query(api.finances.listReconcile, { filter: "needs_budget" });
    expect(reconcile.rows.map((r) => r.id)).toContain(txnId);
  });
});

describe("transactions: categorize, integer-cents, pagination", () => {
  test("categorizeTransaction assigns fund + category and marks it categorized", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const fundId = await s.as.mutation(api.finances.createFund, {
      name: "General",
      restriction: "unrestricted",
    });
    const categoryId = await s.as.mutation(api.finances.createCategory, {
      fundId,
      name: "Software",
      kind: "lineItem",
    });
    const txnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 4200,
      postedAt: Date.now(),
    });
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txnId,
      fundId,
      categoryId,
    });
    const doc = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(doc?.fundId).toBe(fundId);
    expect(doc?.categoryId).toBe(categoryId);
    expect(doc?.status).toBe("categorized");
  });

  test("bulkCategorize updates every listed transaction", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const fundId = await s.as.mutation(api.finances.createFund, {
      name: "General",
      restriction: "unrestricted",
    });
    const a = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 100,
      postedAt: Date.now(),
    });
    const b = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 200,
      postedAt: Date.now(),
    });
    const res = await s.as.mutation(api.finances.bulkCategorize, {
      transactionIds: [a, b],
      fundId,
    });
    expect(res.updated).toBe(2);
  });

  test("integer-cents enforcement rejects a float or a negative amount", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    await expect(
      s.as.mutation(api.finances.createManualTransaction, {
        flow: "outflow",
        amountCents: 12.5,
        postedAt: Date.now(),
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      s.as.mutation(api.finances.createManualTransaction, {
        flow: "outflow",
        amountCents: -500,
        postedAt: Date.now(),
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("listTransactions returns a bounded page ordered by postedAt desc", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    for (let i = 0; i < 5; i++) {
      await s.as.mutation(api.finances.createManualTransaction, {
        flow: "outflow",
        amountCents: 100 + i,
        postedAt: Date.UTC(2026, 0, 1 + i),
      });
    }
    const page1 = await s.as.query(api.finances.listTransactions, {
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(page1.page.length).toBe(2);
    expect(page1.isDone).toBe(false);
    // Newest first.
    expect(page1.page[0].postedAt).toBeGreaterThanOrEqual(
      page1.page[1].postedAt,
    );
  });
});

describe("listReconcile (server-side filters + counts + projections)", () => {
  /** Insert a transaction directly for full control over status/budget/receipt. */
  async function insertTxn(
    s: ChapterSetup,
    fields: Partial<{
      flow: "inflow" | "outflow" | "transfer";
      amountCents: number;
      status: "unreviewed" | "categorized" | "reconciled" | "excluded";
      budgetId: Id<"budgets">;
      receiptStorageId: Id<"_storage">;
      personId: Id<"people">;
      cardId: Id<"cards">;
      cardLast4: string;
    }>,
  ): Promise<Id<"transactions">> {
    return await run(s.t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: fields.flow ?? "outflow",
        amountCents: fields.amountCents ?? 100,
        postedAt: Date.now(),
        status: fields.status ?? "unreviewed",
        budgetId: fields.budgetId,
        receiptStorageId: fields.receiptStorageId,
        personId: fields.personId,
        cardId: fields.cardId,
        cardLast4: fields.cardLast4,
        createdAt: Date.now(),
      }),
    );
  }

  test("each filter returns the right rows and every pill count is truthful", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 10000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
    });
    const receiptId = (await run(s.t, (ctx) =>
      // `store` is a convex-test run-ctx extension not in the StorageWriter type.
      (ctx.storage as unknown as { store: (b: Blob) => Promise<Id<"_storage">> }).store(
        new Blob(["receipt"], { type: "text/plain" }),
      ),
    )) as Id<"_storage">;

    // t1: spend, unreviewed, no budget, no receipt.
    const t1 = await insertTxn(s, { status: "unreviewed" });
    // t2: spend, reconciled, budgeted, has receipt.
    const t2 = await insertTxn(s, {
      status: "reconciled",
      budgetId,
      receiptStorageId: receiptId,
      amountCents: 200,
    });
    // t3: excluded → never in the inbox.
    await insertTxn(s, { status: "excluded", amountCents: 300 });
    // t4: inflow, unreviewed → counted as all + uncategorized only (not spend).
    const t4 = await insertTxn(s, { flow: "inflow", amountCents: 400 });

    const all = await s.as.query(api.finances.listReconcile, { filter: "all" });
    expect(all.counts).toEqual({
      all: 3, // t1, t2, t4 (t3 excluded)
      needs_budget: 1, // t1
      missing_receipt: 1, // t1
      uncategorized: 2, // t1, t4
      ready: 1, // t2
    });
    const allIds = all.rows.map((r) => r.id);
    expect(allIds).toEqual(expect.arrayContaining([t1, t2, t4]));
    expect(allIds).not.toContain(
      await run(s.t, async (ctx) => {
        const ex = (await ctx.db.query("transactions").collect()).find(
          (x) => x.status === "excluded",
        );
        return ex!._id;
      }),
    );

    const needsBudget = await s.as.query(api.finances.listReconcile, {
      filter: "needs_budget",
    });
    expect(needsBudget.rows.map((r) => r.id)).toEqual([t1]);

    const missingReceipt = await s.as.query(api.finances.listReconcile, {
      filter: "missing_receipt",
    });
    expect(missingReceipt.rows.map((r) => r.id)).toEqual([t1]);

    const uncategorized = await s.as.query(api.finances.listReconcile, {
      filter: "uncategorized",
    });
    expect(uncategorized.rows.map((r) => r.id).sort()).toEqual([t1, t4].sort());

    const ready = await s.as.query(api.finances.listReconcile, {
      filter: "ready",
    });
    expect(ready.rows.map((r) => r.id)).toEqual([t2]);
  });

  test("projects hasReceipt, cardLast4 and resolves the cardholder (personId OR card)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    const personId = await run(s.t, (ctx) =>
      ctx.db.insert("people", {
        chapterId: s.chapterId,
        name: "Dana Cardholder",
        createdAt: Date.now(),
      }),
    );
    const cardId = await run(s.t, (ctx) =>
      ctx.db.insert("cards", {
        chapterId: s.chapterId,
        cardholderPersonId: personId,
        type: "virtual",
        status: "active",
        createdAt: Date.now(),
      }),
    );
    const receiptId = (await run(s.t, (ctx) =>
      (ctx.storage as unknown as { store: (b: Blob) => Promise<Id<"_storage">> }).store(
        new Blob(["r"], { type: "text/plain" }),
      ),
    )) as Id<"_storage">;

    // Direct personId link + a receipt + a last-4.
    const direct = await insertTxn(s, {
      personId,
      receiptStorageId: receiptId,
      cardLast4: "4242",
    });
    // Cardholder resolved THROUGH the card (no personId on the txn).
    const viaCard = await insertTxn(s, { cardId, amountCents: 500 });
    // Neither → cardholder null, hasReceipt false.
    const orphan = await insertTxn(s, { amountCents: 600 });

    const { rows } = await s.as.query(api.finances.listReconcile, {
      filter: "all",
    });
    const byId = new Map(rows.map((r) => [r.id, r]));

    const d = byId.get(direct)!;
    expect(d.hasReceipt).toBe(true);
    expect(d.cardLast4).toBe("4242");
    expect(d.cardholder?.personId).toBe(personId);
    expect(d.cardholder?.name).toBe("Dana Cardholder");

    const c = byId.get(viaCard)!;
    expect(c.cardholder?.personId).toBe(personId);
    expect(c.hasReceipt).toBe(false);

    const o = byId.get(orphan)!;
    expect(o.cardholder).toBeNull();
    expect(o.cardLast4).toBeNull();
  });
});

describe("categorizeTransaction defaults the fund", () => {
  test("omitting fundId codes the txn to the General Fund; restricted funds are skipped", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);

    // A designated (restricted) fund with a LOWER sortOrder must NOT win the default.
    await s.as.mutation(api.finances.createFund, {
      name: "Missions",
      restriction: "designated",
      sortOrder: 0,
    });
    const generalFundId = await s.as.mutation(api.finances.createFund, {
      name: "General Fund",
      restriction: "unrestricted",
      sortOrder: 1,
    });
    const categoryId = await s.as.mutation(api.finances.createCategory, {
      fundId: generalFundId,
      name: "Software",
      kind: "lineItem",
    });
    const txnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 4200,
      postedAt: Date.now(),
    });

    // Code with ONLY a category (fund omitted, mirroring the grid's Category cell).
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txnId,
      categoryId,
    });
    const doc = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(doc?.fundId).toBe(generalFundId); // defaulted, not the restricted fund
    expect(doc?.categoryId).toBe(categoryId);
    expect(doc?.status).toBe("categorized");
  });
});

// ── WP-1.4 "defund the UI" — server-side fund defaults ───────────────────────
// No UI ever sends a fundId anymore; every creation path must silently land on
// the chapter's General Fund instead of requiring one.

describe("createManualTransaction defaults the fund", () => {
  test("omitting fundId lands the txn on the General Fund without faking categorization", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const generalFundId = await s.as.mutation(api.finances.createFund, {
      name: "General Fund",
      restriction: "unrestricted",
    });

    const txnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 1000,
      postedAt: Date.now(),
    });
    const doc = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(doc?.fundId).toBe(generalFundId);
    // No category/fund was EXPLICITLY supplied — the silent fund default must
    // never fake a real categorization.
    expect(doc?.status).toBe("unreviewed");
  });

  test("a chapter with only restricted funds degrades to no fund, without crashing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    // Only a restricted fund exists — `defaultFundId` never falls back to it,
    // so it resolves to `null` and the creation path must coalesce that to
    // `undefined` rather than throwing.
    await s.as.mutation(api.finances.createFund, {
      name: "Missions",
      restriction: "designated",
    });

    const txnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 1000,
      postedAt: Date.now(),
    });
    const doc = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(doc?.fundId).toBeUndefined();
    expect(doc?.status).toBe("unreviewed");
  });
});

describe("createBudget defaults the fund", () => {
  test("a chapter budget with no fundId lands on the General Fund", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const generalFundId = await s.as.mutation(api.finances.createFund, {
      name: "General Fund",
      restriction: "unrestricted",
    });

    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 50000,
      type: "recurring",
      cadence: "monthly",
      year: 2026,
      month: 7,
    });
    const doc = await run(s.t, (ctx) => ctx.db.get(budgetId));
    expect(doc?.fundId).toBe(generalFundId);
  });

  test("a central budget with no fundId stays fund-less (no chapter to resolve one from)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "manager", "central");

    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 50000,
      type: "recurring",
      cadence: "monthly",
      year: 2026,
      month: 7,
      central: true,
    });
    const doc = await run(s.t, (ctx) => ctx.db.get(budgetId));
    expect(doc?.fundId).toBeUndefined();
  });
});

describe("bulkCategorize defaults the fund", () => {
  test("omitting fundId in a bulk categorize lands the touched txn on the General Fund", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const generalFundId = await s.as.mutation(api.finances.createFund, {
      name: "General Fund",
      restriction: "unrestricted",
    });
    const categoryId = await s.as.mutation(api.finances.createCategory, {
      fundId: generalFundId,
      name: "Supplies",
      kind: "lineItem",
    });
    const txnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 2500,
      postedAt: Date.now(),
    });

    await s.as.mutation(api.finances.bulkCategorize, {
      transactionIds: [txnId],
      categoryId,
    });
    const doc = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(doc?.fundId).toBe(generalFundId);
    expect(doc?.categoryId).toBe(categoryId);
  });
});

describe("authz + tenancy", () => {
  test("a viewer cannot create a manual transaction (needs bookkeeper)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "viewer");
    await expect(
      s.as.mutation(api.finances.createManualTransaction, {
        flow: "outflow",
        amountCents: 100,
        postedAt: Date.now(),
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a cross-chapter fund id is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    // A fund that lives in a DIFFERENT chapter.
    const foreignFund = await run(t, async (ctx) => {
      const otherChapter = await ctx.db.insert("chapters", {
        name: "Boston",
        isActive: true,
        createdAt: Date.now(),
      });
      return ctx.db.insert("funds", {
        chapterId: otherChapter,
        name: "Foreign",
        restriction: "unrestricted",
        sortOrder: 0,
        createdAt: Date.now(),
      });
    });
    await expect(
      s.as.mutation(api.finances.createManualTransaction, {
        flow: "outflow",
        amountCents: 100,
        postedAt: Date.now(),
        fundId: foreignFund,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("enriched dashboards (prototype shapes)", () => {
  test("dashboardChapter: project budget joins spend + category breakdown; transfer excluded", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const year = 2026;
    const month = 5;

    const fundId = await s.as.mutation(api.finances.createFund, {
      name: "General",
      restriction: "unrestricted",
    });
    const categoryId = await s.as.mutation(api.finances.createCategory, {
      fundId,
      name: "Food",
      kind: "lineItem",
    });

    // An event to attach the per-instance budget to.
    const eventId = await run(t, async (ctx) => {
      const eventTypeId = await ctx.db.insert("eventTypes", {
        chapterId: s.chapterId,
        name: "Worship with Strangers",
        slug: "wws",
        version: 1,
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return ctx.db.insert("events", {
        chapterId: s.chapterId,
        eventTypeId,
        templateVersion: 1,
        name: "May Worship",
        eventDate: tsInMonth(year, month),
        status: "planning",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 40000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year,
      scopeRefId: eventId,
    });

    // $100 real spend on the event, coded to Food, EXPLICITLY linked to the
    // budget (carrying `eventId` alone is no longer an attribution link).
    const spendTxnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 10000,
      postedAt: tsInMonth(year, month),
      eventId,
      fundId,
      categoryId,
    });
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: spendTxnId,
      budgetId,
    });
    // A $50 transfer on the same event, also linked → excluded from spend.
    const transferTxnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "transfer",
      amountCents: 5000,
      postedAt: tsInMonth(year, month),
      eventId,
      fundId,
      categoryId,
    });
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: transferTxnId,
      budgetId,
    });

    const dash = await s.as.query(api.finances.dashboardChapter, { year, month });
    const card = dash.oneTimeBudgets.find((p) => p.id === budgetId);
    expect(card).toBeDefined();
    expect(card?.name).toBe("May Worship");
    expect(card?.cadence).toBe("per_instance");
    expect(card?.spentCents).toBe(10000); // transfer excluded
    expect(card?.budgetCents).toBe(40000);
    expect(card?.pct).toBe(25);
    expect(card?.remainingCents).toBe(30000);
    expect(card?.status).toBe("ok");
    const foodCat = card?.categories.find((c) => c.name === "Food");
    expect(foodCat?.spentCents).toBe(10000);
    expect(foodCat?.barPct).toBe(25); // 10000 / 40000

    // Tiles + attention shape.
    expect(dash.tiles[0].label).toContain("Spent");
    expect(dash.tiles.some((x) => x.label === "To review")).toBe(true);
    expect(Array.isArray(dash.attention)).toBe(true);
    expect(dash.attention.length).toBe(0);
  });

  test("dashboardChapter: recurring bucket status warns at ≥80%", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const year = 2026;
    const month = 6;
    const fundId = await s.as.mutation(api.finances.createFund, {
      name: "General",
      restriction: "unrestricted",
    });
    const categoryId = await s.as.mutation(api.finances.createCategory, {
      fundId,
      name: "Software",
      kind: "lineItem",
    });
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 10000,
      type: "recurring",
      cadence: "monthly",
      year,
      month,
      categoryId,
      label: "Software · June",
    });
    const txnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 9000, // 90% → warn
      postedAt: tsInMonth(year, month),
      fundId,
      categoryId,
    });
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txnId,
      budgetId,
    });
    const dash = await s.as.query(api.finances.dashboardChapter, { year, month });
    const bucket = dash.recurringBudgets.find((r) => r.id === budgetId);
    expect(bucket?.spentCents).toBe(9000);
    expect(bucket?.pct).toBe(90);
    expect(bucket?.status).toBe("warn");
  });

  test("dashboardChapter: ytd sums spend across months 1..selectedMonth; month mode unchanged", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const year = 2026;

    const fundId = await s.as.mutation(api.finances.createFund, {
      name: "General",
      restriction: "unrestricted",
    });
    // $10 in Jan, $20 in Feb, $40 in March.
    for (const [m, amt] of [
      [1, 1000],
      [2, 2000],
      [3, 4000],
    ] as const) {
      await s.as.mutation(api.finances.createManualTransaction, {
        flow: "outflow",
        amountCents: amt,
        postedAt: tsInMonth(year, m),
        fundId,
      });
    }

    // Month mode (default): February shows only February's $20.
    const monthFeb = await s.as.query(api.finances.dashboardChapter, {
      year,
      month: 2,
    });
    expect(monthFeb.tiles[0].subValueCents).toBe(2000);
    expect(monthFeb.tiles[0].label).toContain("Spent");
    expect(monthFeb.funds.find((f) => f.id === fundId)?.spentCents).toBe(2000);

    // YTD through February: Jan + Feb ($30), NOT March.
    const ytdFeb = await s.as.query(api.finances.dashboardChapter, {
      year,
      month: 2,
      period: "ytd",
    });
    expect(ytdFeb.tiles[0].subValueCents).toBe(3000); // 1000 + 2000
    expect(ytdFeb.tiles[0].label).toContain("YTD");
    expect(ytdFeb.funds.find((f) => f.id === fundId)?.spentCents).toBe(3000);

    // YTD through March: all three ($70).
    const ytdMar = await s.as.query(api.finances.dashboardChapter, {
      year,
      month: 3,
      period: "ytd",
    });
    expect(ytdMar.tiles[0].subValueCents).toBe(7000); // 1000 + 2000 + 4000
  });

  test("dashboardChapter: ytd recurring bucket sums spend + scales allocation", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const year = 2026;

    const fundId = await s.as.mutation(api.finances.createFund, {
      name: "General",
      restriction: "unrestricted",
    });
    const categoryId = await s.as.mutation(api.finances.createCategory, {
      fundId,
      name: "Ad spend",
      kind: "lineItem",
    });
    // "$2,000 / month" — stored WITHOUT a month (applies every month).
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 200000,
      type: "recurring",
      cadence: "monthly",
      year,
      categoryId,
      label: "Ad spend · monthly",
    });
    // $30 Jan, $50 Feb, $90 March — all coded to Ad spend AND explicitly
    // linked to the budget (fund/category alone is no longer an attribution
    // link under the explicit-only rule).
    for (const [m, amt] of [
      [1, 3000],
      [2, 5000],
      [3, 9000],
    ] as const) {
      const txnId = await s.as.mutation(api.finances.createManualTransaction, {
        flow: "outflow",
        amountCents: amt,
        postedAt: tsInMonth(year, m),
        fundId,
        categoryId,
      });
      await s.as.mutation(api.finances.categorizeTransaction, {
        transactionId: txnId,
        budgetId,
      });
    }

    // Month mode Feb: only Feb spend, one month's allocation.
    const monthFeb = await s.as.query(api.finances.dashboardChapter, {
      year,
      month: 2,
    });
    const mCard = monthFeb.recurringBudgets.find((r) => r.id === budgetId);
    expect(mCard?.spentCents).toBe(5000);
    expect(mCard?.budgetCents).toBe(200000); // one month, unchanged

    // YTD through Feb: Jan + Feb spend, two months of allocation.
    const ytdFeb = await s.as.query(api.finances.dashboardChapter, {
      year,
      month: 2,
      period: "ytd",
    });
    const yCard = ytdFeb.recurringBudgets.find((r) => r.id === budgetId);
    expect(yCard?.spentCents).toBe(8000); // 3000 + 5000, NOT March's 9000
    expect(yCard?.budgetCents).toBe(400000); // 200000 * 2
  });

  test("dashboardCentral: ytd sums spend across months 1..selectedMonth; month mode unchanged", async () => {
    const t = newT();
    // Superuser → implicit central manager.
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const year = 2026;
    // $70 Jan, $30 Feb, $99 March in the caller's (New York) chapter.
    for (const [m, amt] of [
      [1, 7000],
      [2, 3000],
      [3, 9900],
    ] as const) {
      await s.as.mutation(api.finances.createManualTransaction, {
        flow: "outflow",
        amountCents: amt,
        postedAt: tsInMonth(year, m),
      });
    }

    const monthFeb = await s.as.query(api.finances.dashboardCentral, {
      year,
      month: 2,
    });
    expect(monthFeb.totalMonthSpendCents).toBe(3000); // Feb only
    expect(monthFeb.tiles[0].label).toContain("all chapters");

    const ytdFeb = await s.as.query(api.finances.dashboardCentral, {
      year,
      month: 2,
      period: "ytd",
    });
    expect(ytdFeb.totalMonthSpendCents).toBe(10000); // 7000 + 3000, NOT March
    expect(ytdFeb.tiles[0].label).toContain("YTD");
    expect(ytdFeb.tiles[0].label).toContain("all chapters");
    expect(
      ytdFeb.chapterRollup.find((c) => c.chapterName === "New York")?.spentCents,
    ).toBe(10000);
  });

  test("dashboardCentral: chapter rollup + a by-tag rollup across two chapters", async () => {
    const t = newT();
    // Superuser → implicit central manager.
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const year = 2026;
    const month = 5;
    const when = tsInMonth(year, month);

    // Set up one chapter with an event, its one_time budget, a same-named
    // "Growth" tag, and a $spend linked to the budget. Returns nothing.
    const seedChapterBudget = async (
      chapterId: Id<"chapters">,
      eventName: string,
      amountSpent: number,
    ) => {
      await run(t, async (ctx) => {
        const eventTypeId = await ctx.db.insert("eventTypes", {
          chapterId,
          name: "Sunday Gathering",
          slug: "sunday",
          version: 1,
          createdBy: s.userId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        const eventId = await ctx.db.insert("events", {
          chapterId,
          eventTypeId,
          templateVersion: 1,
          name: eventName,
          eventDate: when,
          status: "planning",
          createdBy: s.userId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        const budgetId = await ctx.db.insert("budgets", {
          chapterId,
          amountCents: 100000,
          type: "one_time",
          refKind: "event",
          scopeRefId: eventId,
          cadence: "per_instance",
          year,
          createdAt: Date.now(),
        });
        // A shared-name "Growth" custom tag carried by each chapter's budget.
        const tagId = await ctx.db.insert("budgetTags", {
          chapterId,
          name: "Growth",
          kind: "custom",
          createdAt: Date.now(),
        });
        await ctx.db.insert("budgetTagLinks", {
          budgetId,
          tagId,
          chapterId,
          createdAt: Date.now(),
        });
        await ctx.db.insert("transactions", {
          chapterId,
          source: "manual",
          flow: "outflow",
          amountCents: amountSpent,
          postedAt: when,
          eventId,
          budgetId,
          status: "categorized",
          createdAt: Date.now(),
        });
      });
    };

    // Chapter A (New York, the caller's chapter): $70 linked to its budget.
    await seedChapterBudget(s.chapterId, "May Gathering", 7000);
    // Chapter B (Boston): $30 linked to its own budget carrying the same tag.
    const chapterB = await run(t, (ctx) =>
      ctx.db.insert("chapters", { name: "Boston", isActive: true, createdAt: Date.now() }),
    );
    await seedChapterBudget(chapterB, "Boston Gathering", 3000);

    const dash = await s.as.query(api.finances.dashboardCentral, { year, month });
    // Two chapters rolled up by month spend.
    const names = dash.chapterRollup.map((c) => c.chapterName);
    expect(names).toContain("New York");
    expect(names).toContain("Boston");
    expect(
      dash.chapterRollup.find((c) => c.chapterName === "New York")?.spentCents,
    ).toBe(7000);
    expect(
      dash.chapterRollup.find((c) => c.chapterName === "Boston")?.spentCents,
    ).toBe(3000);
    // One by-tag row aggregating both chapters' "Growth" budgets' actuals.
    const growth = dash.tagRollups.find((x) => x.tagName === "Growth");
    expect(growth?.spentCents).toBe(10000); // 7000 + 3000
    expect(growth?.budgetCents).toBe(200000); // 100000 + 100000
    // Global month tile.
    expect(dash.tiles[0].label).toContain("all chapters");
    expect(dash.totalMonthSpendCents).toBe(10000);
  });
});

describe("money-math regression fixes", () => {
  test("monthly budget with month=null reports only the queried month's spend", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const year = 2026;

    const fundId = await s.as.mutation(api.finances.createFund, {
      name: "General",
      restriction: "unrestricted",
    });
    const categoryId = await s.as.mutation(api.finances.createCategory, {
      fundId,
      name: "Ad spend",
      kind: "lineItem",
    });
    // "$2,000 / month" — stored WITHOUT a month (applies to every month).
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 200000,
      type: "recurring",
      cadence: "monthly",
      year,
      categoryId,
      label: "Ad spend · monthly",
    });
    // $30 spent in March, $50 in April — both explicitly linked to the budget.
    const marchTxnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 3000,
      postedAt: tsInMonth(year, 3),
      fundId,
      categoryId,
    });
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: marchTxnId,
      budgetId,
    });
    const aprilTxnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 5000,
      postedAt: tsInMonth(year, 4),
      fundId,
      categoryId,
    });
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: aprilTxnId,
      budgetId,
    });

    // dashboardChapter scopes the bucket to the dashboard month (not YTD).
    const march = await s.as.query(api.finances.dashboardChapter, {
      year,
      month: 3,
    });
    expect(
      march.recurringBudgets.find((r) => r.id === budgetId)?.spentCents,
    ).toBe(3000);
    const april = await s.as.query(api.finances.dashboardChapter, {
      year,
      month: 4,
    });
    expect(
      april.recurringBudgets.find((r) => r.id === budgetId)?.spentCents,
    ).toBe(5000);

    // budgetVsActual scopes the same way (pre-fix it summed all 12 months → 8000).
    const bvaMarch = await s.as.query(api.finances.budgetVsActual, {
      year,
      month: 3,
    });
    expect(bvaMarch.find((r) => r.budgetId === budgetId)?.actualCents).toBe(3000);
    const bvaApril = await s.as.query(api.finances.budgetVsActual, {
      year,
      month: 4,
    });
    expect(bvaApril.find((r) => r.budgetId === budgetId)?.actualCents).toBe(5000);
  });

  test("central chapterRollup normalizes a yearly budget to a month-equivalent", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const year = 2026;
    const month = 4;
    // A $1,200/yr chapter budget → $100 month-equivalent.
    await s.as.mutation(api.finances.createBudget, {
      amountCents: 120000,
      type: "recurring",
      cadence: "yearly",
      year,
    });
    // $50 of month spend.
    await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 5000,
      postedAt: tsInMonth(year, month),
    });
    const dash = await s.as.query(api.finances.dashboardCentral, { year, month });
    const ny = dash.chapterRollup.find((c) => c.chapterName === "New York");
    expect(ny?.budgetCents).toBe(10000); // 120000 / 12, NOT the full 120000
    expect(ny?.spentCents).toBe(5000);
    expect(ny?.status).toBe("ok"); // 50% of the month-equivalent allocation
  });

  test("updateBudget: pointing a one_time budget at a cross-chapter event is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asManager(s);
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 1000,
      type: "recurring",
      cadence: "monthly",
      year: 2026,
    });
    // An event living in a DIFFERENT chapter.
    const foreignEvent = await run(t, async (ctx) => {
      const otherChapter = await ctx.db.insert("chapters", {
        name: "Boston",
        isActive: true,
        createdAt: Date.now(),
      });
      const eventTypeId = await ctx.db.insert("eventTypes", {
        chapterId: otherChapter,
        name: "Other",
        slug: "other",
        version: 1,
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return ctx.db.insert("events", {
        chapterId: otherChapter,
        eventTypeId,
        templateVersion: 1,
        name: "Foreign",
        eventDate: Date.now(),
        status: "planning",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    await expect(
      s.as.mutation(api.finances.updateBudget, {
        budgetId,
        patch: { type: "one_time", refKind: "event", scopeRefId: foreignEvent },
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});
