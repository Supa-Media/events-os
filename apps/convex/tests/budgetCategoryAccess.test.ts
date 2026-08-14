/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * The ORG-WIDE category surface (`finances.listCategories` / `createCategory` /
 * `updateCategory`) and the resolver gating it
 * (`lib/budgetCategoryAccess.ts`).
 *
 * Two things this pins, and they are different claims:
 *
 *  1. ONE LIST. A category created while standing in Boston is on New York's
 *     list, and neither `listCategories` nor `myChargeCategories` narrows by
 *     chapter or fund any more. This is the owner's ask stated as a test.
 *  2. THE GATE HAS A NAME. Reading needs a finance viewer; creating, renaming
 *     and retiring need a finance MANAGER — via `require BudgetCategory
 *     View/Manage`, not an inlined seat check. That reach is deliberately
 *     unchanged from the chapter-scoped version (nobody lost a power on the
 *     cutover); what changed is that narrowing it later is a one-file edit.
 *     See the resolver's own doc for the `finance.categories.edit` graduation.
 */

async function grantFinanceRole(
  s: ChapterSetup,
  role: "viewer" | "bookkeeper" | "manager",
  scope: "chapter" | "central" = "chapter",
): Promise<Id<"people">> {
  const personId = await run(s.t, (ctx) =>
    ctx.db.insert("people", {
      chapterId: s.chapterId,
      name: "Caller",
      userId: s.userId,
      isTeamMember: true,
      createdAt: Date.now(),
    }),
  );
  await run(s.t, (ctx) =>
    ctx.db.insert("financeRoles", {
      chapterId: s.chapterId,
      personId,
      role,
      scope,
      createdAt: Date.now(),
    }),
  );
  return personId;
}

describe("listCategories / createCategory: one org-wide list", () => {
  test("a category created from one chapter is on another chapter's list", async () => {
    const t = newT();
    const nyc = await setupChapter(t, { chapterName: "New York" });
    await grantFinanceRole(nyc, "manager");

    const categoryId = await nyc.as.mutation(api.finances.createCategory, {
      name: "Software & Subscriptions",
      kind: "category",
    });

    // A DIFFERENT chapter, a different person, their own finance grant.
    const boston = await setupChapter(t, {
      chapterName: "Boston",
      email: "boston@publicworship.life",
    });
    await grantFinanceRole(boston, "viewer");

    const list = await boston.as.query(api.finances.listCategories, {});
    expect(list.map((c) => c.id)).toContain(categoryId);
    expect(list.find((c) => c.id === categoryId)?.name).toBe(
      "Software & Subscriptions",
    );
  });

  test("the row it writes carries no chapter and no fund", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantFinanceRole(s, "manager");

    const categoryId = await s.as.mutation(api.finances.createCategory, {
      name: "Supplies",
      kind: "category",
    });

    const row = await run(t, (ctx) => ctx.db.get(categoryId));
    expect(row?.chapterId).toBeUndefined();
    expect(row?.fundId).toBeUndefined();
  });

  test("myChargeCategories (member-visible) serves the same org list", async () => {
    const t = newT();
    const nyc = await setupChapter(t);
    await grantFinanceRole(nyc, "manager");
    const categoryId = await nyc.as.mutation(api.finances.createCategory, {
      name: "Transportation",
      kind: "category",
    });

    // A plain member of ANOTHER chapter — no finance grant at all.
    const boston = await setupChapter(t, {
      chapterName: "Boston",
      email: "member@publicworship.life",
    });
    const cats = await boston.as.query(api.finances.myChargeCategories, {});
    expect(cats.map((c) => c.id)).toContain(categoryId);
  });
});

describe("the nesting survives the cutover", () => {
  test("a parent/child pair is accepted with no fund to agree on", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantFinanceRole(s, "manager");

    const parent = await s.as.mutation(api.finances.createCategory, {
      name: "Travel & Lodging",
      kind: "category",
    });
    const child = await s.as.mutation(api.finances.createCategory, {
      name: "Airfare",
      kind: "lineItem",
      parentCategoryId: parent,
    });

    const list = await s.as.query(api.finances.listCategories, {});
    expect(list.find((c) => c.id === child)?.parentCategoryId).toBe(parent);
  });

  test("a cycle is still refused", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantFinanceRole(s, "manager");

    const parent = await s.as.mutation(api.finances.createCategory, {
      name: "Travel & Lodging",
      kind: "category",
    });
    const child = await s.as.mutation(api.finances.createCategory, {
      name: "Airfare",
      kind: "lineItem",
      parentCategoryId: parent,
    });

    await expect(
      s.as.mutation(api.finances.updateCategory, {
        categoryId: parent,
        patch: { parentCategoryId: child },
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a category still can't be its own parent", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantFinanceRole(s, "manager");
    const categoryId = await s.as.mutation(api.finances.createCategory, {
      name: "Supplies",
      kind: "category",
    });

    await expect(
      s.as.mutation(api.finances.updateCategory, {
        categoryId,
        patch: { parentCategoryId: categoryId },
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a parent that doesn't exist is refused", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantFinanceRole(s, "manager");
    const gone = await run(t, (ctx) =>
      ctx.db.insert("budgetCategories", {
        name: "Gone",
        kind: "category",
        createdAt: Date.now(),
      }),
    );
    await run(t, (ctx) => ctx.db.delete(gone));

    await expect(
      s.as.mutation(api.finances.createCategory, {
        name: "Orphan",
        kind: "category",
        parentCategoryId: gone,
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe("the gate (lib/budgetCategoryAccess.ts)", () => {
  test("a finance VIEWER can read the list but cannot create", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantFinanceRole(s, "viewer");

    await expect(s.as.query(api.finances.listCategories, {})).resolves.toEqual([]);
    await expect(
      s.as.mutation(api.finances.createCategory, {
        name: "Supplies",
        kind: "category",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a BOOKKEEPER cannot create or update — managing the org's vocabulary is the manager rung", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantFinanceRole(s, "bookkeeper");

    await expect(
      s.as.mutation(api.finances.createCategory, {
        name: "Supplies",
        kind: "category",
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    const seeded = await run(t, (ctx) =>
      ctx.db.insert("budgetCategories", {
        name: "Supplies",
        kind: "category",
        createdAt: Date.now(),
      }),
    );
    await expect(
      s.as.mutation(api.finances.updateCategory, {
        categoryId: seeded,
        patch: { name: "Renamed" },
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("someone with NO finance grant is refused both the read and the write", async () => {
    const t = newT();
    const s = await setupChapter(t);

    await expect(s.as.query(api.finances.listCategories, {})).rejects.toBeInstanceOf(
      ConvexError,
    );
    await expect(
      s.as.mutation(api.finances.createCategory, {
        name: "Supplies",
        kind: "category",
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });

  test("a CENTRAL manager may manage the list too (their grant reaches every scope)", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await grantFinanceRole(s, "manager", "central");

    const categoryId = await s.as.mutation(api.finances.createCategory, {
      name: "Facilities & Rent",
      kind: "category",
    });
    await s.as.mutation(api.finances.updateCategory, {
      categoryId,
      patch: { isActive: false },
    });

    expect((await run(t, (ctx) => ctx.db.get(categoryId)))?.isActive).toBe(false);
  });
});
