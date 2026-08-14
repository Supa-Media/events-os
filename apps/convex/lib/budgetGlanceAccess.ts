/**
 * BUDGET GLANCE authorization — who may read "budgets at a glance" and, new
 * here, the EXPENSE LINES behind each of those numbers.
 *
 * `finances.budgetsGlance` has always been the one finance read that is
 * deliberately NOT finance-role gated: the FM's own ask was that a cardholder
 * see "spent so far / room left" without having to ask her, so membership is
 * the gate (see that query's doc comment). This file does not change that
 * posture — it NAMES it, and gives the drill-down that ships alongside it the
 * same named door rather than a second inline `getChapterIdOrNull` check
 * copied into every new call site.
 *
 * Two powers, both answering "the whole chapter" TODAY:
 *
 *  - `requireBudgetGlance` — see a budget's cap, spend, and room left.
 *  - `requireBudgetExpenses` — see the individual charges that ADD UP to that
 *    spend (merchant, date, who spent it, whether a receipt is attached).
 *
 * They are separate functions precisely because they are the two rungs most
 * likely to diverge: "everyone can see the number" and "everyone can see whose
 * charges make up the number" are different questions the moment a chapter
 * grows past the roughly-sixteen-volunteer scale this was written for. When
 * that day comes the change is confined to this file — add the string to
 * `POWERS` (`packages/shared/src/powers.ts`, alongside `finance.view` /
 * `finance.budgets.approve`), list it on the seats that should carry it, and
 * swap the body below. Per CLAUDE.md's standing rule, NOTHING checks this
 * inline: every call site uses the `require` form.
 *
 * Graduation names, reserved here so the eventual PR doesn't have to invent
 * them under pressure: `finance.budgets.glance` and `finance.budgets.expenses`.
 *
 * Refusals degrade QUIETLY (a `null` chapter, an empty result) rather than
 * throwing, matching `budgetsGlance`'s own contract — a member with no roster
 * row gets an empty budgets screen, never a permission wall.
 */
import { Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";
import { getChapterIdOrNull } from "./context";

/**
 * May the caller see budget totals, and for which chapter? `null` when they
 * have no roster row to read them through.
 *
 * TODAY: membership is the whole rule — anyone on a chapter's roster sees that
 * chapter's budget caps and spend. Graduates to the `finance.budgets.glance`
 * power (see this file's header) by replacing this body; no call site changes.
 */
export async function hasBudgetGlance(
  ctx: QueryCtx,
): Promise<Id<"chapters"> | null> {
  return (await getChapterIdOrNull(ctx)) as Id<"chapters"> | null;
}

/**
 * The chapter whose budgets the caller may read, or `null`. The `require` form
 * every call site uses; it does not throw (see this file's header on quiet
 * degradation) — a `null` return IS the refusal, and callers return their own
 * empty shape for it.
 */
export async function requireBudgetGlance(
  ctx: QueryCtx,
): Promise<Id<"chapters"> | null> {
  return await hasBudgetGlance(ctx);
}

/**
 * May the caller see the individual CHARGES behind a budget's spend — the
 * drop-down the founder asked for ("we should just be able to drop down and
 * see the different expenses per budget")?
 *
 * TODAY: the same membership rule as the totals. Deliberately its own
 * function anyway (see this file's header): the line list names merchants,
 * dates, and the person who spent, which is a strictly larger disclosure than
 * "this budget is 60% used" and is the rung most likely to be pulled back to
 * a seat. Graduates to `finance.budgets.expenses`.
 */
export async function hasBudgetExpenses(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<boolean> {
  const own = await hasBudgetGlance(ctx);
  return own != null && own === chapterId;
}

/** The `require` form — `false` IS the refusal; callers return an empty list. */
export async function requireBudgetExpenses(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<boolean> {
  return await hasBudgetExpenses(ctx, chapterId);
}
