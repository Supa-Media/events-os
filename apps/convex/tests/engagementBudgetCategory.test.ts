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
      name: opts.name ?? "Professional Services",
      kind: "lineItem",
      isActive: opts.isActive ?? true,
      createdAt: Date.now(),
    }),
  );
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

  // Was "a category from another chapter is rejected". Categories went ORG-WIDE
  // on 2026-08-14, so a foreign chapter's category is simply the org's
  // category; what a vendor row still can't take is an id with no category
  // behind it.
  test("a category that no longer exists is rejected", async () => {
    const t = newT();
    const setup = await setupChapter(t);
    const engagementId = await seedEngagement(setup);
    const goneCategoryId = await seedCategory(setup, { name: "Deleted" });
    await run(t, (ctx) => ctx.db.delete(goneCategoryId));

    await expect(
      setup.as.mutation(api.engagements.update, {
        engagementId,
        budgetCategoryId: goneCategoryId,
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
