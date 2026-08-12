/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { newT, run, setupChapter, type ChapterSetup } from "./setup.helpers";
import type { Id } from "../_generated/dataModel";
import { runStampDefaultCategoryExpenseHints } from "../migrations/0065_stamp_default_category_expense_hints";
import { DEFAULT_EXPENSE_CATEGORY_HINTS } from "../lib/seed/finance";

/**
 * `0065_stamp_default_category_expense_hints` — the one-time backfill that
 * stamps `budgetCategories.expenseType` onto EXISTING chapters' default-named
 * categories by exact name match. See that migration's own module doc for
 * the full argument; this pins the three things a re-run must never get
 * wrong: exact-name-only, additive-only (never overwrites a human's own
 * pick), and idempotence.
 */

async function insertCategory(
  s: ChapterSetup,
  name: string,
  opts: { expenseType?: "general" | "travel" | "meal" | "lodging" } = {},
): Promise<Id<"budgetCategories">> {
  return await run(s.t, async (ctx) => {
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
      name,
      kind: "category",
      sortOrder: 0,
      createdAt: Date.now(),
      ...(opts.expenseType ? { expenseType: opts.expenseType } : {}),
    });
  });
}

describe("0065_stamp_default_category_expense_hints", () => {
  test("stamps EXACT-NAME-MATCH default categories that have no hint yet", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const meals = await insertCategory(s, "Food & Meals");
    const transport = await insertCategory(s, "Transportation");
    const travelLodging = await insertCategory(s, "Travel & Lodging");
    // A hint-less DEFAULT category with no mapping (never gets one) —
    // "Supplies" is in DEFAULT_EXPENSE_CATEGORIES but not in the hints table.
    const supplies = await insertCategory(s, "Supplies");

    const result = await run(s.t, (ctx) => runStampDefaultCategoryExpenseHints(ctx));
    expect(result.patched).toBe(3);
    expect(result.skippedNoDefaultMatch).toBeGreaterThanOrEqual(1); // Supplies

    const get = (id: Id<"budgetCategories">) => run(s.t, (ctx) => ctx.db.get(id));
    expect((await get(meals))?.expenseType).toBe(
      DEFAULT_EXPENSE_CATEGORY_HINTS["Food & Meals"],
    );
    expect((await get(transport))?.expenseType).toBe(
      DEFAULT_EXPENSE_CATEGORY_HINTS["Transportation"],
    );
    // Travel & Lodging hints "travel", NOT "lodging" — an overnight stay is
    // one chip-tap away, but most Travel & Lodging spend is the travel leg.
    expect((await get(travelLodging))?.expenseType).toBe("travel");
    expect((await get(supplies))?.expenseType).toBeUndefined();
  });

  test("a RENAMED default category (no longer an exact match) is left alone", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const renamed = await insertCategory(s, "Meals & Hospitality");

    await run(s.t, (ctx) => runStampDefaultCategoryExpenseHints(ctx));

    const row = await run(s.t, (ctx) => ctx.db.get(renamed));
    expect(row?.expenseType).toBeUndefined();
  });

  test("a CUSTOM category (never in the defaults list) is never touched", async () => {
    const t = newT();
    const s = await setupChapter(t);
    const custom = await insertCategory(s, "Studio Time");

    const result = await run(s.t, (ctx) => runStampDefaultCategoryExpenseHints(ctx));
    expect(result.patched).toBe(0);

    const row = await run(s.t, (ctx) => ctx.db.get(custom));
    expect(row?.expenseType).toBeUndefined();
  });

  test("ADDITIVE-ONLY: a category a chapter already retargeted by hand keeps its own hint", async () => {
    const t = newT();
    const s = await setupChapter(t);
    // A chapter that manually set "Food & Meals" to "general" (e.g. a
    // catch-all supplies budget) BEFORE this migration ran — their own pick
    // must never be overwritten back to the default.
    const meals = await insertCategory(s, "Food & Meals", { expenseType: "general" });

    const result = await run(s.t, (ctx) => runStampDefaultCategoryExpenseHints(ctx));
    expect(result.patched).toBe(0);
    expect(result.skippedAlreadyHinted).toBeGreaterThanOrEqual(1);

    const row = await run(s.t, (ctx) => ctx.db.get(meals));
    expect(row?.expenseType).toBe("general");
  });

  test("IDEMPOTENT: a second run patches nothing further", async () => {
    const t = newT();
    const s = await setupChapter(t);
    await insertCategory(s, "Food & Meals");
    await insertCategory(s, "Transportation");

    const first = await run(s.t, (ctx) => runStampDefaultCategoryExpenseHints(ctx));
    expect(first.patched).toBe(2);

    const second = await run(s.t, (ctx) => runStampDefaultCategoryExpenseHints(ctx));
    expect(second.patched).toBe(0);
    expect(second.skippedAlreadyHinted).toBeGreaterThanOrEqual(2);
  });

  test("CHAPTER-BLIND but still exact-name-per-row: two chapters' own rows both stamp", async () => {
    const t = newT();
    const s1 = await setupChapter(t, { email: "one@publicworship.life" });
    const otherChapterId = await run(t, (ctx) =>
      ctx.db.insert("chapters", { name: "Other", isActive: true, createdAt: Date.now() }),
    );
    const fundId = await run(t, (ctx) =>
      ctx.db.insert("funds", {
        chapterId: otherChapterId,
        name: "General Fund",
        restriction: "unrestricted",
        sortOrder: 0,
        createdAt: Date.now(),
      }),
    );
    const c1 = await insertCategory(s1, "Transportation");
    const c2 = await run(t, (ctx) =>
      ctx.db.insert("budgetCategories", {
        chapterId: otherChapterId,
        fundId,
        name: "Transportation",
        kind: "category",
        sortOrder: 0,
        createdAt: Date.now(),
      }),
    );

    const result = await run(t, (ctx) => runStampDefaultCategoryExpenseHints(ctx));
    expect(result.patched).toBe(2);
    expect((await run(t, (ctx) => ctx.db.get(c1)))?.expenseType).toBe("travel");
    expect((await run(t, (ctx) => ctx.db.get(c2)))?.expenseType).toBe("travel");
  });
});
