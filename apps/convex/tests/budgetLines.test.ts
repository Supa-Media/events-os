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

  test("a genuine scope:'central' VIEWER is FORBIDDEN from adding a line to a central budget (write rank enforced, not just reach)", async () => {
    const t = newT();
    const s = await setupChapter(t, { email: "seyi@publicworship.life" });
    const centralBudgetId = await s.as.mutation(api.finances.createBudget, {
      amountCents: 500000,
      type: "recurring",
      cadence: "yearly",
      year: 2026,
      central: true,
    });

    const s2 = await setupChapter(t, { email: "unrelated-viewer@publicworship.life" });
    const asCentralViewer = await addCentralCallerWithRole(
      t,
      s2.chapterId,
      "central-viewer@publicworship.life",
      "viewer",
    );
    await expect(
      asCentralViewer.mutation(api.budgetLines.addLine, {
        budgetId: centralBudgetId,
        description: "Training trip",
        plannedCents: 350000,
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

describe("mergeLineIntoItem: human-confirmed dedup of a duplicate plan line (PR6a)", () => {
  /** An event + a single eventItem on it, direct-inserted (mirrors
   *  `engagementBudgetCategory.test.ts#seedEngagement`) — bypasses the
   *  `items.ts` write path, which is out of scope for this file. */
  async function seedEvent(
    s: ChapterSetup,
  ): Promise<{ eventId: Id<"events">; itemId: Id<"eventItems"> }> {
    const { t, chapterId, userId } = s;
    return await run(t, async (ctx) => {
      const now = Date.now();
      const eventTypeId = await ctx.db.insert("eventTypes", {
        chapterId,
        name: "T",
        slug: "t",
        version: 1,
        isArchived: false,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });
      const eventId = await ctx.db.insert("events", {
        chapterId,
        eventTypeId,
        templateVersion: 1,
        name: "Gala",
        eventDate: now,
        status: "planning",
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });
      const itemId = await ctx.db.insert("eventItems", {
        eventId,
        chapterId,
        module: "supplies",
        title: "Sound tech deposit",
        order: 0,
      });
      return { eventId, itemId };
    });
  }

  async function seedCategory(s: ChapterSetup): Promise<Id<"budgetCategories">> {
    return await run(s.t, async (ctx) => {
      const fundId = await ctx.db.insert("funds", {
        chapterId: s.chapterId,
        name: "General",
        restriction: "unrestricted",
        sortOrder: 0,
        createdAt: Date.now(),
      });
      return await ctx.db.insert("budgetCategories", {
        chapterId: s.chapterId,
        fundId,
        name: "AV",
        kind: "lineItem",
        createdAt: Date.now(),
      });
    });
  }

  /** A one_time EVENT budget scoped to `eventId`, created as a manager (the
   *  `createBudget` gate) — mirrors `makeChapterBudget` but with the
   *  refKind/scopeRefId a real event-linked budget carries. */
  async function makeEventBudget(
    s: ChapterSetup,
    eventId: Id<"events">,
    amountCents = 100000,
  ): Promise<Id<"budgets">> {
    await grantChapterRole(s, "manager");
    return await s.as.mutation(api.finances.createBudget, {
      amountCents,
      type: "one_time",
      refKind: "event",
      scopeRefId: eventId,
      cadence: "yearly",
      year: 2026,
    });
  }

  async function addLineToBudget(
    s: ChapterSetup,
    budgetId: Id<"budgets">,
    opts: { description?: string; plannedCents?: number; categoryId?: Id<"budgetCategories"> } = {},
  ): Promise<Id<"budgetLines">> {
    // addLine requires bookkeeper+; the manager grant from makeEventBudget
    // already covers that rank.
    return await s.as.mutation(api.budgetLines.addLine, {
      budgetId,
      description: opts.description ?? "Sound tech deposit",
      plannedCents: opts.plannedCents ?? 20000,
      categoryId: opts.categoryId,
    });
  }

  test("happy merge: line deleted, category copied when item had none", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, itemId } = await seedEvent(s);
    const budgetId = await makeEventBudget(s, eventId);
    const categoryId = await seedCategory(s);
    const lineId = await addLineToBudget(s, budgetId, { categoryId });

    await s.as.mutation(api.budgetLines.mergeLineIntoItem, { lineId, itemId });

    expect(await run(t, (ctx) => ctx.db.get(lineId))).toBeNull();
    const item = await run(t, (ctx) => ctx.db.get(itemId));
    expect(item?.budgetCategoryId).toBe(categoryId);
  });

  test("item already has a category: line's category is NOT copied, line still deleted", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, itemId } = await seedEvent(s);
    const budgetId = await makeEventBudget(s, eventId);
    const existingCategoryId = await seedCategory(s);
    await run(t, (ctx) => ctx.db.patch(itemId, { budgetCategoryId: existingCategoryId }));
    const lineCategoryId = await seedCategory(s);
    const lineId = await addLineToBudget(s, budgetId, { categoryId: lineCategoryId });

    await s.as.mutation(api.budgetLines.mergeLineIntoItem, { lineId, itemId });

    expect(await run(t, (ctx) => ctx.db.get(lineId))).toBeNull();
    const item = await run(t, (ctx) => ctx.db.get(itemId));
    expect(item?.budgetCategoryId).toBe(existingCategoryId);
  });

  test("line with no category: just deleted, item's category (absent) untouched", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, itemId } = await seedEvent(s);
    const budgetId = await makeEventBudget(s, eventId);
    const lineId = await addLineToBudget(s, budgetId);

    await s.as.mutation(api.budgetLines.mergeLineIntoItem, { lineId, itemId });

    expect(await run(t, (ctx) => ctx.db.get(lineId))).toBeNull();
    const item = await run(t, (ctx) => ctx.db.get(itemId));
    expect(item?.budgetCategoryId).toBeUndefined();
  });

  test("cross-event mismatch: a line on a DIFFERENT event's budget is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId: eventA, itemId: itemOnA } = await seedEvent(s);
    const budgetA = await makeEventBudget(s, eventA);
    const lineOnA = await addLineToBudget(s, budgetA);

    // A second event in the same chapter, with its own budget/item.
    const { eventId: eventB } = await seedEvent(s);
    const budgetB = await makeEventBudget(s, eventB);
    const lineOnB = await addLineToBudget(s, budgetB);

    // lineOnB's budget is scoped to eventB, not eventA — merging it into
    // itemOnA (on eventA) must be rejected.
    await expect(
      s.as.mutation(api.budgetLines.mergeLineIntoItem, { lineId: lineOnB, itemId: itemOnA }),
    ).rejects.toBeInstanceOf(ConvexError);

    // Sanity: the matching pair (lineOnA + itemOnA) still works.
    await s.as.mutation(api.budgetLines.mergeLineIntoItem, { lineId: lineOnA, itemId: itemOnA });
    expect(await run(t, (ctx) => ctx.db.get(lineOnA))).toBeNull();
  });

  test("a recurring (non-event-linked) budget's line is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { itemId } = await seedEvent(s);
    const recurringBudgetId = await makeChapterBudget(s);
    const lineId = await addLineToBudget(s, recurringBudgetId);

    await expect(
      s.as.mutation(api.budgetLines.mergeLineIntoItem, { lineId, itemId }),
    ).rejects.toBeInstanceOf(ConvexError);
    // The line survives a rejected merge.
    expect(await run(t, (ctx) => ctx.db.get(lineId))).not.toBeNull();
  });

  test("caller with line access (central bookkeeper) but no event access (foreign home chapter) is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t, { chapterName: "Chapter A" });
    const { eventId, itemId } = await seedEvent(s);
    // A CENTRAL budget scoped to chapter A's event — direct-inserted
    // (bypassing `createBudget`'s own central-creation gate, out of scope
    // for this file) since only the RESULTING budget row's shape matters
    // here.
    const centralBudgetId = await run(t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: "central",
        amountCents: 100000,
        type: "one_time",
        refKind: "event",
        scopeRefId: eventId,
        cadence: "yearly",
        year: 2026,
        createdAt: Date.now(),
      }),
    );

    // A second chapter (B) — the central bookkeeper's HOME chapter. Central
    // reach grants line-write access on ANY central budget regardless of
    // home chapter, but `requireEvent` still gates on the caller's own
    // chapter matching the event's chapter (chapter A) — which chapter B
    // never does.
    const chapterB = await setupChapter(t, { chapterName: "Chapter B" });
    const centralBookkeeper = await addCentralCallerWithRole(
      t,
      chapterB.chapterId,
      "central-bk@publicworship.life",
      "bookkeeper",
    );
    const lineId = await centralBookkeeper.mutation(api.budgetLines.addLine, {
      budgetId: centralBudgetId,
      description: "AV rental",
      plannedCents: 15000,
    });

    await expect(
      centralBookkeeper.mutation(api.budgetLines.mergeLineIntoItem, { lineId, itemId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("caller with event access but no line access (chapter viewer, below bookkeeper) is rejected", async () => {
    const t = newT();
    const s = await setupChapter(t, { chapterName: "Chapter A" });
    const { eventId, itemId } = await seedEvent(s);
    const budgetId = await makeEventBudget(s, eventId);
    const lineId = await addLineToBudget(s, budgetId);

    // A second caller in the SAME chapter (so `requireEvent` passes) with
    // only a VIEWER finance grant (below the bookkeeper+ `requireLineWriteAccess` needs).
    const asViewer = await addChapterCallerWithRole(
      t,
      s.chapterId,
      "viewer@publicworship.life",
      "viewer",
    );
    await expect(
      asViewer.mutation(api.budgetLines.mergeLineIntoItem, { lineId, itemId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("missing line is rejected (NOT_FOUND, per file idiom)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, itemId } = await seedEvent(s);
    const budgetId = await makeEventBudget(s, eventId);
    const lineId = await addLineToBudget(s, budgetId);
    await s.as.mutation(api.budgetLines.removeLine, { lineId });

    await expect(
      s.as.mutation(api.budgetLines.mergeLineIntoItem, { lineId, itemId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("missing item is rejected (NOT_FOUND, per file idiom)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, itemId } = await seedEvent(s);
    const budgetId = await makeEventBudget(s, eventId);
    const lineId = await addLineToBudget(s, budgetId);
    await run(t, (ctx) => ctx.db.delete(itemId));

    await expect(
      s.as.mutation(api.budgetLines.mergeLineIntoItem, { lineId, itemId }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a central-budget line whose category belongs to a DIFFERENT chapter than the event: merge still succeeds (line deleted), category NOT copied", async () => {
    const t = newT();
    const s = await setupChapter(t, { chapterName: "Chapter A" });
    const { eventId, itemId } = await seedEvent(s);

    // The merging caller needs BOTH gates: central line-write reach (any home
    // chapter) AND event-edit access (home chapter === the event's chapter).
    // Grant `s` (home chapter A) a central bookkeeper role alongside their
    // existing chapter role, so the SAME caller clears both sides.
    const personId = await seedSelfPerson(s);
    await run(t, (ctx) =>
      ctx.db.insert("financeRoles", {
        chapterId: s.chapterId,
        personId,
        role: "bookkeeper",
        scope: "central",
        createdAt: Date.now(),
      }),
    );

    const centralBudgetId = await run(t, (ctx) =>
      ctx.db.insert("budgets", {
        chapterId: "central",
        amountCents: 100000,
        type: "one_time",
        refKind: "event",
        scopeRefId: eventId,
        cadence: "yearly",
        year: 2026,
        createdAt: Date.now(),
      }),
    );

    // A category that belongs to a DIFFERENT chapter than the event's — only
    // reachable by direct-inserting the line (addLine's own verifyCategory
    // would reject this category for a chapter-A-homed caller; this exploit
    // shape is what the merge's OWN re-verify must catch, per the bug fix).
    const chapterB = await setupChapter(t, { chapterName: "Chapter B" });
    const foreignCategoryId = await seedCategory(chapterB);
    const lineId = await run(t, (ctx) =>
      ctx.db.insert("budgetLines", {
        budgetId: centralBudgetId,
        description: "AV rental",
        plannedCents: 15000,
        categoryId: foreignCategoryId,
        sortOrder: 0,
        createdBy: s.userId,
        createdAt: Date.now(),
      }),
    );

    await s.as.mutation(api.budgetLines.mergeLineIntoItem, { lineId, itemId });

    expect(await run(t, (ctx) => ctx.db.get(lineId))).toBeNull();
    const item = await run(t, (ctx) => ctx.db.get(itemId));
    expect(item?.budgetCategoryId).toBeUndefined();
  });

  test("a deactivated category on the line: merge still succeeds (line deleted), category NOT copied", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const { eventId, itemId } = await seedEvent(s);
    const budgetId = await makeEventBudget(s, eventId);
    const categoryId = await seedCategory(s);
    const lineId = await addLineToBudget(s, budgetId, { categoryId });

    // The category is retired AFTER the line was created — verifyCategory's
    // active check must still catch it at merge time.
    await run(t, (ctx) => ctx.db.patch(categoryId, { isActive: false }));

    await s.as.mutation(api.budgetLines.mergeLineIntoItem, { lineId, itemId });

    expect(await run(t, (ctx) => ctx.db.get(lineId))).toBeNull();
    const item = await run(t, (ctx) => ctx.db.get(itemId));
    expect(item?.budgetCategoryId).toBeUndefined();
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
