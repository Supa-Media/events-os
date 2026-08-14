/**
 * WHO OWNS THE ORG'S SPEND TAXONOMY? — the access gate for `budgetCategories`
 * (`finances.ts#listCategories` / `createCategory` / `updateCategory`).
 *
 * Categories went ORG-WIDE on 2026-08-14 (owner: "the category should be the
 * same across all chapters"), and that changed the *shape* of this permission,
 * not just its subject. Renaming "Supplies" used to move one chapter's own
 * label; it now moves the label every chapter in the org codes against, and
 * retiring one takes the option off everybody's picker at once. A power whose
 * blast radius grew from one chapter to the whole org is exactly the kind
 * CLAUDE.md's "gate it behind a power, even when it's open today" rule is
 * about, so it gets a named resolver here instead of a `requireFinanceManager`
 * inlined at each of the three call sites.
 *
 * ── TODAY'S ANSWER ─────────────────────────────────────────────────────────
 * Deliberately UNCHANGED from what the chapter-scoped version allowed: a
 * finance MANAGER (any chapter's treasurer, a central FM, a superuser) may
 * manage the list; a finance VIEWER may read it. Nobody loses a power they had
 * this morning, which is the right default for a change whose point was to
 * merge duplicate labels — not to take the org chart apart. What HAS changed is
 * that the reach is now honestly org-wide, and this file is the one place that
 * says so.
 *
 * ── HOW IT GRADUATES ───────────────────────────────────────────────────────
 * The likely next step is narrowing manage-the-taxonomy to central (the ED/FM
 * curate one list; chapter treasurers code against it). When the org wants
 * that, it is a `finance.categories.edit` string in `SEAT_CAPABILITIES`
 * (`packages/shared/src/powers.ts`): add it, list it on the seats that should
 * carry it, and change `hasBudgetCategoryManage`'s BODY. No call site moves,
 * and the seat chart stays the honest answer to "who can do this?". The string
 * is deliberately NOT added today — `powers.ts` asks for a real need before a
 * new power, and there isn't one yet.
 *
 * ── WHY THESE TAKE A `chapterId` ───────────────────────────────────────────
 * The RESOURCE is org-wide; the CALLER still has a home chapter, and
 * `lib/finance.ts#getFinanceRole` resolves a caller's rank against one (a
 * central grant outranks and applies everywhere). So `chapterId` here means
 * "the chapter the caller is acting from" — never "the chapter this category
 * belongs to", which is now a question with no answer. Same convention as
 * `hasCrossBookAttribution` / `hasAllBooksReconcile` in `lib/finance.ts`, which
 * this file mirrors down to the shape of the pair.
 */
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { hasFinanceRole, requireFinanceRole, type FinanceAccess } from "./finance";

/** May the caller READ the org's category list? */
export async function hasBudgetCategoryView(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<boolean> {
  return hasFinanceRole(ctx, chapterId, "viewer");
}

/** The `require` half of {@link hasBudgetCategoryView} — every call site uses this. */
export async function requireBudgetCategoryView(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<FinanceAccess> {
  return requireFinanceRole(ctx, chapterId, "viewer");
}

/** May the caller CREATE / RENAME / RETIRE an org category? */
export async function hasBudgetCategoryManage(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<boolean> {
  return hasFinanceRole(ctx, chapterId, "manager");
}

/** The `require` half of {@link hasBudgetCategoryManage} — every call site uses this. */
export async function requireBudgetCategoryManage(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<FinanceAccess> {
  const access = await requireFinanceRole(ctx, chapterId, "manager");
  return access;
}

/**
 * Load a category by id, or throw `NOT_FOUND`.
 *
 * This is what replaced `finances.ts#requireInCallerChapter(…, "budgetCategories", …)`
 * at every call site that verified a category link on a write. The chapter
 * comparison it used to make is not "loosened" — it has no referent left: the
 * row it compared against no longer carries a chapter. EXISTENCE is now the
 * whole of the check, which is also why this lives beside the access pair
 * rather than inside `finances.ts`: `budgetLines.ts`, `items.ts`,
 * `engagements.ts` and `reimbursements.ts` each grew their own near-identical
 * `verifyCategory` under the old rule, and they all call this now instead.
 *
 * `label` names the field in the caller's message ("Category", "Parent
 * category") so a nested-category error still reads as one.
 */
export async function requireBudgetCategory(
  ctx: QueryCtx,
  categoryId: Id<"budgetCategories">,
  label = "Category",
): Promise<Doc<"budgetCategories">> {
  const category = await ctx.db.get(categoryId);
  if (!category) {
    throw new ConvexError({ code: "NOT_FOUND", message: `${label} not found.` });
  }
  return category;
}

/**
 * {@link requireBudgetCategory} plus the "and it hasn't been retired" rule the
 * PLAN surfaces need: an item/engagement/reimbursement line shouldn't be able
 * to point at a category somebody took off the list. The coding paths
 * deliberately do NOT use this — a historical charge keeps whatever category it
 * was coded to, even after the label is retired.
 */
export async function requireActiveBudgetCategory(
  ctx: QueryCtx,
  categoryId: Id<"budgetCategories">,
  label = "Category",
): Promise<Doc<"budgetCategories">> {
  const category = await requireBudgetCategory(ctx, categoryId, label);
  if (category.isActive === false) {
    throw new ConvexError({
      code: "INACTIVE_CATEGORY",
      message: "This category is no longer active.",
    });
  }
  return category;
}
