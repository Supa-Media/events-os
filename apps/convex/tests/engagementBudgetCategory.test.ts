/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";

/**
 * Money-page unification PR1: `engagements.budgetCategoryId` is an optional
 * override an engagement can carry (unset → `VENDOR_DEFAULT_CATEGORY_NAME`
 * applies at read time, a follow-up PR). Covers set / clear (null) /
 * omit-leaves-alone, plus tenancy + active-status validation mirroring
 * `budgetLines.ts#verifyCategory`.
 */

async function seedEngagement(
  setup: ChapterSetup,
): Promise<Id<"engagements">> {
  const { t, chapterId, userId } = setup;
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
    const personId = await ctx.db.insert("people", {
      chapterId,
      name: "Vendor Vic",
      createdAt: now,
    });
    return await ctx.db.insert("engagements", {
      chapterId,
      eventId,
      personId,
      type: "paid",
      status: "confirmed",
      amountUsd: 500,
      paymentStatus: "unpaid",
      createdAt: now,
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
      name: "Professional Services",
      kind: "lineItem",
      isActive: opts.isActive ?? true,
      createdAt: Date.now(),
    });
  });
}

describe("engagements.update budgetCategoryId", () => {
  test("sets the category", async () => {
    const t = newT();
    const setup = await setupChapter(t);
    const engagementId = await seedEngagement(setup);
    const categoryId = await seedCategory(setup);

    await setup.as.mutation(api.engagements.update, {
      engagementId,
      budgetCategoryId: categoryId,
    });

    const eng = await run(t, (ctx) => ctx.db.get(engagementId));
    expect(eng?.budgetCategoryId).toBe(categoryId);
  });

  test("null clears the category back to unset", async () => {
    const t = newT();
    const setup = await setupChapter(t);
    const engagementId = await seedEngagement(setup);
    const categoryId = await seedCategory(setup);

    await setup.as.mutation(api.engagements.update, {
      engagementId,
      budgetCategoryId: categoryId,
    });
    await setup.as.mutation(api.engagements.update, {
      engagementId,
      budgetCategoryId: null,
    });

    const eng = await run(t, (ctx) => ctx.db.get(engagementId));
    expect(eng?.budgetCategoryId).toBeUndefined();
  });

  test("omitting budgetCategoryId leaves the existing value untouched", async () => {
    const t = newT();
    const setup = await setupChapter(t);
    const engagementId = await seedEngagement(setup);
    const categoryId = await seedCategory(setup);

    await setup.as.mutation(api.engagements.update, {
      engagementId,
      budgetCategoryId: categoryId,
    });
    await setup.as.mutation(api.engagements.update, {
      engagementId,
      notes: "Confirmed load-in time",
    });

    const eng = await run(t, (ctx) => ctx.db.get(engagementId));
    expect(eng?.budgetCategoryId).toBe(categoryId);
    expect(eng?.notes).toBe("Confirmed load-in time");
  });

  test("a category from another chapter is rejected", async () => {
    const t = newT();
    const setup = await setupChapter(t);
    const engagementId = await seedEngagement(setup);
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
      setup.as.mutation(api.engagements.update, {
        engagementId,
        budgetCategoryId: foreignCategoryId,
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    const eng = await run(t, (ctx) => ctx.db.get(engagementId));
    expect(eng?.budgetCategoryId).toBeUndefined();
  });

  test("an inactive category is rejected", async () => {
    const t = newT();
    const setup = await setupChapter(t);
    const engagementId = await seedEngagement(setup);
    const inactiveCategoryId = await seedCategory(setup, { isActive: false });

    await expect(
      setup.as.mutation(api.engagements.update, {
        engagementId,
        budgetCategoryId: inactiveCategoryId,
      }),
    ).rejects.toBeInstanceOf(ConvexError);

    const eng = await run(t, (ctx) => ctx.db.get(engagementId));
    expect(eng?.budgetCategoryId).toBeUndefined();
  });
});
