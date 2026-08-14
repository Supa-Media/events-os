/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import { runOrgWideBudgetCategories } from "../migrations/0077_org_wide_budget_categories";

/**
 * `0077_org_wide_budget_categories` — the collapse.
 *
 * Every chapter used to carry its own copy of the same category names, so
 * "Supplies" was N rows meaning one thing. This migration keeps one row per
 * name and repoints everything that pointed at the others. What it must never
 * get wrong is the REPOINTING: a missed reference is a dangling id in live
 * financial data, and Convex will hand back `null` for it forever after the
 * duplicate is deleted.
 *
 * Pinned here: the collapse itself, every reference table named in the
 * migration's doc, the keeper's attribute merge, the cycle guard, and
 * idempotence.
 */

async function insertCategory(
  s: ChapterSetup,
  name: string,
  opts: {
    chapterId?: Id<"chapters">;
    fundId?: Id<"funds">;
    expenseType?: "general" | "travel" | "meal" | "lodging";
    isActive?: boolean;
    parentCategoryId?: Id<"budgetCategories">;
  } = {},
): Promise<Id<"budgetCategories">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("budgetCategories", {
      name,
      kind: "category",
      createdAt: Date.now(),
      ...(opts.chapterId ? { chapterId: opts.chapterId } : {}),
      ...(opts.fundId ? { fundId: opts.fundId } : {}),
      ...(opts.expenseType ? { expenseType: opts.expenseType } : {}),
      ...(opts.isActive !== undefined ? { isActive: opts.isActive } : {}),
      ...(opts.parentCategoryId
        ? { parentCategoryId: opts.parentCategoryId }
        : {}),
    }),
  );
}

async function makeChapter(s: ChapterSetup, name: string): Promise<Id<"chapters">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("chapters", { name, isActive: true, createdAt: Date.now() }),
  );
}

async function seedFund(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
): Promise<Id<"funds">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("funds", {
      chapterId,
      name: "General Fund",
      restriction: "unrestricted",
      sortOrder: 0,
      createdAt: Date.now(),
    }),
  );
}

/** The migration is a plain `MutationCtx` function — run it the same way the
 *  registry's runner does. */
async function migrate(s: ChapterSetup) {
  return await run(s.t, (ctx) => runOrgWideBudgetCategories(ctx as never));
}

async function categories(s: ChapterSetup) {
  return await run(s.t, (ctx) => ctx.db.query("budgetCategories").collect());
}

describe("0077: collapsing same-named categories", () => {
  test("keeps the OLDEST row per trimmed, case-insensitive name and deletes the rest", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const boston = await makeChapter(s, "Boston");

    const keeper = await insertCategory(s, "Supplies", { chapterId: s.chapterId });
    // Same label, different chapter, different spelling/whitespace.
    const dupe1 = await insertCategory(s, "  supplies ", { chapterId: boston });
    const dupe2 = await insertCategory(s, "SUPPLIES", { chapterId: boston });
    // A genuinely different label survives untouched.
    const other = await insertCategory(s, "Transportation", {
      chapterId: s.chapterId,
    });

    const res = await migrate(s);
    expect(res.merged).toBe(2);
    expect(res.categoriesBefore).toBe(4);
    expect(res.categoriesAfter).toBe(2);

    const rows = await categories(s);
    expect(rows.map((r) => r._id).sort()).toEqual([keeper, other].sort());
    expect(await run(t, (ctx) => ctx.db.get(dupe1))).toBeNull();
    expect(await run(t, (ctx) => ctx.db.get(dupe2))).toBeNull();
  });

  test("clears the vestigial chapterId / fundId off every survivor", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const fundId = await seedFund(s, s.chapterId);
    const keeper = await insertCategory(s, "Supplies", {
      chapterId: s.chapterId,
      fundId,
    });

    const res = await migrate(s);
    expect(res.fieldsCleared).toBe(1);

    const row = await run(t, (ctx) => ctx.db.get(keeper));
    expect(row?.chapterId).toBeUndefined();
    expect(row?.fundId).toBeUndefined();
    // The fund itself is untouched — funds stay chapter-scoped.
    expect((await run(t, (ctx) => ctx.db.get(fundId)))?.chapterId).toBe(s.chapterId);
  });

  test("a blank-named row is never merged into another blank-named row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const a = await insertCategory(s, "");
    const b = await insertCategory(s, "   ");

    const res = await migrate(s);
    expect(res.merged).toBe(0);
    expect(await run(t, (ctx) => ctx.db.get(a))).not.toBeNull();
    expect(await run(t, (ctx) => ctx.db.get(b))).not.toBeNull();
  });
});

describe("0077: every reference is repointed before the duplicate is deleted", () => {
  test("transactions, budgets, budget lines, reimbursement lines, event items, engagements, contractor payments, undo snapshots, and the nesting link", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const boston = await makeChapter(s, "Boston");
    const now = Date.now();

    const keeper = await insertCategory(s, "Supplies", { chapterId: s.chapterId });
    const dupe = await insertCategory(s, "supplies", { chapterId: boston });

    // 1. transactions.categoryId
    const txnId = await run(t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: boston,
        source: "manual",
        flow: "outflow",
        amountCents: 1200,
        postedAt: now,
        status: "categorized",
        categoryId: dupe,
        createdAt: now,
      }),
    );
    // 1b. transactions.aiSuggestion.{categoryId,baseline.categoryId} — inert
    // frozen history, repointed anyway so nothing dangles in a money record.
    const suggestedTxnId = await run(t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: boston,
        source: "manual",
        flow: "outflow",
        amountCents: 900,
        postedAt: now,
        status: "unreviewed",
        createdAt: now,
        aiSuggestion: {
          categoryId: dupe,
          baseline: {
            status: "unreviewed" as const,
            fundId: null,
            categoryId: dupe,
            budgetId: null,
          },
        },
      }),
    );

    // 2. budgets.categoryId
    const budgetId = await run(t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: boston,
        amountCents: 50000,
        type: "recurring",
        cadence: "monthly",
        year: 2026,
        categoryId: dupe,
        createdAt: now,
      }),
    );

    // 3. budgetLines.categoryId
    const lineId = await run(t, (ctx) =>
      ctx.db.insert("budgetLines", {
        budgetId,
        description: "Tape",
        categoryId: dupe,
        plannedCents: 1000,
        sortOrder: 0,
        createdBy: s.userId,
        createdAt: now,
      }),
    );

    // 4. reimbursementLineItems.categoryId
    const requestId = await run(t, (ctx) =>
      ctx.db.insert("reimbursementRequests", {
        chapterId: boston,
        token: "tok_0077",
        status: "submitted",
        payeeName: "Dana Rivers",
        payeeEmail: "dana@example.com",
        totalCents: 1200,
        submittedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const reimbLineId = await run(t, (ctx) =>
      ctx.db.insert("reimbursementLineItems", {
        chapterId: boston,
        reimbursementId: requestId,
        description: "Tape",
        amountCents: 1200,
        categoryId: dupe,
        order: 0,
        createdAt: now,
      }),
    );

    // 5. eventItems.budgetCategoryId
    const eventTypeId = await run(t, (ctx) =>
      ctx.db.insert("eventTypes", {
        chapterId: boston,
        name: "Gathering",
        slug: "gathering",
        version: 1,
        createdBy: s.userId,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const eventId = await run(t, (ctx) =>
      ctx.db.insert("events", {
        chapterId: boston,
        eventTypeId,
        templateVersion: 1,
        name: "Sunday",
        eventDate: now,
        status: "planning",
        createdBy: s.userId,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const itemId = await run(t, (ctx) =>
      ctx.db.insert("eventItems", {
        eventId,
        chapterId: boston,
        module: "supplies",
        title: "Rent chairs",
        order: 0,
        budgetCategoryId: dupe,
      }),
    );

    // 6. engagements.budgetCategoryId
    const personId = await run(t, (ctx) =>
      ctx.db.insert("people", { chapterId: boston, name: "Vendor", createdAt: now }),
    );
    const engagementId = await run(t, (ctx) =>
      ctx.db.insert("engagements", {
        eventId,
        chapterId: boston,
        personId,
        type: "paid",
        status: "confirmed",
        createdAt: now,
        budgetCategoryId: dupe,
      }),
    );

    // 6b. contractorPayments.categoryId — the reference this migration missed
    // on its first pass, because the feature merged while it was being written.
    // A payment left pointing at a merged-away duplicate is a dangling id in a
    // row that pays a real person.
    const contractorPaymentId = await run(t, (ctx) =>
      ctx.db.insert("contractorPayments", {
        chapterId: boston,
        token: "tok_0077",
        status: "draft",
        origin: "staff_prefilled",
        payeeName: "Lighting Co",
        serviceDescription: "Stage lighting",
        agreedAmountCents: 50_000,
        agreementTermsVersion: 1,
        categoryId: dupe,
        createdAt: now,
        updatedAt: now,
      }),
    );

    // 7. reattributionAudit.priorStates[].categoryId (the bulk-move UNDO)
    const auditId = await run(t, (ctx) =>
      ctx.db.insert("reattributionAudit", {
        kind: "bulk_reassign",
        actorUserId: s.userId,
        transactionIds: [txnId],
        target: "central",
        summary: "Boston (1) → Central",
        priorStates: [
          {
            transactionId: txnId,
            chapterId: boston,
            categoryId: dupe,
          },
        ],
        createdAt: now,
      }),
    );

    // 8. budgetCategories.parentCategoryId (the self-reference)
    const child = await insertCategory(s, "Gaffer tape", {
      parentCategoryId: dupe,
    });

    const res = await migrate(s);
    expect(res.merged).toBe(1);
    expect(res.repointed).toMatchObject({
      "transactions.categoryId": 1,
      "transactions.aiSuggestion.categoryId": 1,
      "budgets.categoryId": 1,
      "budgetLines.categoryId": 1,
      "reimbursementLineItems.categoryId": 1,
      "eventItems.budgetCategoryId": 1,
      "engagements.budgetCategoryId": 1,
      "contractorPayments.categoryId": 1,
      "reattributionAudit.priorStates": 1,
      "budgetCategories.parentCategoryId": 1,
    });

    // Every one of them now points at the survivor, and none at a dead row.
    expect(
      (await run(t, (ctx) => ctx.db.get(contractorPaymentId)))?.categoryId,
    ).toBe(keeper);
    expect((await run(t, (ctx) => ctx.db.get(txnId)))?.categoryId).toBe(keeper);
    const suggested = await run(t, (ctx) => ctx.db.get(suggestedTxnId));
    expect(suggested?.aiSuggestion?.categoryId).toBe(keeper);
    expect(suggested?.aiSuggestion?.baseline?.categoryId).toBe(keeper);
    expect((await run(t, (ctx) => ctx.db.get(budgetId)))?.categoryId).toBe(keeper);
    expect((await run(t, (ctx) => ctx.db.get(lineId)))?.categoryId).toBe(keeper);
    expect((await run(t, (ctx) => ctx.db.get(reimbLineId)))?.categoryId).toBe(keeper);
    expect((await run(t, (ctx) => ctx.db.get(itemId)))?.budgetCategoryId).toBe(keeper);
    expect((await run(t, (ctx) => ctx.db.get(engagementId)))?.budgetCategoryId).toBe(
      keeper,
    );
    const audit = await run(t, (ctx) => ctx.db.get(auditId));
    expect(audit?.priorStates[0].categoryId).toBe(keeper);
    expect((await run(t, (ctx) => ctx.db.get(child)))?.parentCategoryId).toBe(keeper);

    // ...and the duplicate really is gone.
    expect(await run(t, (ctx) => ctx.db.get(dupe))).toBeNull();
  });

  test("a reference to a category that was ALREADY dangling is left alone, not guessed at", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const gone = await insertCategory(s, "Vanished");
    await run(t, (ctx) => ctx.db.delete(gone));
    await insertCategory(s, "Supplies");

    const budgetId = await run(t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 1000,
        type: "recurring",
        cadence: "monthly",
        year: 2026,
        categoryId: gone,
        createdAt: Date.now(),
      }),
    );

    await migrate(s);
    // Still pointing at the same (dead) id — inventing a target would be a
    // guess about somebody's money.
    expect((await run(t, (ctx) => ctx.db.get(budgetId)))?.categoryId).toBe(gone);
  });
});

describe("0077: the keeper's merged attributes", () => {
  test("inherits an expenseType hint from a duplicate when it has none", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const keeper = await insertCategory(s, "Food & Meals");
    await insertCategory(s, "food & meals", { expenseType: "meal" });

    await migrate(s);
    expect((await run(t, (ctx) => ctx.db.get(keeper)))?.expenseType).toBe("meal");
  });

  test("does NOT overwrite a hint the keeper already carries", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const keeper = await insertCategory(s, "Travel & Lodging", {
      expenseType: "travel",
    });
    await insertCategory(s, "travel & lodging", { expenseType: "lodging" });

    await migrate(s);
    expect((await run(t, (ctx) => ctx.db.get(keeper)))?.expenseType).toBe("travel");
  });

  test("stays ACTIVE if any copy was — one chapter's tidy-up doesn't retire the org's label", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const keeper = await insertCategory(s, "Supplies", { isActive: false });
    await insertCategory(s, "supplies", { isActive: true });

    await migrate(s);
    expect((await run(t, (ctx) => ctx.db.get(keeper)))?.isActive).toBe(true);
  });

  test("a label every chapter had already retired stays retired", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const keeper = await insertCategory(s, "Supplies", { isActive: false });
    await insertCategory(s, "supplies", { isActive: false });

    await migrate(s);
    expect((await run(t, (ctx) => ctx.db.get(keeper)))?.isActive).toBe(false);
  });
});

describe("0077: the nesting stays acyclic", () => {
  test("breaks a cycle the collapse itself manufactured", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const boston = await makeChapter(s, "Boston");

    // Chapter A nests Supplies UNDER Equipment; Boston nests Equipment UNDER
    // Supplies. Neither tree is cyclic on its own. The keepers are the OLDEST
    // row per name, so they land in DIFFERENT chapters — Supplies from A,
    // Equipment from Boston — and the remap makes the two point at each other.
    const aSupplies = await insertCategory(s, "Supplies", {
      chapterId: s.chapterId,
    });
    const bEquipment = await insertCategory(s, "Equipment", { chapterId: boston });
    const aEquipment = await insertCategory(s, "equipment", {
      chapterId: s.chapterId,
    });
    const bSupplies = await insertCategory(s, "supplies", { chapterId: boston });
    await run(t, (ctx) =>
      ctx.db.patch(aSupplies, { parentCategoryId: aEquipment }),
    );
    await run(t, (ctx) =>
      ctx.db.patch(bEquipment, { parentCategoryId: bSupplies }),
    );

    const res = await migrate(s);
    expect(res.merged).toBe(2);
    expect(res.parentCyclesBroken).toBeGreaterThan(0);

    // Neither survivor can reach itself by walking up.
    for (const id of [aSupplies, bEquipment]) {
      let cursor = (await run(t, (ctx) => ctx.db.get(id)))?.parentCategoryId;
      let hops = 0;
      while (cursor && hops < 10) {
        expect(cursor).not.toBe(id);
        cursor = (await run(t, (ctx) => ctx.db.get(cursor!)))?.parentCategoryId;
        hops += 1;
      }
      expect(hops).toBeLessThan(10);
    }
  });

  test("breaks a SELF-parent the collapse manufactured", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const boston = await makeChapter(s, "Boston");

    // The keeper's parent is its own duplicate — after the remap it would
    // point at itself.
    const keeper = await insertCategory(s, "Supplies", { chapterId: s.chapterId });
    const dupe = await insertCategory(s, "supplies", { chapterId: boston });
    await run(t, (ctx) => ctx.db.patch(keeper, { parentCategoryId: dupe }));

    const res = await migrate(s);
    expect(res.parentCyclesBroken).toBe(1);
    expect((await run(t, (ctx) => ctx.db.get(keeper)))?.parentCategoryId).toBeUndefined();
  });

  test("a legitimate parent/child pair survives the collapse intact", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const boston = await makeChapter(s, "Boston");
    const parent = await insertCategory(s, "Supplies", { chapterId: s.chapterId });
    const child = await insertCategory(s, "Gaffer tape", {
      chapterId: s.chapterId,
      parentCategoryId: parent,
    });
    // Boston's duplicate of the PARENT only.
    await insertCategory(s, "supplies", { chapterId: boston });

    const res = await migrate(s);
    expect(res.parentCyclesBroken).toBe(0);
    expect((await run(t, (ctx) => ctx.db.get(child)))?.parentCategoryId).toBe(parent);
  });
});

describe("0077: idempotence", () => {
  test("a second run is a complete no-op", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const boston = await makeChapter(s, "Boston");
    const fundId = await seedFund(s, s.chapterId);
    const keeper = await insertCategory(s, "Supplies", {
      chapterId: s.chapterId,
      fundId,
    });
    const dupe = await insertCategory(s, "supplies", { chapterId: boston });
    const txnId = await run(t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: boston,
        source: "manual",
        flow: "outflow",
        amountCents: 1200,
        postedAt: Date.now(),
        status: "categorized",
        categoryId: dupe,
        createdAt: Date.now(),
      }),
    );

    const first = await migrate(s);
    expect(first.merged).toBe(1);
    expect(first.fieldsCleared).toBe(1);

    const second = await migrate(s);
    expect(second.merged).toBe(0);
    expect(second.fieldsCleared).toBe(0);
    expect(second.parentCyclesBroken).toBe(0);
    expect(Object.values(second.repointed).every((n) => n === 0)).toBe(true);

    // The data is exactly where the first run left it.
    expect(await categories(s)).toHaveLength(1);
    expect((await run(t, (ctx) => ctx.db.get(txnId)))?.categoryId).toBe(keeper);
  });

  test("a database already under the new rule is untouched", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // Written by post-deploy code: no chapter, no fund, no duplicates.
    await insertCategory(s, "Supplies");
    await insertCategory(s, "Transportation");

    const res = await migrate(s);
    expect(res.merged).toBe(0);
    expect(res.fieldsCleared).toBe(0);
    expect(await categories(s)).toHaveLength(2);
  });
});
