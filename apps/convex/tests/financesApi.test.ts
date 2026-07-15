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

    // A monthly bucket budget narrowed to the Food category: $500.00 allocated.
    const budgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 50000,
      scope: "bucket",
      cadence: "monthly",
      year,
      month,
      fundId,
      categoryId,
      label: "Food · March",
    });

    // A real $120.00 outflow coded to Food in March → counts as actual.
    await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 12000,
      postedAt: tsInMonth(year, month),
      fundId,
      categoryId,
    });
    // A $99.99 TRANSFER coded to Food in March → excluded from spend.
    await s.as.mutation(api.finances.createManualTransaction, {
      flow: "transfer",
      amountCents: 9999,
      postedAt: tsInMonth(year, month),
      fundId,
      categoryId,
    });

    const rows = await s.as.query(api.finances.budgetVsActual, { year, month });
    const row = rows.find((r) => r.budgetId === budgetId);
    expect(row).toBeDefined();
    // Estimated (allocated) and Actual are reported separately, never summed.
    expect(row?.allocatedCents).toBe(50000);
    expect(row?.actualCents).toBe(12000); // transfer excluded
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
      scope: "team",
      cadence: "yearly",
      year: 2026,
    });
    let budgets = await s.as.query(api.finances.listBudgets, {});
    expect(budgets.map((b) => b.id)).toContain(budgetId);
    await s.as.mutation(api.finances.deleteBudget, { budgetId });
    budgets = await s.as.query(api.finances.listBudgets, {});
    expect(budgets.map((b) => b.id)).not.toContain(budgetId);
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
      scope: "event",
      cadence: "per_instance",
      year,
      scopeRefId: eventId,
    });

    // $100 real spend on the event, coded to Food.
    await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 10000,
      postedAt: tsInMonth(year, month),
      eventId,
      fundId,
      categoryId,
    });
    // A $50 transfer on the same event → excluded from spend.
    await s.as.mutation(api.finances.createManualTransaction, {
      flow: "transfer",
      amountCents: 5000,
      postedAt: tsInMonth(year, month),
      eventId,
      fundId,
      categoryId,
    });

    const dash = await s.as.query(api.finances.dashboardChapter, { year, month });
    const card = dash.projectBudgets.find((p) => p.id === budgetId);
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
      scope: "bucket",
      cadence: "monthly",
      year,
      month,
      categoryId,
      label: "Software · June",
    });
    await s.as.mutation(api.finances.createManualTransaction, {
      flow: "outflow",
      amountCents: 9000, // 90% → warn
      postedAt: tsInMonth(year, month),
      fundId,
      categoryId,
    });
    const dash = await s.as.query(api.finances.dashboardChapter, { year, month });
    const bucket = dash.recurringBudgets.find((r) => r.id === budgetId);
    expect(bucket?.spentCents).toBe(9000);
    expect(bucket?.pct).toBe(90);
    expect(bucket?.status).toBe("warn");
  });

  test("dashboardCentral: rollups group two chapters + a template", async () => {
    const t = newT();
    // Superuser → implicit central manager.
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const year = 2026;
    const month = 5;
    const when = tsInMonth(year, month);

    // Chapter A: a $70 event spend coded under a template.
    await run(t, async (ctx) => {
      const eventTypeId = await ctx.db.insert("eventTypes", {
        chapterId: s.chapterId,
        name: "Sunday Gathering",
        slug: "sunday",
        version: 1,
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const eventId = await ctx.db.insert("events", {
        chapterId: s.chapterId,
        eventTypeId,
        templateVersion: 1,
        name: "May Gathering",
        eventDate: when,
        status: "planning",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("transactions", {
        chapterId: s.chapterId,
        source: "manual",
        flow: "outflow",
        amountCents: 7000,
        postedAt: when,
        eventId,
        status: "categorized",
        createdAt: Date.now(),
      });
    });

    // Chapter B: a $30 event spend under a template of the SAME name.
    await run(t, async (ctx) => {
      const chapterB = await ctx.db.insert("chapters", {
        name: "Boston",
        isActive: true,
        createdAt: Date.now(),
      });
      const eventTypeId = await ctx.db.insert("eventTypes", {
        chapterId: chapterB,
        name: "Sunday Gathering",
        slug: "sunday",
        version: 1,
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const eventId = await ctx.db.insert("events", {
        chapterId: chapterB,
        eventTypeId,
        templateVersion: 1,
        name: "Boston Gathering",
        eventDate: when,
        status: "planning",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("transactions", {
        chapterId: chapterB,
        source: "manual",
        flow: "outflow",
        amountCents: 3000,
        postedAt: when,
        eventId,
        status: "categorized",
        createdAt: Date.now(),
      });
    });

    const dash = await s.as.query(api.finances.dashboardCentral, { year, month });
    // Two chapters rolled up.
    const names = dash.chapterRollup.map((c) => c.chapterName);
    expect(names).toContain("New York");
    expect(names).toContain("Boston");
    expect(
      dash.chapterRollup.find((c) => c.chapterName === "New York")?.spentCents,
    ).toBe(7000);
    expect(
      dash.chapterRollup.find((c) => c.chapterName === "Boston")?.spentCents,
    ).toBe(3000);
    // One template row aggregating both chapters' spend.
    const tpl = dash.templateRollup.find(
      (x) => x.templateName === "Sunday Gathering",
    );
    expect(tpl?.monthTotalCents).toBe(10000);
    expect(tpl?.perChapter.length).toBe(2);
    // Global month tile.
    expect(dash.tiles[0].label).toContain("all chapters");
  });
});
