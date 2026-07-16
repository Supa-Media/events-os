/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup, type TestConvex } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Budget line items (WP-3.1) — the PLAN step's breakdown. Covers CRUD +
 * reorder, scope-aware authz (chapter bookkeeper+ on own budgets, central
 * reach + bookkeeper+ on central budgets, viewer FORBIDDEN on writes, member
 * FORBIDDEN, cross-scope FORBIDDEN), integer-cents validation, the
 * plan-vs-allocation summary math, and the `deleteBudget` cascade (the one
 * flagged finances.ts touch).
 *
 * Every multi-caller test shares ONE `t` (one underlying convex-test
 * database) across callers — a second `newT()` is a SEPARATE database, so a
 * doc id minted in one is meaningless (and reads back `null`) in the other.
 * Second callers are added via a direct `users`/`userChapters` insert +
 * `t.withIdentity(...)` (the pattern used across the finance test suite),
 * either in the SAME chapter (role-gate tests) or via a second
 * `setupChapter(t, ...)` call on the shared `t` (a genuinely different
 * chapter, for cross-tenancy tests).
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

async function grantChapterRole(
  s: ChapterSetup,
  role: "viewer" | "bookkeeper" | "manager",
): Promise<Id<"people">> {
  const personId = await seedSelfPerson(s);
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
  return personId;
}

/** A chapter budget owned by the caller's own chapter, created as a manager. */
async function makeChapterBudget(s: ChapterSetup, amountCents = 100000): Promise<Id<"budgets">> {
  await grantChapterRole(s, "manager");
  return await s.as.mutation(api.finances.createBudget, {
    amountCents,
    type: "recurring",
    cadence: "yearly",
    year: 2026,
    label: "Ops",
  });
}

/** A second caller in the SAME chapter as `s` — no finance role, no `people` row. */
async function addPlainMember(
  t: TestConvex,
  chapterId: Id<"chapters">,
  email: string,
): Promise<ReturnType<TestConvex["withIdentity"]>> {
  const userId = await run(t, (ctx) => ctx.db.insert("users", { email }));
  await run(t, (ctx) =>
    ctx.db.insert("userChapters", {
      userId,
      chapterId,
      role: "member",
      isActive: true,
      joinedAt: Date.now(),
    }),
  );
  return t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
}

/** A second caller in the SAME chapter as `s`, granted a finance role. */
async function addChapterCallerWithRole(
  t: TestConvex,
  chapterId: Id<"chapters">,
  email: string,
  role: "viewer" | "bookkeeper" | "manager",
): Promise<ReturnType<TestConvex["withIdentity"]>> {
  const userId = await run(t, (ctx) => ctx.db.insert("users", { email }));
  await run(t, (ctx) =>
    ctx.db.insert("userChapters", {
      userId,
      chapterId,
      role: "member",
      isActive: true,
      joinedAt: Date.now(),
    }),
  );
  const personId = await run(t, (ctx) =>
    ctx.db.insert("people", {
      chapterId,
      name: "Second Caller",
      userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  await run(t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId,
      personId,
      role,
      scope: "chapter",
      createdAt: Date.now(),
    }),
  );
  return t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
}

/** A second caller (any chapter) granted a CENTRAL finance role. */
async function addCentralCallerWithRole(
  t: TestConvex,
  chapterId: Id<"chapters">,
  email: string,
  role: "viewer" | "bookkeeper" | "manager",
): Promise<ReturnType<TestConvex["withIdentity"]>> {
  const userId = await run(t, (ctx) => ctx.db.insert("users", { email }));
  await run(t, (ctx) =>
    ctx.db.insert("userChapters", {
      userId,
      chapterId,
      role: "member",
      isActive: true,
      joinedAt: Date.now(),
    }),
  );
  const personId = await run(t, (ctx) =>
    ctx.db.insert("people", {
      chapterId,
      name: "Central Caller",
      userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  await run(t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId,
      personId,
      role,
      scope: "central",
      createdAt: Date.now(),
    }),
  );
  return t.withIdentity({ subject: `${userId}|session`, issuer: "test" });
}

describe("addLine: authz + validation", () => {
  test("a chapter bookkeeper adds a line to their own chapter's budget", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const budgetId = await makeChapterBudget(s);
    // Re-grant as bookkeeper (manager grant above already covers bookkeeper+
    // rank, so this just confirms bookkeeper specifically is sufficient).
    await grantChapterRole(s, "bookkeeper");
    const lineId = await s.as.mutation(api.budgetLines.addLine, {
      budgetId,
      description: "PA rental",
      plannedCents: 20000,
    });
    const doc = await run(s.t, (ctx) => ctx.db.get(lineId));
    expect(doc?.description).toBe("PA rental");
    expect(doc?.plannedCents).toBe(20000);
    expect(doc?.sortOrder).toBe(0);
  });

  test("a chapter VIEWER is FORBIDDEN from adding a line (even on their own budget)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const budgetId = await makeChapterBudget(s);
    const asViewer = await addChapterCallerWithRole(t, s.chapterId, "viewer@publicworship.life", "viewer");
    await expect(
      asViewer.mutation(api.budgetLines.addLine, {
        budgetId,
        description: "Flyers",
        plannedCents: 5000,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a plain roster member with NO finance role is FORBIDDEN", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const budgetId = await makeChapterBudget(s);
    const asMember = await addPlainMember(t, s.chapterId, "member@publicworship.life");
    await expect(
      asMember.mutation(api.budgetLines.addLine, {
        budgetId,
        description: "Snacks",
        plannedCents: 1000,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("cross-scope: a bookkeeper in chapter B is FORBIDDEN (not found) on chapter A's budget", async () => {
    const t = newT();
    const s = await setupChapter(t, { chapterName: "Chapter A" });
    const budgetId = await makeChapterBudget(s);

    const s2 = await setupChapter(t, {
      email: "b-bookkeeper@publicworship.life",
      chapterName: "Chapter B",
    });
    await grantChapterRole(s2, "bookkeeper");
    await expect(
      s2.as.mutation(api.budgetLines.addLine, {
        budgetId, // chapter A's budget — foreign to s2 (chapter B)
        description: "Cross-chapter attempt",
        plannedCents: 1000,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a chapter-only manager is FORBIDDEN on a CENTRAL budget's lines", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const centralBudgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 500000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      central: true,
      label: "City Launch Fund",
    });

    const s2 = await setupChapter(t, { email: "chapter-only@publicworship.life" });
    await grantChapterRole(s2, "manager"); // strong chapter role, but no central reach
    await expect(
      s2.as.mutation(api.budgetLines.addLine, {
        budgetId: centralBudgetId,
        description: "WWS film",
        plannedCents: 20000,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a genuine scope:'central' bookkeeper grant CAN add a line to a central budget", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const centralBudgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 500000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      central: true,
    });

    const s2 = await setupChapter(t, { email: "unrelated@publicworship.life" });
    const asCentralBk = await addCentralCallerWithRole(
      t,
      s2.chapterId,
      "central-bk@publicworship.life",
      "bookkeeper",
    );
    const lineId = await asCentralBk.mutation(api.budgetLines.addLine, {
      budgetId: centralBudgetId,
      description: "Training trip",
      plannedCents: 350000,
    });
    const doc = await run(t, (ctx) => ctx.db.get(lineId));
    expect(doc?.budgetId).toBe(centralBudgetId);
  });

  test("rejects zero, negative, and non-integer plannedCents", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const budgetId = await makeChapterBudget(s);
    for (const bad of [0, -100, 12.5]) {
      await expect(
        s.as.mutation(api.budgetLines.addLine, {
          budgetId,
          description: "Bad amount",
          plannedCents: bad,
        }),
      ).rejects.toBeInstanceOf(ConvexError);
    }
  });

  test("rejects an empty/whitespace-only description", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const budgetId = await makeChapterBudget(s);
    await expect(
      s.as.mutation(api.budgetLines.addLine, {
        budgetId,
        description: "   ",
        plannedCents: 1000,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a category from another chapter is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const budgetId = await makeChapterBudget(s);
    const foreignCategoryId = await run(t, async (ctx) => {
      const other = await ctx.db.insert("chapters", {
        name: "Boston",
        isActive: true,
        createdAt: Date.now(),
      });
      const fundId = await ctx.db.insert("funds", {
        chapterId: other,
        name: "General",
        restriction: "unrestricted",
        sortOrder: 0,
        createdAt: Date.now(),
      });
      return ctx.db.insert("budgetCategories", {
        chapterId: other,
        fundId,
        name: "Food",
        kind: "lineItem",
        createdAt: Date.now(),
      });
    });
    await expect(
      s.as.mutation(api.budgetLines.addLine, {
        budgetId,
        description: "Snacks",
        plannedCents: 1000,
        categoryId: foreignCategoryId,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("appended lines get increasing sortOrder", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const budgetId = await makeChapterBudget(s);
    const a = await s.as.mutation(api.budgetLines.addLine, {
      budgetId,
      description: "First",
      plannedCents: 1000,
    });
    const b = await s.as.mutation(api.budgetLines.addLine, {
      budgetId,
      description: "Second",
      plannedCents: 2000,
    });
    const lines = await s.as.query(api.budgetLines.listLines, { budgetId });
    expect(lines.map((l) => l.id)).toEqual([a, b]);
    expect(lines.map((l) => l.sortOrder)).toEqual([0, 1]);
  });
});

describe("updateLine + removeLine", () => {
  test("updates description/category/plannedCents; clears category with null", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const budgetId = await makeChapterBudget(s);
    const fundId = await s.as.mutation(api.finances.createFund, {
      name: "General",
      restriction: "unrestricted",
    });
    const categoryId = await s.as.mutation(api.finances.createCategory, {
      fundId,
      name: "Food",
      kind: "lineItem",
    });
    const lineId = await s.as.mutation(api.budgetLines.addLine, {
      budgetId,
      description: "Coffee",
      plannedCents: 1000,
    });
    await s.as.mutation(api.budgetLines.updateLine, {
      lineId,
      patch: { description: "Coffee & snacks", plannedCents: 1500, categoryId },
    });
    let doc = await run(s.t, (ctx) => ctx.db.get(lineId));
    expect(doc?.description).toBe("Coffee & snacks");
    expect(doc?.plannedCents).toBe(1500);
    expect(doc?.categoryId).toBe(categoryId);

    await s.as.mutation(api.budgetLines.updateLine, {
      lineId,
      patch: { categoryId: null },
    });
    doc = await run(s.t, (ctx) => ctx.db.get(lineId));
    expect(doc?.categoryId).toBeUndefined();
  });

  test("rejects a non-positive plannedCents on update", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const budgetId = await makeChapterBudget(s);
    const lineId = await s.as.mutation(api.budgetLines.addLine, {
      budgetId,
      description: "Coffee",
      plannedCents: 1000,
    });
    await expect(
      s.as.mutation(api.budgetLines.updateLine, {
        lineId,
        patch: { plannedCents: 0 },
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("removeLine deletes the row", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const budgetId = await makeChapterBudget(s);
    const lineId = await s.as.mutation(api.budgetLines.addLine, {
      budgetId,
      description: "Coffee",
      plannedCents: 1000,
    });
    await s.as.mutation(api.budgetLines.removeLine, { lineId });
    expect(await run(s.t, (ctx) => ctx.db.get(lineId))).toBeNull();
  });

  test("a chapter-only bookkeeper cannot update/remove a line on a foreign chapter's budget", async () => {
    const t = newT();
    const s = await setupChapter(t, { chapterName: "Chapter A" });
    const budgetId = await makeChapterBudget(s);
    const lineId = await s.as.mutation(api.budgetLines.addLine, {
      budgetId,
      description: "Coffee",
      plannedCents: 1000,
    });

    const s2 = await setupChapter(t, {
      email: "b-bookkeeper@publicworship.life",
      chapterName: "Chapter B",
    });
    await grantChapterRole(s2, "bookkeeper");
    await expect(
      s2.as.mutation(api.budgetLines.updateLine, {
        lineId,
        patch: { plannedCents: 2000 },
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      s2.as.mutation(api.budgetLines.removeLine, { lineId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("reorderLines", () => {
  test("rewrites sortOrder to match the given order", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const budgetId = await makeChapterBudget(s);
    const a = await s.as.mutation(api.budgetLines.addLine, {
      budgetId,
      description: "A",
      plannedCents: 1000,
    });
    const b = await s.as.mutation(api.budgetLines.addLine, {
      budgetId,
      description: "B",
      plannedCents: 1000,
    });
    const c = await s.as.mutation(api.budgetLines.addLine, {
      budgetId,
      description: "C",
      plannedCents: 1000,
    });
    await s.as.mutation(api.budgetLines.reorderLines, {
      budgetId,
      orderedLineIds: [c, a, b],
    });
    const lines = await s.as.query(api.budgetLines.listLines, { budgetId });
    expect(lines.map((l) => l.id)).toEqual([c, a, b]);
    expect(lines.map((l) => l.sortOrder)).toEqual([0, 1, 2]);
  });

  test("rejects a set that doesn't exactly match the budget's current lines", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const budgetId = await makeChapterBudget(s);
    const a = await s.as.mutation(api.budgetLines.addLine, {
      budgetId,
      description: "A",
      plannedCents: 1000,
    });
    await s.as.mutation(api.budgetLines.addLine, {
      budgetId,
      description: "B",
      plannedCents: 1000,
    });
    // Missing "B" — incomplete set.
    await expect(
      s.as.mutation(api.budgetLines.reorderLines, {
        budgetId,
        orderedLineIds: [a],
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    // A foreign line id (belonging to a DIFFERENT budget) smuggled in.
    const otherBudgetId = await run(t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: s.chapterId,
        amountCents: 1000,
        type: "recurring",
        cadence: "yearly",
        year: 2026,
        createdAt: Date.now(),
      }),
    );
    const foreign = await run(t, (ctx) =>
      ctx.db.insert("budgetLines", {
        budgetId: otherBudgetId,
        description: "Foreign",
        plannedCents: 500,
        sortOrder: 0,
        createdBy: s.userId,
        createdAt: Date.now(),
      }),
    );
    await expect(
      s.as.mutation(api.budgetLines.reorderLines, {
        budgetId,
        orderedLineIds: [a, foreign],
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("budgetPlanSummary: plan-vs-allocation math", () => {
  test("sums lines against the budget's amountCents, flags over-planned", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const budgetId = await makeChapterBudget(s, 100000); // $1,000.00

    let summary = await s.as.query(api.budgetLines.budgetPlanSummary, { budgetId });
    expect(summary).toEqual({
      budgetId,
      totalCents: 100000,
      plannedCents: 0,
      remainingCents: 100000,
      overPlanned: false,
      lineCount: 0,
    });

    await s.as.mutation(api.budgetLines.addLine, {
      budgetId,
      description: "PA rental",
      plannedCents: 30000,
    });
    await s.as.mutation(api.budgetLines.addLine, {
      budgetId,
      description: "Flyers",
      plannedCents: 20000,
    });
    summary = await s.as.query(api.budgetLines.budgetPlanSummary, { budgetId });
    expect(summary.plannedCents).toBe(50000);
    expect(summary.remainingCents).toBe(50000);
    expect(summary.overPlanned).toBe(false);
    expect(summary.lineCount).toBe(2);

    // Push the plan past the allocation.
    await s.as.mutation(api.budgetLines.addLine, {
      budgetId,
      description: "Overrun",
      plannedCents: 60000,
    });
    summary = await s.as.query(api.budgetLines.budgetPlanSummary, { budgetId });
    expect(summary.plannedCents).toBe(110000);
    expect(summary.remainingCents).toBe(-10000);
    expect(summary.overPlanned).toBe(true);
  });
});

describe("deleteBudget cascades its lines", () => {
  test("deleting a budget also deletes every budgetLines row for it", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const budgetId = await makeChapterBudget(s);
    const lineId1 = await s.as.mutation(api.budgetLines.addLine, {
      budgetId,
      description: "A",
      plannedCents: 1000,
    });
    const lineId2 = await s.as.mutation(api.budgetLines.addLine, {
      budgetId,
      description: "B",
      plannedCents: 2000,
    });

    await s.as.mutation(api.finances.deleteBudget, { budgetId });

    expect(await run(s.t, (ctx) => ctx.db.get(lineId1))).toBeNull();
    expect(await run(s.t, (ctx) => ctx.db.get(lineId2))).toBeNull();
    const remaining = await run(s.t, (ctx) =>
      ctx.db
        .query("budgetLines")
        .withIndex("by_budget", (q) => q.eq("budgetId", budgetId))
        .collect(),
    );
    expect(remaining).toHaveLength(0);
  });
});
