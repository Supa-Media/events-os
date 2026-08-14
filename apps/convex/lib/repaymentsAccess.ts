/**
 * PERSONAL-CHARGE COLLECTIONS authorization — who may chase somebody for money
 * they owe the org.
 *
 * Split out from the finance ladder into its own named power because asking a
 * volunteer for money is a different act from reading a ledger, and the day it
 * needs restricting is the day somebody uses it badly. Per CLAUDE.md's
 * standing rule the resolver exists NOW, while the answer is still just "a
 * finance manager", so that adding the real gate is one file rather than every
 * call site.
 *
 * Two rungs, because they diverge in the obvious direction:
 *
 *  - `requireRepaymentsView` — see who owes what. The collections desk.
 *    Today: the same viewer floor every other manager-facing finance read
 *    uses, so a bookkeeper reconciling a month can see the outstanding column.
 *  - `requireRepaymentsCollect` — ACT on it: send somebody a reminder that
 *    they owe money. Today: finance manager. This is the one that leaves the
 *    building — it puts a message in a volunteer's inbox with their name and
 *    an amount on it — and it is the one most likely to want a tighter gate,
 *    or a per-seat one, later.
 *
 * Graduation names, reserved here so the eventual PR doesn't invent them under
 * pressure: `finance.repayments.view` and `finance.repayments.collect`.
 *
 * Refusals throw `ConvexError({ code, message })` rather than degrading —
 * unlike the budgets-glance resolvers, these guard a manager surface that a
 * member never reaches by accident, so a permission wall is the honest answer
 * and the app's `FinanceBoundary` already renders it.
 */
import { Id } from "../_generated/dataModel";
import { QueryCtx } from "../_generated/server";
import { getFinanceRole, requireFinanceRole } from "./finance";

/**
 * May the caller see the chapter's outstanding personal charges — who owes
 * what, and for which charge?
 *
 * TODAY: viewer rank, the same floor as `personalRepaymentsOutstanding` and
 * every other manager-facing finance read. Graduates to
 * `finance.repayments.view`.
 */
export async function requireRepaymentsView(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<void> {
  await requireFinanceRole(ctx, chapterId, "viewer");
}

/** Non-throwing form, for deciding whether to OFFER an affordance. */
export async function hasRepaymentsCollect(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<boolean> {
  const access = await getFinanceRole(ctx, chapterId);
  return access.isManager || access.isCentral;
}

/**
 * May the caller chase a debt — send the person who owes it a reminder?
 *
 * TODAY: finance manager (or central reach). Deliberately a rung above
 * viewing: a reminder is an outbound message with somebody's name and an
 * amount in it, and "who can read the collections list" and "who can email
 * volunteers about money" are not the same question. Graduates to
 * `finance.repayments.collect`.
 */
export async function requireRepaymentsCollect(
  ctx: QueryCtx,
  chapterId: Id<"chapters">,
): Promise<void> {
  await requireFinanceRole(ctx, chapterId, "manager");
}
