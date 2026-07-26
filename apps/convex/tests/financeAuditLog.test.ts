/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { createReceipt } from "../lib/receiptLinks";

/**
 * `financeAuditLog` — the append-only field-change trail (founder ask: "let's
 * get more audit trails when people update reconcile rows... whatever you
 * feel like would be most important for the financial part of this app").
 * See `schema/finances.ts`'s own doc comment on the table for the design.
 *
 * Covers the headline instrumentation:
 *  - excluding a transaction without a reason throws; with one, it logs;
 *  - a recode logs before → after NAMES (not raw ids);
 *  - personal flag / note edit / receipt attach-detach / manual create /
 *    budget amount change / budget delete each log their own action;
 *  - `financeAuditTrail` is authz-gated (bookkeeper+) and scope-correct
 *    (mirrors `requireReconcileTxn`'s central/chapter rule);
 *  - the log is append-only — nothing patches or deletes a row once written.
 */

async function seedSelfPerson(s: ChapterSetup, name = "Caller"): Promise<Id<"people">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name,
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

async function seedTxn(s: ChapterSetup, amountCents = 4200): Promise<Id<"transactions">> {
  return await s.as.mutation(api.finances.createManualTransaction, {
    flow: "outflow",
    amountCents,
    postedAt: Date.now(),
    merchantName: "Coffee Shop",
  });
}

async function seedFund(s: ChapterSetup): Promise<Id<"funds">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("funds", {
      chapterId: s.chapterId,
      name: "General Fund",
      restriction: "unrestricted",
      sortOrder: 0,
      isActive: true,
      createdAt: Date.now(),
    }),
  );
}

async function seedCategory(
  s: ChapterSetup,
  fundId: Id<"funds">,
  name: string,
): Promise<Id<"budgetCategories">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("budgetCategories", {
      chapterId: s.chapterId,
      fundId,
      name,
      kind: "category",
      createdAt: Date.now(),
    }),
  );
}

async function seedBudget(
  s: ChapterSetup,
  label: string,
  amountCents = 100000,
): Promise<Id<"budgets">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("budgets", {
      chapterId: s.chapterId,
      amountCents,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      label,
      createdAt: Date.now(),
    }),
  );
}

async function trailFor(
  s: ChapterSetup,
  subjectType: "transaction" | "budget",
  subjectId: string,
) {
  return await s.as.query(api.finances.financeAuditTrail, { subjectType, subjectId });
}

describe("setTransactionStatus — excluding requires a reason (the headline instrumentation)", () => {
  test("excluding without a reason throws REASON_REQUIRED and logs nothing", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const txnId = await seedTxn(s);

    let caught: unknown;
    try {
      await s.as.mutation(api.finances.setTransactionStatus, {
        transactionId: txnId,
        status: "excluded",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe("REASON_REQUIRED");

    const doc = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(doc?.status).toBe("unreviewed"); // never patched

    // Only `seedTxn`'s own `manual_create` row exists — the rejected exclude
    // attempt logged nothing.
    const trail = await trailFor(s, "transaction", txnId);
    expect(trail.map((r) => r.action)).toEqual(["manual_create"]);
  });

  test("a blank (whitespace-only) reason is rejected the same as a missing one", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const txnId = await seedTxn(s);

    await expect(
      s.as.mutation(api.finances.setTransactionStatus, {
        transactionId: txnId,
        status: "excluded",
        reason: "   ",
      }),
    ).rejects.toMatchObject({ data: { code: "REASON_REQUIRED" } });
  });

  test("excluding WITH a reason succeeds and logs a status_change row (before/after labels + the reason + the actor)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s, "Bookkeeper Bea");
    await grantRole(s, personId, "bookkeeper");
    const txnId = await seedTxn(s, 45000);

    await s.as.mutation(api.finances.setTransactionStatus, {
      transactionId: txnId,
      status: "excluded",
      reason: "Duplicate charge, refunded by the vendor",
    });

    const doc = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(doc?.status).toBe("excluded");

    const trail = await trailFor(s, "transaction", txnId);
    const statusRow = trail.find((r) => r.action === "status_change")!;
    expect(statusRow.field).toBe("status");
    // `createManualTransaction` codes an explicit merchant, so the txn started
    // "unreviewed" (no fund/category/budget supplied) — before/after are
    // human labels, never raw status literals or ids.
    expect(statusRow.before).toBe("Unreviewed");
    expect(statusRow.after).toBe("Excluded");
    expect(statusRow.reason).toBe("Duplicate charge, refunded by the vendor");
    expect(statusRow.amountCents).toBe(45000);
    expect(statusRow.actorName).toBe("Bookkeeper Bea");
  });

  test("other transitions (e.g. → reconciled) log WITHOUT requiring a reason", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const txnId = await seedTxn(s);

    await s.as.mutation(api.finances.setTransactionStatus, {
      transactionId: txnId,
      status: "reconciled",
    });

    const trail = await trailFor(s, "transaction", txnId);
    const statusRow = trail.find((r) => r.action === "status_change")!;
    expect(statusRow.after).toBe("Reconciled");
    expect(statusRow.reason).toBeNull();
  });
});

describe("categorizeTransaction / setTransactionCategory — recode logs before → after NAMES", () => {
  test("categorizeTransaction logs the category AND budget NAMES, not raw ids", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const fundId = await seedFund(s);
    const missions = await seedCategory(s, fundId, "Missions");
    const outreach = await seedCategory(s, fundId, "Outreach");
    const budgetA = await seedBudget(s, "Q1 Ops");
    const budgetB = await seedBudget(s, "Q2 Ops");
    const txnId = await seedTxn(s);

    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txnId,
      categoryId: missions,
      budgetId: budgetA,
    });
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txnId,
      categoryId: outreach,
      budgetId: budgetB,
    });

    const trail = await trailFor(s, "transaction", txnId);
    // 2 category rows + 2 budget rows (one recode call each), newest first.
    const categoryRows = trail.filter((r) => r.field === "category");
    const budgetRows = trail.filter((r) => r.field === "budget");
    expect(categoryRows).toHaveLength(2);
    expect(budgetRows).toHaveLength(2);
    expect(categoryRows.every((r) => r.action === "recode")).toBe(true);

    // Newest first: the second call (None/Missions → Outreach) is index 0.
    expect(categoryRows[0].before).toBe("Missions");
    expect(categoryRows[0].after).toBe("Outreach");
    expect(categoryRows[1].before).toBe("None");
    expect(categoryRows[1].after).toBe("Missions");

    expect(budgetRows[0].before).toBe("Q1 Ops");
    expect(budgetRows[0].after).toBe("Q2 Ops");
    expect(budgetRows[1].before).toBe("None");
    expect(budgetRows[1].after).toBe("Q1 Ops");
  });

  test("re-picking the SAME category is a no-op — nothing new is logged", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const fundId = await seedFund(s);
    const missions = await seedCategory(s, fundId, "Missions");
    const txnId = await seedTxn(s);

    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txnId,
      categoryId: missions,
    });
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txnId,
      categoryId: missions,
    });

    const trail = await trailFor(s, "transaction", txnId);
    expect(trail.filter((r) => r.field === "category")).toHaveLength(1);
  });

  test("categorizeTransaction never logs the SILENT fund auto-default as a recode", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const fundId = await seedFund(s);
    const missions = await seedCategory(s, fundId, "Missions");
    const txnId = await seedTxn(s); // no fund yet

    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txnId,
      categoryId: missions,
    });

    // The txn now has a fund (the silent default), but no `field:"fund"` row
    // exists — only the explicitly-chosen category was logged (alongside
    // `seedTxn`'s own `manual_create` row from creating the transaction).
    const doc = await run(s.t, (ctx) => ctx.db.get(txnId));
    expect(doc?.fundId).toBeDefined();
    const trail = await trailFor(s, "transaction", txnId);
    expect(trail.some((r) => r.field === "fund")).toBe(false);
    expect(trail.filter((r) => r.field === "category")).toHaveLength(1);
    expect(trail.map((r) => r.action).sort()).toEqual(["manual_create", "recode"]);
  });

  test("setTransactionCategory (the category-only editor) logs the same recode shape", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const fundId = await seedFund(s);
    const missions = await seedCategory(s, fundId, "Missions");
    const txnId = await seedTxn(s);

    await s.as.mutation(api.finances.setTransactionCategory, {
      transactionId: txnId,
      categoryId: missions,
    });

    const trail = await trailFor(s, "transaction", txnId);
    const recode = trail.find((r) => r.action === "recode")!;
    expect(recode.field).toBe("category");
    expect(recode.before).toBe("None");
    expect(recode.after).toBe("Missions");
  });

  test("bulkCategorize logs a recode row per transaction it touches", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const fundId = await seedFund(s);
    const missions = await seedCategory(s, fundId, "Missions");
    const txnA = await seedTxn(s);
    const txnB = await seedTxn(s);

    await s.as.mutation(api.finances.bulkCategorize, {
      transactionIds: [txnA, txnB],
      categoryId: missions,
    });

    const trailA = await trailFor(s, "transaction", txnA);
    const trailB = await trailFor(s, "transaction", txnB);
    const recodeA = trailA.find((r) => r.action === "recode")!;
    const recodeB = trailB.find((r) => r.action === "recode")!;
    expect(recodeA.after).toBe("Missions");
    expect(recodeB.after).toBe("Missions");
  });
});

describe("flagPersonal / setTransactionNote / receipts — the rest of the reconcile trail", () => {
  test("flagPersonal logs personal_flag only on a real change", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const txnId = await seedTxn(s);

    await s.as.mutation(api.finances.flagPersonal, { transactionId: txnId, isPersonal: true });
    // Re-asserting the SAME value is a no-op — no second row.
    await s.as.mutation(api.finances.flagPersonal, { transactionId: txnId, isPersonal: true });
    await s.as.mutation(api.finances.flagPersonal, { transactionId: txnId, isPersonal: false });

    const trail = await trailFor(s, "transaction", txnId);
    const flags = trail.filter((r) => r.action === "personal_flag");
    expect(flags).toHaveLength(2);
    expect(flags[0].before).toBe("Personal");
    expect(flags[0].after).toBe("Not personal");
    expect(flags[1].before).toBe("Not personal");
    expect(flags[1].after).toBe("Personal");
  });

  test("setTransactionNote logs note_edit, skipping a true no-op save", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const txnId = await seedTxn(s);

    await s.as.mutation(api.finances.setTransactionNote, {
      transactionId: txnId,
      note: "Coffee with a donor",
    });
    // Saving the identical note again logs nothing new.
    await s.as.mutation(api.finances.setTransactionNote, {
      transactionId: txnId,
      note: "Coffee with a donor",
    });

    const trail = await trailFor(s, "transaction", txnId);
    expect(trail.filter((r) => r.action === "note_edit")).toHaveLength(1);
    expect(trail[0].before).toBeNull();
    expect(trail[0].after).toBe("Coffee with a donor");
  });

  test("attachReceipt logs receipt_attach", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const txnId = await seedTxn(s);
    const storageId = await run(s.t, (ctx) =>
      (ctx.storage as unknown as { store: (b: Blob) => Promise<Id<"_storage">> }).store(
        new Blob(["x"], { type: "image/png" }),
      ),
    );

    await s.as.mutation(api.finances.attachReceipt, { transactionId: txnId, storageId });

    const trail = await trailFor(s, "transaction", txnId);
    const attach = trail.find((r) => r.action === "receipt_attach")!;
    expect(attach.after).toBe("Attached");
  });

  test("createManualTransaction logs manual_create", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");

    const txnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 12345,
      postedAt: Date.now(),
      merchantName: "Office Depot",
    });

    const trail = await trailFor(s, "transaction", txnId);
    expect(trail).toHaveLength(1);
    expect(trail[0].action).toBe("manual_create");
    expect(trail[0].amountCents).toBe(12345);
    expect(trail[0].after).toContain("Office Depot");
  });
});

describe("receipts.linkReceipt / unlinkReceipt — the inbox-matching attach/detach paths", () => {
  test("linkReceipt logs receipt_attach; unlinkReceipt logs receipt_detach", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const txnId = await seedTxn(s);
    const storageId = await run(s.t, (ctx) =>
      (ctx.storage as unknown as { store: (b: Blob) => Promise<Id<"_storage">> }).store(
        new Blob(["r"], { type: "image/png" }),
      ),
    );
    const receiptId = await run(s.t, (ctx) =>
      createReceipt(ctx, { chapterId: s.chapterId, storageId, source: "upload" }),
    );

    await s.as.mutation(api.receipts.linkReceipt, { receiptId, transactionId: txnId });
    await s.as.mutation(api.receipts.unlinkReceipt, { receiptId, transactionId: txnId });

    const trail = await trailFor(s, "transaction", txnId);
    const receiptRows = trail.filter((r) => r.action.startsWith("receipt_"));
    expect(receiptRows.map((r) => r.action)).toEqual(["receipt_detach", "receipt_attach"]);
    expect(receiptRows[0].before).toBe("Attached");
    expect(receiptRows[0].after).toBe("None");
    expect(receiptRows[1].before).toBe("None");
    expect(receiptRows[1].after).toBe("Attached");
  });
});

describe("updateBudget / deleteBudget — budget-side instrumentation", () => {
  test("updateBudget logs budget_amount_change only when the amount actually changes", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "manager");
    const budgetId = await seedBudget(s, "Ops", 50000);

    // Same value — no log.
    await s.as.mutation(api.finances.updateBudget, {
      budgetId,
      patch: { amountCents: 50000 },
    });
    let trail = await trailFor(s, "budget", budgetId);
    expect(trail).toEqual([]);

    // A real change — logs before/after as formatted dollars.
    await s.as.mutation(api.finances.updateBudget, {
      budgetId,
      patch: { amountCents: 80000 },
    });
    trail = await trailFor(s, "budget", budgetId);
    expect(trail).toHaveLength(1);
    expect(trail[0].action).toBe("budget_amount_change");
    expect(trail[0].before).toBe("$500.00");
    expect(trail[0].after).toBe("$800.00");
    expect(trail[0].amountCents).toBe(80000);
  });

  test("deleteBudget logs budget_delete before the row disappears", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "manager");
    const budgetId = await seedBudget(s, "Retiring Budget", 30000);

    await s.as.mutation(api.finances.deleteBudget, { budgetId });

    expect(await run(s.t, (ctx) => ctx.db.get(budgetId))).toBeNull();
    const trail = await trailFor(s, "budget", budgetId);
    expect(trail).toHaveLength(1);
    expect(trail[0].action).toBe("budget_delete");
    expect(trail[0].before).toContain("Retiring Budget");
    expect(trail[0].before).toContain("$300.00");
  });
});

describe("financeAuditTrail — authz-gated (bookkeeper+) and scope-correct", () => {
  test("a plain member with no finance role at all is rejected (FORBIDDEN), not shown an empty list", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "manager");
    const txnId = await seedTxn(s);
    await s.as.mutation(api.finances.setTransactionStatus, {
      transactionId: txnId,
      status: "reconciled",
    });

    // Downgrade to no role at all (below viewer).
    await run(s.t, async (ctx) => {
      const grant = await ctx.db
        .query("financeRoles")
        .withIndex("by_person", (q) => q.eq("personId", personId))
        .first();
      await ctx.db.delete(grant!._id);
    });

    await expect(trailFor(s, "transaction", txnId)).rejects.toBeInstanceOf(ConvexError);
  });

  test("a chapter VIEWER (below bookkeeper) is rejected too — this trail is bookkeeper+, unlike listReconcile's viewer-level read", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "manager");
    const txnId = await seedTxn(s);
    await s.as.mutation(api.finances.setTransactionStatus, {
      transactionId: txnId,
      status: "reconciled",
    });
    await run(s.t, async (ctx) => {
      const grant = await ctx.db
        .query("financeRoles")
        .withIndex("by_person", (q) => q.eq("personId", personId))
        .first();
      await ctx.db.patch(grant!._id, { role: "viewer" });
    });

    let caught: unknown;
    try {
      await trailFor(s, "transaction", txnId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe("FORBIDDEN");
  });

  test("a bookkeeper CAN read the trail", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const txnId = await seedTxn(s);
    await s.as.mutation(api.finances.setTransactionStatus, {
      transactionId: txnId,
      status: "reconciled",
    });

    const trail = await trailFor(s, "transaction", txnId);
    expect(trail.length).toBeGreaterThan(0);
  });

  test("a DIFFERENT chapter's caller (no central reach) reading a chapter subject gets an empty list, not a leak", async () => {
    const t = newT();
    const owner = await setupChapter(t, { email: "owner@publicworship.life", chapterName: "NY" });
    const ownerPerson = await seedSelfPerson(owner, "Owner");
    await grantRole(owner, ownerPerson, "bookkeeper");
    const txnId = await seedTxn(owner);
    await owner.as.mutation(api.finances.setTransactionStatus, {
      transactionId: txnId,
      status: "reconciled",
    });

    const other = await setupChapter(t, { email: "other@publicworship.life", chapterName: "LA" });
    const otherPerson = await seedSelfPerson(other, "Other");
    await grantRole(other, otherPerson, "bookkeeper");

    const trail = await other.as.query(api.finances.financeAuditTrail, {
      subjectType: "transaction",
      subjectId: txnId,
    });
    expect(trail).toEqual([]);
  });

  test("a central-owned transaction requires central reach — a plain chapter bookkeeper (no central grant) is rejected, mirroring requireReconcileTxn's own central gate", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "manager", "central");

    const centralTxnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 5000,
      postedAt: Date.now(),
      central: true,
    });
    await s.as.mutation(api.finances.setTransactionStatus, {
      transactionId: centralTxnId,
      status: "reconciled",
    });
    const centralTrail = await trailFor(s, "transaction", centralTxnId);
    expect(centralTrail.length).toBeGreaterThan(0);

    // A different, plain chapter-only bookkeeper (no central grant) is
    // rejected outright — `requireFinanceCentral` throws FORBIDDEN, the same
    // as it would for a WRITE on this central txn via `requireReconcileTxn`.
    const plain = await setupChapter(t, { email: "plain@publicworship.life", chapterName: "LA" });
    const plainPerson = await seedSelfPerson(plain, "Plain");
    await grantRole(plain, plainPerson, "bookkeeper");
    await expect(
      plain.as.query(api.finances.financeAuditTrail, {
        subjectType: "transaction",
        subjectId: centralTxnId,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("append-only — nothing patches or deletes a financeAuditLog row once written", () => {
  test("a row logged by one action survives every subsequent action on the same transaction, byte for byte", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const personId = await seedSelfPerson(s);
    await grantRole(s, personId, "bookkeeper");
    const fundId = await seedFund(s);
    const missions = await seedCategory(s, fundId, "Missions");
    const txnId = await seedTxn(s);

    await s.as.mutation(api.finances.setTransactionNote, {
      transactionId: txnId,
      note: "First note",
    });
    const beforeTrail = await trailFor(s, "transaction", txnId);
    // `seedTxn` already logged its own `manual_create` row — this note_edit
    // is the newest of the two so far.
    expect(beforeTrail).toHaveLength(2);
    const noteRowId = beforeTrail.find((r) => r.action === "note_edit")!.id;
    const before = await run(s.t, (ctx) => ctx.db.get(noteRowId));

    // A pile of unrelated follow-up actions on the SAME transaction.
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txnId,
      categoryId: missions,
    });
    await s.as.mutation(api.finances.flagPersonal, { transactionId: txnId, isPersonal: true });
    await s.as.mutation(api.finances.setTransactionStatus, {
      transactionId: txnId,
      status: "excluded",
      reason: "test cleanup",
    });

    const after = await run(s.t, (ctx) => ctx.db.get(noteRowId));
    expect(after).toEqual(before); // untouched — append-only

    // The log strictly GREW; the note row is still exactly where it was,
    // never rewritten or removed by any later action on the same transaction.
    const afterTrail = await trailFor(s, "transaction", txnId);
    expect(afterTrail.length).toBe(beforeTrail.length + 3);
    expect(afterTrail.find((r) => r.id === noteRowId)).toBeDefined();
  });
});
