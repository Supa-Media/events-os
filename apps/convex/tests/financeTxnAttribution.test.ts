/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { DEFAULT_EXPENSE_CATEGORIES, DEFAULT_FUNDS } from "../lib/seed/finance";

/**
 * "Every-dollar-attributed" finance follow-up tests:
 *  - Part A: default expense categories seeded for an empty chapter (idempotent,
 *    chapter-scoped) via the superuser mutation + the CLI internal wrapper.
 *  - Part B: the derived `needsBudget` flag (spend txn && no budget) on the txn
 *    read shape, and `dashboardChapter.toBudgetCount`.
 *  - Part C: the no-auth internal migration wrapper runs the same idempotent
 *    backfill as the superuser public mutation.
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

async function grantManager(s: ChapterSetup): Promise<void> {
  const personId = await seedSelfPerson(s);
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
}

/**
 * Grant a REAL (non-superuser) `scope: "central"` finance role, with NO
 * accompanying `scope: "chapter"` grant — a "pure central-only seat holder"
 * (an ED/FM with org-wide reach but no chapter-level finance grant of their
 * own). `getFinanceRole` matches a central grant against ANY target chapterId
 * (`g.scope === "central"`, regardless of which real chapter the row happens
 * to be keyed on — mirrors `grantFinanceRole`'s own "keyed on the granting
 * chapter" convention), so `chapterId: s.chapterId` here is just the granting
 * chapter, not a claim they hold chapter-level reach there too.
 */
async function grantCentralOnly(s: ChapterSetup): Promise<void> {
  const personId = await seedSelfPerson(s);
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role: "manager",
      scope: "central",
      createdAt: Date.now(),
    }),
  );
}

/** Raw-insert a General Fund so the category seeder has somewhere to hang them. */
async function insertGeneralFund(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
): Promise<Id<"funds">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("funds", {
      chapterId,
      name: "General Fund",
      restriction: "unrestricted",
      sortOrder: 0,
      isActive: true,
      createdAt: Date.now(),
    }),
  );
}

/** Read a chapter's `funds` rows (raw read — bypasses role/active-chapter). */
async function fundsFor(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
) {
  return await run(s.t, (ctx) =>
    ctx.db
      .query("funds")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .collect(),
  );
}

/** Count `budgetCategories` in a chapter (raw read — bypasses role/active-chapter). */
async function categoryCount(
  s: ChapterSetup,
  chapterId: Id<"chapters">,
): Promise<number> {
  const rows = await run(s.t, (ctx) =>
    ctx.db
      .query("budgetCategories")
      .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
      .collect(),
  );
  return rows.length;
}

describe("Part A — seedDefaultExpenseCategories", () => {
  test("creates the full default set for an empty chapter; idempotent; chapter-scoped", async () => {
    const t = newT();
    // Superuser gates the public seed mutation.
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    await insertGeneralFund(s, s.chapterId);

    // A second chapter (with a fund) that we never seed — proves scoping.
    const otherChapterId = await run(t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "Other",
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    await run(t, (ctx) =>
      ctx.db.insert("funds", {
        chapterId: otherChapterId,
        name: "General Fund",
        restriction: "unrestricted",
        sortOrder: 0,
        isActive: true,
        createdAt: Date.now(),
      }),
    );

    const first = await s.as.mutation(api.finances.seedDefaultExpenseCategories, {});
    expect(first.inserted).toBe(DEFAULT_EXPENSE_CATEGORIES.length);
    expect(await categoryCount(s, s.chapterId)).toBe(
      DEFAULT_EXPENSE_CATEGORIES.length,
    );

    // Every seeded row is a `kind: "category"` under the General Fund and names
    // exactly the default set.
    const rows = await run(t, (ctx) =>
      ctx.db
        .query("budgetCategories")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(rows.every((r) => r.kind === "category")).toBe(true);
    expect(new Set(rows.map((r) => r.name))).toEqual(
      new Set(DEFAULT_EXPENSE_CATEGORIES),
    );

    // Chapter-scoped: the untouched chapter still has none.
    expect(await categoryCount(s, otherChapterId)).toBe(0);

    // Idempotent: a re-run inserts nothing and leaves the count unchanged.
    const second = await s.as.mutation(api.finances.seedDefaultExpenseCategories, {});
    expect(second.inserted).toBe(0);
    expect(await categoryCount(s, s.chapterId)).toBe(
      DEFAULT_EXPENSE_CATEGORIES.length,
    );
  });

  test("seeds the one default fund first for a fund-less chapter, then categories; idempotent", async () => {
    const t = newT();
    // A real chapter created before the finance seed → ZERO funds.
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    expect(await fundsFor(s, s.chapterId)).toHaveLength(0);

    // One shot: creates the default fund, then the categories under it.
    const first = await s.as.mutation(
      api.finances.seedDefaultExpenseCategories,
      {},
    );
    expect(first.inserted).toBe(DEFAULT_EXPENSE_CATEGORIES.length);

    const funds = await fundsFor(s, s.chapterId);
    expect(new Set(funds.map((f) => f.name))).toEqual(
      new Set(DEFAULT_FUNDS.map((f) => f.name)),
    );
    // Funds go backend-only in WP-1.4 — exactly one, unrestricted.
    expect(funds).toHaveLength(1);
    const general = funds.find((f) => f.name === "General Fund");
    expect(general?.restriction).toBe("unrestricted");
    expect(await categoryCount(s, s.chapterId)).toBe(
      DEFAULT_EXPENSE_CATEGORIES.length,
    );

    // Categories hang off the newly-created General Fund.
    const rows = await run(t, (ctx) =>
      ctx.db
        .query("budgetCategories")
        .withIndex("by_chapter", (q) => q.eq("chapterId", s.chapterId))
        .collect(),
    );
    expect(rows.every((r) => r.fundId === general?._id)).toBe(true);

    // Idempotent: a re-run adds neither funds nor categories.
    const second = await s.as.mutation(
      api.finances.seedDefaultExpenseCategories,
      {},
    );
    expect(second.inserted).toBe(0);
    expect(await fundsFor(s, s.chapterId)).toHaveLength(DEFAULT_FUNDS.length);
    expect(await categoryCount(s, s.chapterId)).toBe(
      DEFAULT_EXPENSE_CATEGORIES.length,
    );
  });

  test("non-superuser is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t); // plain leader@publicworship.life
    await insertGeneralFund(s, s.chapterId);
    await expect(
      s.as.mutation(api.finances.seedDefaultExpenseCategories, {}),
    ).rejects.toThrow();
  });

  test("runSeedDefaultExpenseCategories (internal) seeds every category-less chapter, idempotently", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await insertGeneralFund(s, s.chapterId);

    const first = await t.mutation(
      internal.finances.runSeedDefaultExpenseCategories,
      {},
    );
    expect(first.chaptersSeeded).toBe(1);
    expect(first.inserted).toBe(DEFAULT_EXPENSE_CATEGORIES.length);
    expect(await categoryCount(s, s.chapterId)).toBe(
      DEFAULT_EXPENSE_CATEGORIES.length,
    );

    // Re-run: the chapter already has categories → skipped.
    const second = await t.mutation(
      internal.finances.runSeedDefaultExpenseCategories,
      {},
    );
    expect(second.chaptersSeeded).toBe(0);
    expect(second.inserted).toBe(0);
  });
});

describe("Part B — needsBudget + toBudgetCount", () => {
  test("needsBudget is true only for un-budgeted spend; toBudgetCount counts them", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantManager(s);
    const now = Date.now();

    // A raw-inserted budget to attribute one txn to.
    const budgetId = await run(t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 100000,
        type: "recurring",
        cadence: "monthly",
        year: 2026,
        createdAt: now,
      }),
    );

    // A: un-budgeted spend → needs a budget.
    const txnA = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 1500,
      postedAt: now,
    });
    // B: spend that we then attribute to a budget → no longer needs one.
    const txnB = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 2500,
      postedAt: now,
    });
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txnB,
      budgetId,
    });
    // C: transfer → excluded from spend, never flagged.
    await s.as.mutation(api.finances.createManualTransaction, {
      flow: "transfer",
      amountCents: 500,
      postedAt: now,
    });
    // D: outflow marked excluded → not spend, never flagged.
    const txnD = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 700,
      postedAt: now,
    });
    await s.as.mutation(api.finances.setTransactionStatus, {
      transactionId: txnD,
      status: "excluded",
    });
    // E: inflow → not spend.
    await s.as.mutation(api.finances.createManualTransaction, {
      flow: "inflow",
      amountCents: 9000,
      postedAt: now,
    });

    const page = await s.as.query(api.finances.listTransactions, {
      paginationOpts: { numItems: 50, cursor: null },
    });
    const byId = new Map(page.page.map((tr) => [tr.id, tr] as const));
    expect(byId.get(txnA)?.needsBudget).toBe(true);
    expect(byId.get(txnB)?.needsBudget).toBe(false);
    expect(byId.get(txnD)?.needsBudget).toBe(false);
    // Transfer + inflow never need a budget.
    for (const tr of page.page) {
      if (tr.flow !== "outflow") expect(tr.needsBudget).toBe(false);
    }

    // Only txn A (un-budgeted, non-excluded outflow) is counted.
    const dash = await s.as.query(api.finances.dashboardChapter, {});
    expect(dash.toBudgetCount).toBe(1);
  });
});

describe("Part C — runMigrateBudgetScopesToTypes (internal)", () => {
  test("runs the same idempotent v2 backfill without an auth gate", async () => {
    const t = newT();
    const s = await setupChapter(t);

    // A legacy budget: `scope`, no `type`.
    const legacy = await run(t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 40000,
        scope: "chapter",
        cadence: "yearly",
        year: 2026,
        createdAt: Date.now(),
      }),
    );

    const first = await t.mutation(
      internal.finances.runMigrateBudgetScopesToTypes,
      {},
    );
    expect(first.migrated).toBe(1);
    expect(first.skipped).toBe(0);

    const migrated = await run(t, (ctx) => ctx.db.get(legacy));
    expect(migrated?.type).toBe("recurring");

    // Idempotent: the now-v2 budget is skipped on a re-run.
    const second = await t.mutation(
      internal.finances.runMigrateBudgetScopesToTypes,
      {},
    );
    expect(second.migrated).toBe(0);
    expect(second.skipped).toBe(1);
  });
});

/** `Date.UTC` at noon Eastern-safe on the 15th of `month` (1-indexed), `year`. */
function tsInMonth(year: number, month: number): number {
  return Date.UTC(year, month - 1, 15, 17, 0, 0);
}

describe("WP-0.1 — explicit-only budget attribution + Unattributed bucket", () => {
  test("(a) a narrower-less recurring budget does NOT derive-match an unlinked txn in its period: budget spent = 0, Unattributed = the txn's amount", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantManager(s);
    const year = 2026;
    const month = 5;

    // A broad recurring budget with NO category/fund/team narrowers — the
    // exact shape that used to vacuum-match every uncategorized txn in period
    // (the "Education & Growth eats everything" bug).
    const budgetId = await run(t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 300000,
        type: "recurring",
        cadence: "monthly",
        year,
        month,
        label: "Education & Growth",
        createdAt: Date.now(),
      }),
    );

    // An unlinked outflow in the same period, with no fund/category/team.
    await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 4200,
      postedAt: tsInMonth(year, month),
    });

    const rows = await s.as.query(api.finances.budgetVsActual, { year, month });
    expect(rows.find((r) => r.budgetId === budgetId)?.actualCents).toBe(0);

    const dash = await s.as.query(api.finances.dashboardChapter, { year, month });
    expect(dash.unattributedCents).toBe(4200);
  });

  test("(b) an explicitly-linked txn counts toward exactly its budget and does NOT appear in Unattributed", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantManager(s);
    const year = 2026;
    const month = 5;

    const budgetId = await run(t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 300000,
        type: "recurring",
        cadence: "monthly",
        year,
        month,
        label: "Education & Growth",
        createdAt: Date.now(),
      }),
    );

    const txnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 4200,
      postedAt: tsInMonth(year, month),
    });
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: txnId,
      budgetId,
    });

    const rows = await s.as.query(api.finances.budgetVsActual, { year, month });
    expect(rows.find((r) => r.budgetId === budgetId)?.actualCents).toBe(4200);

    const dash = await s.as.query(api.finances.dashboardChapter, { year, month });
    expect(dash.unattributedCents).toBe(0);
  });

  test("(c) a transfer counts toward NEITHER a budget (even when explicitly linked) NOR Unattributed (even when unlinked)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantManager(s);
    const year = 2026;
    const month = 5;

    const budgetId = await run(t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 300000,
        type: "recurring",
        cadence: "monthly",
        year,
        month,
        label: "Education & Growth",
        createdAt: Date.now(),
      }),
    );

    // A LINKED transfer — still excluded from the budget's actual (isSpend
    // gate applies regardless of an explicit link).
    const linkedTransferId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "transfer",
      amountCents: 1000,
      postedAt: tsInMonth(year, month),
    });
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: linkedTransferId,
      budgetId,
    });
    // An UNLINKED transfer — must not show up as Unattributed either (a
    // transfer is never "spend needing a budget").
    await s.as.mutation(api.finances.createManualTransaction, {
      flow: "transfer",
      amountCents: 2000,
      postedAt: tsInMonth(year, month),
    });

    const rows = await s.as.query(api.finances.budgetVsActual, { year, month });
    expect(rows.find((r) => r.budgetId === budgetId)?.actualCents).toBe(0);

    const dash = await s.as.query(api.finances.dashboardChapter, { year, month });
    expect(dash.unattributedCents).toBe(0);
  });

  test("(d) the Reconcile `needs_budget` filter returns exactly the Unattributed transactions", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantManager(s);
    const now = Date.now();

    // An unlinked outflow → Unattributed + needs_budget.
    const unattributed = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 1500,
      postedAt: now,
    });
    // A linked outflow → NOT in needs_budget.
    const budgetId = await run(t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 100000,
        type: "recurring",
        cadence: "monthly",
        year: 2026,
        createdAt: now,
      }),
    );
    const linked = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 2500,
      postedAt: now,
    });
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: linked,
      budgetId,
    });
    // A transfer, unlinked → never needs_budget.
    await s.as.mutation(api.finances.createManualTransaction, {
      flow: "transfer",
      amountCents: 500,
      postedAt: now,
    });

    const reconcile = await s.as.query(api.finances.listReconcile, {
      filter: "needs_budget",
    });
    expect(reconcile.rows.map((r) => r.id)).toEqual([unattributed]);
    expect(reconcile.counts.needs_budget).toBe(1);
    expect(reconcile.rows.map((r) => r.id)).not.toContain(linked);
  });

  test("dashboardCentral.orgUnattributedCents sums unlinked spend across every chapter in the period", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const year = 2026;
    const month = 5;
    const when = tsInMonth(year, month);

    // New York (caller's chapter): one unlinked $40 outflow.
    await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 4000,
      postedAt: when,
    });
    // Boston: one unlinked $15 outflow.
    await run(t, async (ctx) => {
      const boston = await ctx.db.insert("chapters", {
        name: "Boston",
        isActive: true,
        createdAt: Date.now(),
      });
      await ctx.db.insert("transactions", {
        chapterId: boston,
        source: "manual",
        flow: "outflow",
        amountCents: 1500,
        postedAt: when,
        status: "unreviewed",
        createdAt: Date.now(),
      });
    });

    const dash = await s.as.query(api.finances.dashboardCentral, { year, month });
    expect(dash.orgUnattributedCents).toBe(5500);
  });
});

/** Seed an eventType + event in a chapter; returns its id. */
async function seedEvent(
  s: ChapterSetup,
  opts: { name?: string; eventDate: number },
): Promise<Id<"events">> {
  return await run(s.t, async (ctx) => {
    const eventTypeId = await ctx.db.insert("eventTypes", {
      chapterId: s.chapterId,
      name: "Worship with Strangers",
      slug: "wws",
      version: 1,
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return await ctx.db.insert("events", {
      chapterId: s.chapterId,
      eventTypeId,
      templateVersion: 1,
      name: opts.name ?? "May Concert",
      eventDate: opts.eventDate,
      status: "planning",
      createdBy: s.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

describe("Bug 1 — one-time budgets ignore the month selector (dashboardChapter)", () => {
  test("(a) a May-event budget is ABSENT from July's month view, but present in May and in YTD-through-July", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantManager(s);
    const year = 2026;
    const eventId = await seedEvent(s, { eventDate: tsInMonth(year, 5) });

    // Mirrors `createEventBudget`'s real shape: `month` stamped from the
    // event's own date at creation time.
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 100000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year,
      month: 5,
      scopeRefId: eventId,
    });
    const txnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 25000,
      postedAt: tsInMonth(year, 5),
    });
    await s.as.mutation(api.finances.categorizeTransaction, { transactionId: txnId, budgetId });

    // Before the fix, EVERY one_time budget rendered in EVERY month — a July
    // view must no longer show a May event's budget card.
    const july = await s.as.query(api.finances.dashboardChapter, { year, month: 7 });
    expect(july.oneTimeBudgets.find((b) => b.id === budgetId)).toBeUndefined();

    // May's own view still shows it, with its full (cumulative) spend.
    const may = await s.as.query(api.finances.dashboardChapter, { year, month: 5 });
    const card = may.oneTimeBudgets.find((b) => b.id === budgetId);
    expect(card).toBeDefined();
    expect(card?.spentCents).toBe(25000);
    expect(card?.name).toBe("May Concert");

    // YTD-through-July keeps every one-time card, unchanged.
    const ytdJuly = await s.as.query(api.finances.dashboardChapter, {
      year,
      month: 7,
      period: "ytd",
    });
    const ytdCard = ytdJuly.oneTimeBudgets.find((b) => b.id === budgetId);
    expect(ytdCard).toBeDefined();
    expect(ytdCard?.spentCents).toBe(25000);
  });

  test("(a2) a MONTH-LESS one-time budget's card stays visible via its linked event's date, and via its own posted spend", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantManager(s);
    const year = 2026;
    const eventId = await seedEvent(s, { name: "Fall Retreat", eventDate: tsInMonth(year, 9) });

    // No `month` passed — `createBudget` allows a one_time budget with no
    // stored month (the direct-create path, distinct from the auto-stamped
    // `createEventBudget` helper).
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 50000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year,
      scopeRefId: eventId,
    });

    // September (the event's own date) shows the card via the ref-date signal.
    const sept = await s.as.query(api.finances.dashboardChapter, { year, month: 9 });
    expect(sept.oneTimeBudgets.find((b) => b.id === budgetId)).toBeDefined();

    // August has neither an explicit month, nor a matching ref date, nor any
    // spend yet — the card is correctly absent.
    const augBefore = await s.as.query(api.finances.dashboardChapter, { year, month: 8 });
    expect(augBefore.oneTimeBudgets.find((b) => b.id === budgetId)).toBeUndefined();

    // Prep spend posted in AUGUST (before the event) now makes it relevant to
    // August too, via the "has transactions posted this month" signal.
    const txnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 8000,
      postedAt: tsInMonth(year, 8),
    });
    await s.as.mutation(api.finances.categorizeTransaction, { transactionId: txnId, budgetId });

    const augAfter = await s.as.query(api.finances.dashboardChapter, { year, month: 8 });
    const augCard = augAfter.oneTimeBudgets.find((b) => b.id === budgetId);
    expect(augCard).toBeDefined();
    // The card's own bar is cumulative — the September event's date doesn't
    // narrow it, so it still reports the one August prep transaction so far.
    expect(augCard?.spentCents).toBe(8000);
  });

  test("(b) a MONTH-LESS one-time budget's spend counts once, in its posted month — not in every month (budgetVsActual)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantManager(s);
    const year = 2026;

    // A one_time (project) budget summoned with NO month at all.
    const projectId = await run(t, (ctx) =>
      ctx.db.insert("projects", {
        chapterId: s.chapterId,
        name: "Website Refresh",
        status: "in_progress",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 200000,
      type: "one_time",
      refKind: "project",
      cadence: "per_instance",
      year,
      scopeRefId: projectId,
    });

    // $300 posted in May, explicitly linked.
    const mayTxn = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 30000,
      postedAt: tsInMonth(year, 5),
    });
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: mayTxn,
      budgetId,
    });

    // Before the fix, `budgetEffectivePeriod`'s per_instance branch ignored
    // `contextMonth` entirely for a month-less budget, so this $300 counted
    // toward EVERY month's `actualCents` — not just May's.
    const may = await s.as.query(api.finances.budgetVsActual, { year, month: 5 });
    expect(may.find((r) => r.budgetId === budgetId)?.actualCents).toBe(30000);

    const june = await s.as.query(api.finances.budgetVsActual, { year, month: 6 });
    expect(june.find((r) => r.budgetId === budgetId)?.actualCents).toBe(0);

    // The whole-year read (no month arg) still sums it exactly once.
    const wholeYear = await s.as.query(api.finances.budgetVsActual, { year });
    expect(wholeYear.find((r) => r.budgetId === budgetId)?.actualCents).toBe(30000);
  });

  test("(b2) the same double-count guard applies to a chapter tag rollup folding in a month-less one-time budget", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantManager(s);
    const year = 2026;

    const tagId = await s.as.mutation(api.finances.createBudgetTag, {
      name: "Capital",
      kind: "custom",
    });
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 200000,
      type: "one_time",
      cadence: "per_instance",
      year,
      label: "Equipment",
      tagIds: [tagId],
    });

    const mayTxn = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 15000,
      postedAt: tsInMonth(year, 5),
    });
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: mayTxn,
      budgetId,
    });

    const may = await s.as.query(api.finances.dashboardChapter, { year, month: 5 });
    expect(may.tagRollups.find((r) => r.tagId === tagId)?.spentCents).toBe(15000);

    // June must NOT also report the May spend — the rollup zero-spend filter
    // hides the tag entirely once its (correctly month-scoped) total is 0.
    const june = await s.as.query(api.finances.dashboardChapter, { year, month: 6 });
    expect(june.tagRollups.find((r) => r.tagId === tagId)).toBeUndefined();
  });
});

describe("Bug 2 — an unfunded (capCents <= 0) budget with real spend must NOT read as healthy", () => {
  test("a $0-cap budget with spend reports pct 100 (loud red bar), not 0% / green", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantManager(s);
    const year = 2026;
    const month = 5;

    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 0,
      type: "recurring",
      cadence: "monthly",
      year,
      month,
      label: "Unfunded",
    });
    const txnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 149527,
      postedAt: tsInMonth(year, month),
    });
    await s.as.mutation(api.finances.categorizeTransaction, { transactionId: txnId, budgetId });

    const dash = await s.as.query(api.finances.dashboardChapter, { year, month });
    const card = dash.recurringBudgets.find((b) => b.id === budgetId);
    expect(card?.spentCents).toBe(149527);
    expect(card?.budgetCents).toBe(0);
    // The loud/red state is carried purely through `pct` (client `BudgetBar`
    // goes danger-red at `pct >= 100`) — no separate "over" status literal.
    expect(card?.pct).toBe(100);
    expect(card?.status).toBe("warn");
  });

  test("a $0-cap budget with NO spend stays quiet: pct 0, status ok", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantManager(s);
    const year = 2026;
    const month = 5;

    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 0,
      type: "recurring",
      cadence: "monthly",
      year,
      month,
      label: "Unfunded, unspent",
    });

    const dash = await s.as.query(api.finances.dashboardChapter, { year, month });
    const card = dash.recurringBudgets.find((b) => b.id === budgetId);
    // A $0/unspent budget with nothing linked to it never surfaces at all —
    // `recurringAppliesToDash` still gates it in; assert the shape directly.
    expect(card?.spentCents ?? 0).toBe(0);
    expect(card?.pct ?? 0).toBe(0);
    expect(card?.status ?? "ok").toBe("ok");
  });

  test("a one-time budget's own card also reports the loud pct 100 / warn state when unfunded and spent", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantManager(s);
    const year = 2026;
    const eventId = await seedEvent(s, { eventDate: tsInMonth(year, 5) });

    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 0,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year,
      month: 5,
      scopeRefId: eventId,
    });
    const txnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 5000,
      postedAt: tsInMonth(year, 5),
    });
    await s.as.mutation(api.finances.categorizeTransaction, { transactionId: txnId, budgetId });

    const dash = await s.as.query(api.finances.dashboardChapter, { year, month: 5 });
    const card = dash.oneTimeBudgets.find((b) => b.id === budgetId);
    expect(card?.pct).toBe(100);
    expect(card?.status).toBe("warn");
    expect(card?.remainingCents).toBe(-5000);
  });
});

describe("Bug 1 (F1 follow-up) — 12-month sum invariant + central one-time cards", () => {
  test("a month-less one-time budget's actualCents summed across all 12 months equals the whole-year total exactly (no month dropped, none double-counted)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantManager(s);
    const year = 2026;

    const projectId = await run(t, (ctx) =>
      ctx.db.insert("projects", {
        chapterId: s.chapterId,
        name: "Year-Round Initiative",
        status: "in_progress",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 1200000,
      type: "one_time",
      refKind: "project",
      cadence: "per_instance",
      year,
      scopeRefId: projectId,
    });

    // A distinct, easily-summed amount every month ($10, $20, ..., $120) so an
    // off-by-one double-count or a dropped month is caught precisely, not
    // masked by equal amounts.
    let expectedTotal = 0;
    for (let m = 1; m <= 12; m++) {
      const amt = m * 1000;
      expectedTotal += amt;
      const txnId = await s.as.mutation(api.finances.createManualTransaction, {
        flow: "outflow",
        amountCents: amt,
        postedAt: tsInMonth(year, m),
      });
      await s.as.mutation(api.finances.categorizeTransaction, { transactionId: txnId, budgetId });
    }

    let summedAcrossMonths = 0;
    for (let m = 1; m <= 12; m++) {
      const rows = await s.as.query(api.finances.budgetVsActual, { year, month: m });
      summedAcrossMonths += rows.find((r) => r.budgetId === budgetId)?.actualCents ?? 0;
    }
    expect(summedAcrossMonths).toBe(expectedTotal);

    const wholeYear = await s.as.query(api.finances.budgetVsActual, { year });
    expect(wholeYear.find((r) => r.budgetId === budgetId)?.actualCents).toBe(expectedTotal);
  });

  test("F1: a central one-time (event) budget is hidden on an org-dashboard month it's irrelevant to, and its card stays cumulative on a relevant one", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const year = 2026;
    const eventId = await seedEvent(s, { name: "Central Gala", eventDate: tsInMonth(year, 5) });

    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 500000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year,
      month: 5,
      scopeRefId: eventId,
      central: true,
    });
    const txnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 40000,
      postedAt: tsInMonth(year, 5),
    });
    await s.as.mutation(api.finances.categorizeTransaction, { transactionId: txnId, budgetId });

    // Before F1, EVERY central budget rendered on EVERY month regardless of
    // type — a July org view must no longer show a May central event budget.
    const july = await s.as.query(api.finances.dashboardCentral, { year, month: 7 });
    expect(july.centralBudgets.find((b) => b.id === budgetId)).toBeUndefined();

    // May's own view still shows it, with its full (lifetime) spend.
    const may = await s.as.query(api.finances.dashboardCentral, { year, month: 5 });
    const card = may.centralBudgets.find((b) => b.id === budgetId);
    expect(card).toBeDefined();
    expect(card?.spentCents).toBe(40000);

    // YTD-through-July keeps every one-time card, unchanged — same as the
    // chapter dashboard's YTD behavior.
    const ytdJuly = await s.as.query(api.finances.dashboardCentral, {
      year,
      month: 7,
      period: "ytd",
    });
    const ytdCard = ytdJuly.centralBudgets.find((b) => b.id === budgetId);
    expect(ytdCard).toBeDefined();
    expect(ytdCard?.spentCents).toBe(40000);
  });

  test("F2 (fixed): a fixed-month one-time budget's card, made visible by an out-of-month charge, now DISPLAYS that same charge instead of showing $0", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantManager(s);
    const year = 2026;
    const eventId = await seedEvent(s, { name: "May Gala", eventDate: tsInMonth(year, 5) });

    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 100000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year,
      month: 5, // fixed to May
      scopeRefId: eventId,
    });
    // A JULY charge — outside the budget's own declared month.
    const julyTxn = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 7500,
      postedAt: tsInMonth(year, 7),
    });
    await s.as.mutation(api.finances.categorizeTransaction, { transactionId: julyTxn, budgetId });

    const july = await s.as.query(api.finances.dashboardChapter, { year, month: 7 });
    const card = july.oneTimeBudgets.find((b) => b.id === budgetId);
    // Visible in July — the July charge is exactly why (`oneTimeCardAppliesToDash`'s
    // "has spend this month" signal).
    expect(card).toBeDefined();
    // ...and now DISPLAYS that same charge: `oneTimeCardBreakdown` is
    // genuinely lifetime (matches purely on the explicit link + `isSpend`,
    // same as `actualsForRef`) — it no longer narrows to the budget's own
    // declared `month`, which previously left the card showing $0 spent even
    // though a real charge was the reason it was visible at all.
    expect(card?.spentCents).toBe(7500);

    // May's own view reports the SAME lifetime total, not an empty May-only
    // slice — the card's number never depends on which month you're viewing.
    const may = await s.as.query(api.finances.dashboardChapter, { year, month: 5 });
    const mayCard = may.oneTimeBudgets.find((b) => b.id === budgetId);
    expect(mayCard?.spentCents).toBe(7500);
  });
});

describe("By-tag rollup month-scoping + drill-down reconciliation (fix/tag-rollup-month-scope)", () => {
  test("a fixed-month one-time budget's tag row is HIDDEN in a month with no activity, present in its own month", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantManager(s);
    const year = 2026;
    const eventId = await seedEvent(s, { name: "Spring Fling", eventDate: tsInMonth(year, 5) });

    const tagId = await s.as.mutation(api.finances.createBudgetTag, {
      name: "Events",
      kind: "custom",
    });
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 250000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year,
      month: 5, // fixed to May, mirroring `createEventBudget`'s real stamping
      scopeRefId: eventId,
      tagIds: [tagId],
    });
    const mayTxn = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 187730,
      postedAt: tsInMonth(year, 5),
    });
    await s.as.mutation(api.finances.categorizeTransaction, { transactionId: mayTxn, budgetId });

    // Before the fix, `budgetEffectivePeriod`'s own-month-wins rule made this
    // May spend show up in EVERY month's tag rollup (the txn's own month was
    // compared against the BUDGET's declared month, never against the viewed
    // month) — a July view with zero actual July activity on this tag still
    // rendered it.
    const july = await s.as.query(api.finances.dashboardChapter, { year, month: 7 });
    expect(july.tagRollups.find((r) => r.tagId === tagId)).toBeUndefined();

    const may = await s.as.query(api.finances.dashboardChapter, { year, month: 5 });
    const row = may.tagRollups.find((r) => r.tagId === tagId);
    expect(row?.spentCents).toBe(187730);
  });

  test("a tag's spend is scoped to the txn's OWN posted month, not the budget's declared month — 12 months summed equal the whole-year (YTD) total", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantManager(s);
    const year = 2026;

    const tagId = await s.as.mutation(api.finances.createBudgetTag, {
      name: "Fundraisers",
      kind: "custom",
    });
    // Fixed to January — before the fix, every OTHER month's spend on this
    // budget was invisible to that month's own tag rollup (it only matched
    // January), while January's own rollup wrongly summed the whole year.
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 1200000,
      type: "one_time",
      cadence: "per_instance",
      year,
      month: 1,
      label: "Gala fund",
      tagIds: [tagId],
    });

    // A distinct, easily-summed amount every month ($10, $20, ..., $120) so a
    // dropped or double-counted month is caught precisely.
    let expectedTotal = 0;
    for (let m = 1; m <= 12; m++) {
      const amt = m * 1000;
      expectedTotal += amt;
      const txnId = await s.as.mutation(api.finances.createManualTransaction, {
        flow: "outflow",
        amountCents: amt,
        postedAt: tsInMonth(year, m),
      });
      await s.as.mutation(api.finances.categorizeTransaction, { transactionId: txnId, budgetId });
    }

    let summedAcrossMonths = 0;
    for (let m = 1; m <= 12; m++) {
      const dash = await s.as.query(api.finances.dashboardChapter, { year, month: m });
      const row = dash.tagRollups.find((r) => r.tagId === tagId);
      expect(row?.spentCents ?? 0).toBe(m * 1000);
      summedAcrossMonths += row?.spentCents ?? 0;
    }
    expect(summedAcrossMonths).toBe(expectedTotal);

    const ytd = await s.as.query(api.finances.dashboardChapter, {
      year,
      month: 12,
      period: "ytd",
    });
    expect(ytd.tagRollups.find((r) => r.tagId === tagId)?.spentCents).toBe(expectedTotal);
  });

  test("chapter tag drill-down: rows sum EXACTLY to the rollup row's header (spentCents AND budgetCents), across two budgets with different declared months", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantManager(s);
    const year = 2026;
    const month = 7;

    const tagId = await s.as.mutation(api.finances.createBudgetTag, {
      name: "Events",
      kind: "custom",
    });
    // Budget A: fixed to May, but with a JULY charge (the mis-scoping case
    // the fix targets).
    const eventId = await seedEvent(s, { name: "May Gala", eventDate: tsInMonth(year, 5) });
    const budgetA = await s.as.mutation(api.finances.createBudget, {
      amountCents: 200000,
      type: "one_time",
      refKind: "event",
      cadence: "per_instance",
      year,
      month: 5,
      scopeRefId: eventId,
      tagIds: [tagId],
    });
    const julyTxnA = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 50000,
      postedAt: tsInMonth(year, month),
    });
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: julyTxnA,
      budgetId: budgetA,
    });

    // Budget B: month-less, also with a July charge.
    const budgetB = await s.as.mutation(api.finances.createBudget, {
      amountCents: 300000,
      type: "one_time",
      cadence: "per_instance",
      year,
      label: "Second event",
      tagIds: [tagId],
    });
    const julyTxnB = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 12345,
      postedAt: tsInMonth(year, month),
    });
    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: julyTxnB,
      budgetId: budgetB,
    });

    const dash = await s.as.query(api.finances.dashboardChapter, { year, month });
    const header = dash.tagRollups.find((r) => r.tagId === tagId);
    expect(header).toBeDefined();
    expect(header?.spentCents).toBe(62345);

    const drilldown = await s.as.query(api.finances.tagDrilldown, {
      year,
      month,
      scope: "chapter",
      tagId,
    });
    expect(drilldown.budgets.map((b) => b.id).sort()).toEqual([budgetA, budgetB].sort());
    const rowsSpent = drilldown.budgets.reduce((sum, b) => sum + b.spentCents, 0);
    const rowsBudget = drilldown.budgets.reduce((sum, b) => sum + b.budgetCents, 0);
    // Reconciliation: the drill-down's rows must sum to exactly the same
    // header the rollup row above it showed — no "—" rows, no drift.
    expect(rowsSpent).toBe(header!.spentCents);
    expect(rowsBudget).toBe(header!.budgetCents);
  });

  test("central tag drill-down: a PURE central-only viewer (no chapter finance seat of their own) sees every chapter's contributing budgets, reconciling with the org rollup header", async () => {
    const t = newT();
    const s = await setupChapter(t, { chapterName: "New York" });
    await grantCentralOnly(s);
    const year = 2026;
    const month = 7;

    // The caller's OWN chapter (New York) carries the tag too — proves BOTH
    // "their own chapter's budget" and "a chapter they hold no personal
    // finance grant in at all" show up. Before the fix, a pure central-only
    // holder's drill-down came back EMPTY for every row regardless of
    // chapter — the old client backfill (`budgetVsActual`) only ever resolves
    // the CALLER's own chapter, and this caller can't even call it (no
    // chapter-scope grant to pass `requireFinanceRole(ctx, chapterId,
    // "viewer")`).
    const nyTagId = await run(t, (ctx) =>
      ctx.db.insert("budgetTags", {
        chapterId: s.chapterId,
        name: "Events",
        kind: "custom",
        createdAt: Date.now(),
      }),
    );
    const nyBudgetId = await run(t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 250000,
        type: "one_time",
        cadence: "per_instance",
        year,
        label: "NY Gala",
        createdAt: Date.now(),
      }),
    );
    await run(t, (ctx) =>
      ctx.db.insert("budgetTagLinks", {
        budgetId: nyBudgetId,
        tagId: nyTagId,
        chapterId: s.chapterId,
        createdAt: Date.now(),
      }),
    );
    await run(t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 38203,
        postedAt: tsInMonth(year, month),
        status: "unreviewed",
        budgetId: nyBudgetId,
        createdAt: Date.now(),
      }),
    );

    // A SECOND, unrelated chapter (Boston) — the caller holds NO finance
    // grant there at all, only central reach.
    const bostonId = await run(t, (ctx) =>
      ctx.db.insert("chapters", { name: "Boston", isActive: true, createdAt: Date.now() }),
    );
    const bostonTagId = await run(t, (ctx) =>
      ctx.db.insert("budgetTags", {
        chapterId: bostonId,
        name: "Events",
        kind: "custom",
        createdAt: Date.now(),
      }),
    );
    const bostonBudgetId = await run(t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: bostonId,
        amountCents: 150000,
        type: "one_time",
        cadence: "per_instance",
        year,
        label: "Boston Field Day",
        createdAt: Date.now(),
      }),
    );
    await run(t, (ctx) =>
      ctx.db.insert("budgetTagLinks", {
        budgetId: bostonBudgetId,
        tagId: bostonTagId,
        chapterId: bostonId,
        createdAt: Date.now(),
      }),
    );
    await run(t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: bostonId,
        source: "manual",
        flow: "outflow",
        amountCents: 149527,
        postedAt: tsInMonth(year, month),
        status: "unreviewed",
        budgetId: bostonBudgetId,
        createdAt: Date.now(),
      }),
    );

    const dash = await s.as.query(api.finances.dashboardCentral, { year, month });
    const header = dash.tagRollups.find((r) => r.tagName === "Events" && r.kind === "custom");
    expect(header).toBeDefined();
    expect(header?.spentCents).toBe(38203 + 149527);

    const drilldown = await s.as.query(api.finances.tagDrilldown, {
      year,
      month,
      scope: "central",
      tagName: "Events",
      tagKind: "custom",
    });
    expect(drilldown.budgets.map((b) => b.id).sort()).toEqual(
      [nyBudgetId, bostonBudgetId].sort(),
    );
    const bostonRow = drilldown.budgets.find((b) => b.id === bostonBudgetId);
    expect(bostonRow?.chapterName).toBe("Boston");
    expect(bostonRow?.spentCents).toBe(149527);
    const nyRow = drilldown.budgets.find((b) => b.id === nyBudgetId);
    expect(nyRow?.chapterName).toBe("New York");
    expect(nyRow?.spentCents).toBe(38203);

    const rowsSpent = drilldown.budgets.reduce((sum, b) => sum + b.spentCents, 0);
    expect(rowsSpent).toBe(header!.spentCents);
  });

  test("chapter-scope tagDrilldown requires finance access — throws for a caller with no finance role at all", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // No grantManager — the caller has no finance role in their own chapter.
    const tagId = await run(t, (ctx) =>
      ctx.db.insert("budgetTags", {
        chapterId: s.chapterId,
        name: "Events",
        kind: "custom",
        createdAt: Date.now(),
      }),
    );
    await expect(
      s.as.query(api.finances.tagDrilldown, {
        year: 2026,
        month: 7,
        scope: "chapter",
        tagId,
      }),
    ).rejects.toThrow();
  });
});
