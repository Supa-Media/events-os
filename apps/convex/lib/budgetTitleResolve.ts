/**
 * TITLING A CHAPTER'S BUDGETS — the Convex half of
 * `@events-os/shared#resolveBudgetTitles`.
 *
 * The rule itself (template name, plus only as much date as it takes to tell
 * two apart) is pure and lives in shared, where it is tested without a
 * database. This file is the part that needs one: resolving each budget's
 * linked event, that event's template name, and its date.
 *
 * ── WHY IT ALWAYS LOADS THE WHOLE CHAPTER ───────────────────────────────────
 * "Is this name ambiguous?" cannot be answered one budget at a time. A page
 * showing a SINGLE budget (`budgetDetail`, the glance drop-down) still has to
 * know whether there are three other Genesis budgets, or it would title one
 * "Genesis" while the list it was opened from calls it "Genesis Oct 2026" —
 * and two names for one budget is worse than a clumsy name. So every caller
 * resolves against the chapter's full budget set, which is a bounded read this
 * codebase already does everywhere else.
 */
import { resolveBudgetTitles, type BudgetTitleInput } from "@events-os/shared";
import { Doc, Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";
import { ROLLUP_SCAN_LIMIT, nameCache, resolveBudgetRef } from "../finances";
import { BLANK_TEMPLATE_SLUG } from "./templates";

/**
 * Display title per budget id, for the budgets given.
 *
 * Pass the whole set a reader will compare against — see the module doc on why
 * a single-budget page must still resolve against its siblings.
 */
export async function resolveTitlesForBudgets(
  ctx: QueryCtx,
  budgets: Doc<"budgets">[],
): Promise<Map<string, string>> {
  const getEvent = nameCache(ctx, "events");
  const getProject = nameCache(ctx, "projects");
  const getEventType = nameCache(ctx, "eventTypes");

  const rows: BudgetTitleInput[] = [];
  for (const b of budgets) {
    const ref = await resolveBudgetRef(b, getEvent, getProject);
    const template = ref.eventTypeId
      ? await getEventType(ref.eventTypeId)
      : null;
    rows.push({
      key: b._id,
      templateName: templateTitleSource(template),
      // `resolveBudgetRef`'s own fallback chain: the live ref's name, else the
      // budget's label, else a generic type word. Never blank.
      fallbackName: ref.name,
      date: ref.refDate,
    });
  }
  return resolveBudgetTitles(rows);
}

/**
 * The template name a budget may be titled after — or `null` when the template
 * has no name worth borrowing.
 *
 * Founder, 2026-08-14, on seeing "Blank event Dec 2025" on the Budgets tab:
 * "when something is a blank event, it's a blank template, starting from
 * scratch, so let's use the event name we have on record."
 *
 * The `isBlank` template is the chapter's synthesized "start from scratch"
 * option (`schema/templates.ts` — one per chapter, zero roles, zero items,
 * hidden from the Templates tab). It exists so `createFromTemplate` has
 * something to clone nothing from; it is not a KIND of event, and titling
 * three unrelated budgets "Blank event" tells a reader strictly less than the
 * names their creators actually typed.
 *
 * Written against the flag rather than the string "Blank event", so it holds
 * if that copy ever changes — and stated as a general rule, because the
 * question this answers is "does this template name mean anything?", not "is
 * it this one specific template?".
 */
function templateTitleSource(
  template: Doc<"eventTypes"> | null,
): string | null {
  if (!template) return null;
  // The slug is checked as well as the flag: the blank template is created
  // lazily per chapter, so a chapter that first used it before `isBlank`
  // existed has a row carrying only the slug. Belt and braces on a title
  // nobody would want.
  if (template.isBlank || template.slug === BLANK_TEMPLATE_SLUG) return null;
  return template.name ?? null;
}

/**
 * One budget's title, resolved against its whole chapter — the single-budget
 * entry point (`budgetDetail`, `budgetGlance.expenses`).
 *
 * Falls back to the budget's own resolved name if it somehow isn't in its
 * chapter's set, so a title is never blank.
 */
export async function resolveTitleForBudget(
  ctx: QueryCtx,
  budget: Doc<"budgets">,
  fallbackName: string,
): Promise<string> {
  const siblings = await ctx.db
    .query("budgets")
    .withIndex("by_chapter_and_period", (q) =>
      q.eq("chapterId", budget.chapterId as Id<"chapters">),
    )
    .take(ROLLUP_SCAN_LIMIT);
  const titles = await resolveTitlesForBudgets(
    ctx,
    siblings.some((s) => s._id === budget._id) ? siblings : [...siblings, budget],
  );
  return titles.get(budget._id) ?? fallbackName;
}
