import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { DEFAULT_EXPENSE_CATEGORY_HINTS } from "../lib/seed/finance";

/**
 * Stamp the §274(d) proof-question hint (`budgetCategories.expenseType`) onto
 * EXISTING seeded categories — the founder's "why are the coding categories
 * different from the regular categories?" fix. `insertDefaultExpenseCategories`
 * now stamps a hint on every NEWLY-inserted default category
 * (`DEFAULT_EXPENSE_CATEGORY_HINTS`), but every chapter seeded before this
 * shipped already has its "Food & Meals" / "Transportation" / "Travel &
 * Lodging" rows sitting there hint-less — this is the one-time backfill so
 * the coding form's category-driven derivation works for THEM too, not only
 * chapters created from today onward.
 *
 * EXACT NAME MATCH, chapter-blind: `DEFAULT_EXPENSE_CATEGORY_HINTS`'s keys are
 * the literal default category names, and a row only gets stamped when its
 * `name` matches one of them exactly. A category a chapter renamed ("Food &
 * Meals" → "Meals & Hospitality") no longer matches and is left alone —
 * renaming opted it out of the default hint, same as it opts out of every
 * other "default category" behavior. A chapter's own CUSTOM category (never
 * in the defaults list) never matches by construction. No chapter loop is
 * needed: the hint is a pure function of the name, so this scans the whole
 * table once rather than per chapter.
 *
 * ADDITIVE-ONLY + IDEMPOTENT: only patches a row that (a) name-matches a
 * hinted default AND (b) has no `expenseType` yet. A row a chapter has
 * already retargeted or cleared by hand (via the category editor) is never
 * overwritten — this backfill only fills an absence, exactly like
 * `0058_add_data_export_defaults`'s additive-only argument. A re-run touches
 * nothing: every row it would have patched already carries the hint.
 */
const CATEGORY_SCAN_LIMIT = 20000;

export async function runStampDefaultCategoryExpenseHints(ctx: MutationCtx) {
  const result = { patched: 0, skippedAlreadyHinted: 0, skippedNoDefaultMatch: 0 };

  const categories = await ctx.db
    .query("budgetCategories")
    .take(CATEGORY_SCAN_LIMIT);

  for (const category of categories) {
    const hint = DEFAULT_EXPENSE_CATEGORY_HINTS[
      category.name as keyof typeof DEFAULT_EXPENSE_CATEGORY_HINTS
    ];
    if (!hint) {
      result.skippedNoDefaultMatch++;
      continue;
    }
    if (category.expenseType != null) {
      result.skippedAlreadyHinted++;
      continue;
    }
    await ctx.db.patch(category._id, { expenseType: hint });
    result.patched++;
  }

  return result;
}

export const stampDefaultCategoryExpenseHints: Migration = {
  name: "0065_stamp_default_category_expense_hints",
  run: runStampDefaultCategoryExpenseHints,
};
