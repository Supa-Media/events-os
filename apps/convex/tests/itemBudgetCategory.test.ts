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
 * plus tenancy + active-status validation mirroring
 * `budgetLines.ts#verifyCategory`.
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

/** Insert a fund + category directly (bypassing the finance-manager gate on
 *  `finances.createCategory`, which is out of scope for this write path). */
async function seedCategory(
  setup: ChapterSetup,
  opts: { chapterId?: Id<"chapters">; isActive?: boolean } = {},
): Promise<Id<"budgetCategories">> {
  const { t } = setup;
  const chapterId = opts.chapterId ?? setup.chapterId;
  return await run(t, async (ctx) => {
    const fundId = await ctx.db.insert("funds", {
      chapterId,
      name: "General",
      restriction: "unrestricted",
      sortOrder: 0,
      createdAt: Date.now(),
    });
    return await ctx.db.insert("budgetCategories", {
      chapterId,
      fundId,
      name: "Supplies",
      kind: "lineItem",
      isActive: opts.isActive ?? true,
      createdAt: Date.now(),
    });
  });
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

  test("a category from another chapter is rejected", async () => {
    const t = newT();
    const setup = await setupChapter(t);
    const itemId = await seedEventItem(setup);
    const otherChapterId = await run(t, (ctx) =>
      ctx.db.insert("chapters", {
        name: "Boston",
        isActive: true,
        createdAt: Date.now(),
      }),
    );
    const foreignCategoryId = await seedCategory(setup, {
      chapterId: otherChapterId,
    });

    await expect(
      setup.as.mutation(api.items.updateEventItem, {
        itemId,
        budgetCategoryId: foreignCategoryId,
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    const item = await run(t, (ctx) => ctx.db.get(itemId));
    expect(item?.budgetCategoryId).toBeUndefined();
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
