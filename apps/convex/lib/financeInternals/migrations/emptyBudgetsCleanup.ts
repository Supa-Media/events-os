import { ConvexError } from "convex/values";
import { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { cascadeDeleteBudget } from "../budgetCrudHelpers";
import { ROLLUP_SCAN_LIMIT } from "../constants";

/**
 * Ops cleanup (workflow-callable, no-auth internalMutation): delete
 * auto-created one_time budgets (`refKind` "event" OR "project") that are
 * EMPTY — before the owner rule ("budgets only exist when money does")
 * landed, `backfillEventBudgets` (#125) and `backfillProjectBudgets`/
 * `projects.create`'s create-time hook (this PR, pre-fix) both created a
 * zero-amount budget for every budget-less event/project, which is dashboard
 * clutter the owner flagged. This retroactively removes those.
 *
 * A budget is deleted ONLY when ALL of:
 *  - `type === "one_time"` and `refKind` is `"event"` or `"project"` (never
 *    touches a recurring or legacy-scope budget).
 *  - `amountCents === 0` — NEVER deletes a budget with a nonzero amount, even
 *    if it's otherwise unused.
 *  - Zero linked transactions (`transactions.by_budget`) — NEVER deletes a
 *    budget with linked spend; its actuals still need somewhere to roll up.
 *  - For EITHER ref kind: the budget has no WP-3.1 `budgetLines` rows
 *    (`by_budget`) — a $0 budget can still carry a real v2 plan breakdown (the
 *    amount just hasn't been filled in yet), so deleting it would silently
 *    destroy someone's planning work.
 *
 * Deletes via the shared {@link cascadeDeleteBudget} helper (also used by
 * `deleteBudget`) so its `budgetTagLinks` AND any `budgetLines` rows are
 * removed too — no orphan survives the budget. Bounded + idempotent — a
 * settled re-run deletes nothing.
 *
 * Run locally:  npx convex run finances:removeEmptyAutoBudgets
 * Run on prod:  npx convex run --prod finances:removeEmptyAutoBudgets '{"chapterId":"..."}'
 */
export async function runRemoveEmptyAutoBudgets(
  ctx: MutationCtx,
  chapterId: Id<"chapters"> | undefined,
): Promise<{
  scanned: number;
  deleted: number;
  keptWithSpend: number;
  keptNonzero: number;
  keptWithLineItems: number;
}> {
  let scanned = 0;
  let deleted = 0;
  let keptWithSpend = 0;
  let keptNonzero = 0;
  let keptWithLineItems = 0;

  // Guard: a passed chapter must exist (ConvexError, not a silent no-op).
  if (chapterId) {
    const chapter = await ctx.db.get(chapterId);
    if (!chapter) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Chapter not found." });
    }
  }

  const budgets = chapterId
    ? await ctx.db
        .query("budgets")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
        .take(ROLLUP_SCAN_LIMIT)
    : await ctx.db.query("budgets").take(ROLLUP_SCAN_LIMIT);

  for (const b of budgets) {
    if (b.type !== "one_time" || !b.scopeRefId) continue;
    if (b.refKind !== "event" && b.refKind !== "project") continue;
    scanned++;

    if (b.amountCents !== 0) {
      keptNonzero++;
      continue;
    }

    const linkedTxn = await ctx.db
      .query("transactions")
      .withIndex("by_budget", (q) => q.eq("budgetId", b._id))
      .first();
    if (linkedTxn) {
      keptWithSpend++;
      continue;
    }

    // v2 plan guard — covers BOTH event and project refKinds: a $0 budget
    // that already has `budgetLines` planning is real work, not clutter.
    const planLine = await ctx.db
      .query("budgetLines")
      .withIndex("by_budget", (q) => q.eq("budgetId", b._id))
      .first();
    if (planLine) {
      keptWithLineItems++;
      continue;
    }

    await cascadeDeleteBudget(ctx, b._id);
    deleted++;
  }

  console.log(
    `[finances] removeEmptyAutoBudgets: scanned ${scanned}, deleted ${deleted}, ` +
      `kept ${keptWithSpend} (linked spend), ${keptNonzero} (nonzero), ` +
      `${keptWithLineItems} (budget has plan lines).`,
  );

  return { scanned, deleted, keptWithSpend, keptNonzero, keptWithLineItems };
}
