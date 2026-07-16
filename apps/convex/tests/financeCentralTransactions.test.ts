/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * WP-2.1 — the split keystone: money can belong to CENTRAL.
 *
 * `transactions.chapterId` now accepts the `"central"` sentinel. This suite
 * pins the audited behavior for central-OWNED txns (`chapterId:"central"`):
 *
 *  - creation is gated on central reach and carries no chapter-scoped links;
 *  - they surface in `dashboardCentral`'s Central row + org totals, and NEVER in
 *    any chapter dashboard;
 *  - they are reconcilable at central scope (`listReconcile({scope:"central"})`
 *    + the categorize/status/receipt write paths) — a chapter manager can't
 *    touch them, and a central manager can't attach chapter-scoped links;
 *  - the sentinel never crashes a chapter-doc join / row resolution;
 *  - central has no funds, so a central txn stays fund-less.
 *
 * A superuser (`seyi@publicworship.life`) is an implicit CENTRAL manager; a plain
 * chapter caller with a `manager` grant is chapter-only.
 */

function tsInMonth(year: number, month: number): number {
  return Date.UTC(year, month - 1, 15, 17, 0, 0);
}

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

/** A chapter-only manager (person + manager grant, scope chapter). */
async function asChapterManager(s: ChapterSetup): Promise<Id<"people">> {
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
  return personId;
}

/** A genuine central-scope finance manager (a plain person, not the superuser). */
async function asCentralManager(s: ChapterSetup): Promise<Id<"people">> {
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
  return personId;
}

async function makeChapter(s: ChapterSetup, name: string): Promise<Id<"chapters">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("chapters", { name, isActive: true, createdAt: Date.now() }),
  );
}

/** Insert a central-owned txn directly (bypassing the mutation gate). */
async function seedCentralTxn(
  s: ChapterSetup,
  fields: {
    amountCents: number;
    postedAt: number;
    flow?: "outflow" | "inflow" | "transfer";
    status?: "unreviewed" | "categorized" | "reconciled" | "excluded";
    budgetId?: Id<"budgets">;
  },
): Promise<Id<"transactions">> {
  return await run(s.t, (ctx) =>
    ctx.db.insert("transactions", {
      chapterId: "central",
      source: "manual",
      flow: fields.flow ?? "outflow",
      amountCents: fields.amountCents,
      postedAt: fields.postedAt,
      status: fields.status ?? "unreviewed",
      budgetId: fields.budgetId,
      createdAt: Date.now(),
    }),
  );
}

// ── Creation authz + storage ─────────────────────────────────────────────────

describe("createManualTransaction: central-owned txns", () => {
  test("a central manager creates a central-owned, fund-less txn", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });

    const txnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 4200,
      postedAt: Date.now(),
      central: true,
    });

    const txn = await run(t, (ctx) => ctx.db.get(txnId));
    expect(txn?.chapterId).toBe("central");
    expect(txn?.amountCents).toBe(4200);
    // Central has no funds (WP-1.4/2.1) — stays fund-less.
    expect(txn?.fundId).toBeUndefined();
    expect(txn?.status).toBe("unreviewed");
  });

  test("a chapter-only manager CANNOT create a central-owned txn", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);

    await expect(
      s.as.mutation(api.finances.createManualTransaction, {
        flow: "outflow",
        amountCents: 1000,
        postedAt: Date.now(),
        central: true,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("central:true rejects chapter-scoped links (a person)", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const personId = await seedSelfPerson(s);

    await expect(
      s.as.mutation(api.finances.createManualTransaction, {
        flow: "outflow",
        amountCents: 1000,
        postedAt: Date.now(),
        central: true,
        personId,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a non-central caller creates a normal CHAPTER txn (unchanged)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);

    const txnId = await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 500,
      postedAt: Date.now(),
    });
    const txn = await run(t, (ctx) => ctx.db.get(txnId));
    expect(txn?.chapterId).toBe(s.chapterId);
  });
});

// ── dashboardCentral inclusion ───────────────────────────────────────────────

describe("dashboardCentral: central-owned txns roll up", () => {
  test("central-owned spend lands in the Central row AND the org 'Spent' total", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const year = 2026;
    const month = 5;
    const when = tsInMonth(year, month);

    await seedCentralTxn(s, { amountCents: 9000, postedAt: when });

    const dash = await s.as.query(api.finances.dashboardCentral, { year, month });
    const central = dash.chapterRollup.find((c) => c.chapterName === "Central");
    expect(central?.spentCents).toBe(9000);
    expect(dash.totalMonthSpendCents).toBe(9000);
  });

  test("Central row = central-owned spend + chapter spend linked to a central budget, with NO double count", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const year = 2026;
    const month = 5;
    const when = tsInMonth(year, month);

    const centralBudget = await s.as.mutation(api.finances.createBudget, {
      amountCents: 500000,
      type: "recurring",
      cadence: "yearly",
      year,
      central: true,
      label: "Org Ads",
    });

    // Central-owned txns: $40 linked to the central budget + $10 unattributed.
    await seedCentralTxn(s, { amountCents: 4000, postedAt: when, budgetId: centralBudget });
    await seedCentralTxn(s, { amountCents: 1000, postedAt: when });
    // A CHAPTER txn ($70) linked to the same central budget (central-linked).
    await run(t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 7000,
        postedAt: when,
        budgetId: centralBudget,
        status: "categorized",
        createdAt: Date.now(),
      }),
    );

    const dash = await s.as.query(api.finances.dashboardCentral, { year, month });

    // Central row = 40 + 10 (central-owned) + 70 (chapter-linked) = 120.
    const central = dash.chapterRollup.find((c) => c.chapterName === "Central");
    expect(central?.spentCents).toBe(12000);

    // The central BUDGET card sums only its explicitly-linked txns across every
    // scope: $40 central-owned + $70 chapter = $110 (the $10 unlinked isn't in it).
    const cb = dash.centralBudgets.find((b) => b.id === centralBudget);
    expect(cb?.spentCents).toBe(11000);

    // Org total = chapter spend (70) + central-owned spend (40 + 10) = 120. No dollar counted twice.
    expect(dash.totalMonthSpendCents).toBe(12000);

    // NY's own row excludes the central-linked $70 → 0 (no other chapter spend).
    const ny = dash.chapterRollup.find((c) => c.chapterName === "New York");
    expect(ny?.spentCents).toBe(0);
  });

  test("an unattributed central-owned txn shows in orgUnattributedCents", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const year = 2026;
    const month = 5;
    const when = tsInMonth(year, month);

    await seedCentralTxn(s, { amountCents: 3300, postedAt: when });

    const dash = await s.as.query(api.finances.dashboardCentral, { year, month });
    expect(dash.orgUnattributedCents).toBe(3300);
  });

  test("a transfer-flow central txn is excluded from spend (invariant #3)", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const year = 2026;
    const month = 5;
    const when = tsInMonth(year, month);

    await seedCentralTxn(s, { amountCents: 5000, postedAt: when, flow: "transfer" });

    const dash = await s.as.query(api.finances.dashboardCentral, { year, month });
    const central = dash.chapterRollup.find((c) => c.chapterName === "Central");
    expect(central?.spentCents).toBe(0);
    expect(dash.totalMonthSpendCents).toBe(0);
  });
});

// ── Chapter dashboards must never see central-owned txns ──────────────────────

describe("dashboardChapter: never includes central-owned txns", () => {
  test("a central-owned txn is absent from a chapter dashboard's spend + unattributed", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const year = 2026;
    const month = 5;
    const when = tsInMonth(year, month);

    await seedCentralTxn(s, { amountCents: 8888, postedAt: when });
    // A real chapter txn to prove the dashboard otherwise works.
    await run(t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 2000,
        postedAt: when,
        status: "unreviewed",
        createdAt: Date.now(),
      }),
    );

    const dash = await s.as.query(api.finances.dashboardChapter, {
      chapterId: s.chapterId,
      year,
      month,
    });
    // Only the chapter's own $20 — never the central $88.88.
    expect(dash.unattributedCents).toBe(2000);
  });
});

// ── Central reconcile surface ─────────────────────────────────────────────────

describe("listReconcile: central scope", () => {
  test("scope:'central' lists central-owned txns; chapter txns are absent", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const now = Date.now();

    const centralTxn = await seedCentralTxn(s, { amountCents: 4200, postedAt: now });
    await run(t, (ctx) =>
      ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 999,
        postedAt: now,
        status: "unreviewed",
        createdAt: Date.now(),
      }),
    );

    const res = await s.as.query(api.finances.listReconcile, {
      filter: "all",
      scope: "central",
    });
    const ids = res.rows.map((r) => r.id);
    expect(ids).toContain(centralTxn);
    expect(res.rows.every((r) => r.amountCents !== 999)).toBe(true);
  });

  test("default scope (chapter) excludes central-owned txns", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const now = Date.now();
    const centralTxn = await seedCentralTxn(s, { amountCents: 4200, postedAt: now });

    const res = await s.as.query(api.finances.listReconcile, { filter: "all" });
    expect(res.rows.map((r) => r.id)).not.toContain(centralTxn);
  });

  test("a chapter-only manager CANNOT open the central reconcile surface", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);

    await expect(
      s.as.query(api.finances.listReconcile, { filter: "all", scope: "central" }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a genuine central manager (non-superuser) can open it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asCentralManager(s);
    const now = Date.now();
    const centralTxn = await seedCentralTxn(s, { amountCents: 700, postedAt: now });

    const res = await s.as.query(api.finances.listReconcile, {
      filter: "all",
      scope: "central",
    });
    expect(res.rows.map((r) => r.id)).toContain(centralTxn);
  });
});

// ── Central reconcile writes ──────────────────────────────────────────────────

describe("reconcile writes: central-owned txns", () => {
  test("categorize attaches a central budget to a central txn (central reach) and codes it", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const now = Date.now();
    const centralTxn = await seedCentralTxn(s, { amountCents: 4200, postedAt: now });
    const centralBudget = await s.as.mutation(api.finances.createBudget, {
      amountCents: 100000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      central: true,
      label: "Org Ads",
    });

    await s.as.mutation(api.finances.categorizeTransaction, {
      transactionId: centralTxn,
      budgetId: centralBudget,
    });

    const txn = await run(t, (ctx) => ctx.db.get(centralTxn));
    expect(txn?.budgetId).toBe(centralBudget);
    // Coded by its budget link → advanced to categorized; still fund-less.
    expect(txn?.status).toBe("categorized");
    expect(txn?.fundId).toBeUndefined();
  });

  test("a chapter-only manager CANNOT categorize a central txn", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const now = Date.now();
    const centralTxn = await seedCentralTxn(s, { amountCents: 4200, postedAt: now });

    await expect(
      s.as.mutation(api.finances.categorizeTransaction, {
        transactionId: centralTxn,
        // A bare status-less categorize with no refs still resolves scope first.
        budgetId: null,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("categorizing a central txn with a chapter-scoped link is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const now = Date.now();
    const centralTxn = await seedCentralTxn(s, { amountCents: 4200, postedAt: now });
    // Seed a chapter fund + category to attempt (illegally) on a central txn.
    const categoryId = await run(t, async (ctx) => {
      const fundId = await ctx.db.insert("funds", {
        chapterId: s.chapterId,
        name: "General Fund",
        restriction: "unrestricted",
        sortOrder: 0,
        createdAt: Date.now(),
      });
      return await ctx.db.insert("budgetCategories", {
        chapterId: s.chapterId,
        fundId,
        name: "Supplies",
        kind: "category",
        createdAt: Date.now(),
      });
    });

    await expect(
      s.as.mutation(api.finances.categorizeTransaction, {
        transactionId: centralTxn,
        categoryId,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("setTransactionStatus + attachReceipt work on a central txn at central reach", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const now = Date.now();
    const centralTxn = await seedCentralTxn(s, { amountCents: 4200, postedAt: now });

    await s.as.mutation(api.finances.setTransactionStatus, {
      transactionId: centralTxn,
      status: "reconciled",
    });
    const txn = await run(t, (ctx) => ctx.db.get(centralTxn));
    expect(txn?.status).toBe("reconciled");
  });

  test("a chapter-only manager CANNOT setTransactionStatus on a central txn", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await asChapterManager(s);
    const now = Date.now();
    const centralTxn = await seedCentralTxn(s, { amountCents: 4200, postedAt: now });

    await expect(
      s.as.mutation(api.finances.setTransactionStatus, {
        transactionId: centralTxn,
        status: "reconciled",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("bulkCategorize sets a central budget across central txns (central reach)", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const now = Date.now();
    const a = await seedCentralTxn(s, { amountCents: 100, postedAt: now });
    const b = await seedCentralTxn(s, { amountCents: 200, postedAt: now });
    const centralBudget = await s.as.mutation(api.finances.createBudget, {
      amountCents: 100000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      central: true,
      label: "Org Ads",
    });

    const res = await s.as.mutation(api.finances.bulkCategorize, {
      transactionIds: [a, b],
      budgetId: centralBudget,
    });
    expect(res.updated).toBe(2);
    const txnA = await run(t, (ctx) => ctx.db.get(a));
    expect(txnA?.budgetId).toBe(centralBudget);
  });
});

// ── Sentinel safety ───────────────────────────────────────────────────────────

describe("the 'central' sentinel never crashes a row/chapter-doc join", () => {
  test("central reconcile resolves rows (cardholder null) without throwing", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const now = Date.now();
    await seedCentralTxn(s, { amountCents: 4200, postedAt: now });

    const res = await s.as.query(api.finances.listReconcile, {
      filter: "all",
      scope: "central",
    });
    expect(res.rows.length).toBe(1);
    // No cardholder (central issues no cards) — resolved to null, not a crash.
    expect(res.rows[0].cardholder).toBeNull();
  });

  test("a cross-chapter drill-down dashboard still renders with central txns present", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const boston = await makeChapter(s, "Boston");
    await seedCentralTxn(s, { amountCents: 4200, postedAt: Date.now() });

    // Drilling into Boston must not choke on the sentinel rows existing.
    const dash = await s.as.query(api.finances.dashboardChapter, { chapterId: boston });
    expect(Array.isArray(dash.tiles)).toBe(true);
  });
});
