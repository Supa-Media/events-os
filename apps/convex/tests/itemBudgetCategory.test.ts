/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * Money-page unification PR1: `eventItems.budgetCategoryId` is an optional
 * override an item can carry (unset → the module default mapping applies at
 * read time, a follow-up PR). Covers set / clear (null) / omit-leaves-alone,
 * plus existence + active-status validation mirroring
 * `budgetLines.ts#verifyCategory`.
 *
 * The TENANCY half of that validation is gone (2026-08-14): categories are
 * org-wide, so there is no chapter on the label for an item's chapter to be
 * checked against. Existence and active are what remain.
 */

async function seedEventItem(
  setup: ChapterSetup,
  chapterId: Id<"chapters"> = setup.chapterId,
): Promise<Id<"eventItems">> {
  const { t, userId } = setup;
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
    return await ctx.db.insert("eventItems", {
      eventId,
      chapterId,
      module: "supplies",
      title: "Rent chairs",
      order: 0,
    });
  });
}

/** Insert a category directly (bypassing the finance-manager gate on
 *  `finances.createCategory`, which is out of scope for this write path).
 *  Categories are ORG-WIDE since 2026-08-14 — no chapter, no fund. */
async function seedCategory(
  setup: ChapterSetup,
  opts: { name?: string; isActive?: boolean } = {},
): Promise<Id<"budgetCategories">> {
  const { t } = setup;
  return await run(t, async (ctx) =>
    ctx.db.insert("budgetCategories", {
      name: opts.name ?? "Supplies",
      kind: "lineItem",
      isActive: opts.isActive ?? true,
      createdAt: Date.now(),
    }),
  );
}

describe("updateEventItem budgetCategoryId", () => {
  test("sets the category", async () => {
    const t = newT();
    const setup = await setupChapter(t);
    const itemId = await seedEventItem(setup);
    const categoryId = await seedCategory(setup);

    await setup.as.mutation(api.items.updateEventItem, {
      itemId,
      budgetCategoryId: categoryId,
    });

    const item = await run(t, (ctx) => ctx.db.get(itemId));
    expect(item?.budgetCategoryId).toBe(categoryId);
  });

  test("null clears the category back to unset", async () => {
    const t = newT();
    const setup = await setupChapter(t);
    const itemId = await seedEventItem(setup);
    const categoryId = await seedCategory(setup);

    await setup.as.mutation(api.items.updateEventItem, {
      itemId,
      budgetCategoryId: categoryId,
    });
    await setup.as.mutation(api.items.updateEventItem, {
      itemId,
      budgetCategoryId: null,
    });

    const item = await run(t, (ctx) => ctx.db.get(itemId));
    expect(item?.budgetCategoryId).toBeUndefined();
  });

  test("omitting budgetCategoryId leaves the existing value untouched", async () => {
    const t = newT();
    const setup = await setupChapter(t);
    const itemId = await seedEventItem(setup);
    const categoryId = await seedCategory(setup);

    await setup.as.mutation(api.items.updateEventItem, {
      itemId,
      budgetCategoryId: categoryId,
    });
    await setup.as.mutation(api.items.updateEventItem, {
      itemId,
      title: "Renamed",
    });

    const item = await run(t, (ctx) => ctx.db.get(itemId));
    expect(item?.budgetCategoryId).toBe(categoryId);
    expect(item?.title).toBe("Renamed");
  });

  // Categories went ORG-WIDE on 2026-08-14, so "a category from another
  // chapter" no longer names anything — every category is everyone's. What
  // replaces that rejection is the only category-shaped refusal left here: an
  // id that isn't a category at all (a deleted one) still can't be attached.
  test("a category that no longer exists is rejected", async () => {
    const t = newT();
    const setup = await setupChapter(t);
    const itemId = await seedEventItem(setup);
    const goneCategoryId = await seedCategory(setup, { name: "Deleted" });
    await run(t, (ctx) => ctx.db.delete(goneCategoryId));

    await expect(
      setup.as.mutation(api.items.updateEventItem, {
        itemId,
        budgetCategoryId: goneCategoryId,
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    const item = await run(t, (ctx) => ctx.db.get(itemId));
    expect(item?.budgetCategoryId).toBeUndefined();
  });

  // ...and the org's list really is one list: a category seeded with no
  // chapter attaches to an item on any chapter's event.
  test("an org-wide category attaches to any chapter's item", async () => {
    const t = newT();
    const setup = await setupChapter(t);
    const itemId = await seedEventItem(setup);
    const categoryId = await seedCategory(setup, { name: "Transportation" });

    await setup.as.mutation(api.items.updateEventItem, {
      itemId,
      budgetCategoryId: categoryId,
    });

    const item = await run(t, (ctx) => ctx.db.get(itemId));
    expect(item?.budgetCategoryId).toBe(categoryId);
  });

  test("an inactive category is rejected", async () => {
    const t = newT();
    const setup = await setupChapter(t);
    const itemId = await seedEventItem(setup);
    const inactiveCategoryId = await seedCategory(setup, { isActive: false });

    await expect(
      setup.as.mutation(api.items.updateEventItem, {
        itemId,
        budgetCategoryId: inactiveCategoryId,
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    const item = await run(t, (ctx) => ctx.db.get(itemId));
    expect(item?.budgetCategoryId).toBeUndefined();
  });
});
