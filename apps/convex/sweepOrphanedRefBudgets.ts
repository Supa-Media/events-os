/**
 * One-time: delete the budgets already stranded by the missing delete-cascade.
 *
 * The cascade that stops this happening again ships in the same change
 * (`finances.ts#releaseBudgetsForDeletedRef`, called by `events.remove` and
 * `projects.remove`). This is the residue it can't reach: budgets whose
 * event/project was deleted BEFORE the cascade existed, which point at an id
 * that resolves to nothing and cannot be deleted from any screen in the app
 * (`finances.deleteBudget` has no caller).
 *
 * Production held four. "Love Thy Neighbor 2026" ($6,000, event-side) was
 * removed by its own one-off on 2026-08-14; the three below are project-side
 * and all have zero linked transactions and zero plan lines:
 *
 *   $0.00    Migrate Existing Reccuring givers to Chapter OS
 *   $500.00  Create sponsorship package for LTN
 *   $0.00    New project · Aug 5, 2026
 *
 * ── FINDS THEM BY DEAD REF, NOT BY ID ───────────────────────────────────────
 * Deliberately a sweep rather than three hard-coded ids. The defect was
 * systemic — every event/project deletion since the budget hooks landed could
 * mint one — so "the budgets whose ref no longer resolves" is the honest
 * description of the set, and an id list written today would silently miss one
 * created tomorrow by a path nobody thought about. The identity assertions a
 * hard-coded one-off would give up are replaced by something stronger: the
 * runner proves the ref is dead by looking it up, rather than asserting a label
 * that a rename could invalidate.
 *
 * ── THE SAME RULE AS THE CASCADE: SPEND IS UNTOUCHABLE ──────────────────────
 * A budget carrying ANY linked transaction is REPORTED and left exactly where
 * it is, never deleted and never unlinked. Same reasoning as the cascade's
 * refusal (see its doc comment) and the same reason it matters: the LTN budget
 * carried a $325 receipted charge until days before it was cleaned up. An
 * orphaned budget with money on it is a question for the owner, not something
 * a sweep gets to answer — the money is still coded somewhere legible, which
 * is strictly better than being silently dropped into Unattributed by an ops
 * script nobody was watching.
 *
 * Also skips a budget carrying `budgetLines` plan rows — planning work is real
 * work, same guard `removeEmptyAutoBudgets` applies.
 *
 * Deletes through the app's own {@link cascadeDeleteBudget} so tag links and
 * plan rows go with it. Bounded + idempotent: a settled re-run deletes nothing.
 *
 * Run on prod (dry run first):
 *   npx convex run --prod sweepOrphanedRefBudgets:sweepOrphanedRefBudgets
 *   npx convex run --prod sweepOrphanedRefBudgets:sweepOrphanedRefBudgets '{"execute":true}'
 *
 * Delete this module once run.
 */
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { ROLLUP_SCAN_LIMIT, budgetDisplayName, cascadeDeleteBudget } from "./finances";
import { formatCents } from "@events-os/shared";

const orphanRow = v.object({
  budgetId: v.id("budgets"),
  name: v.string(),
  refKind: v.string(),
  scopeRefId: v.string(),
  amountCents: v.number(),
  /** Why it was left alone — absent on a row that was (or would be) deleted. */
  keptBecause: v.optional(v.string()),
});

export const sweepOrphanedRefBudgets = internalMutation({
  args: { execute: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    scanned: v.number(),
    deleted: v.array(orphanRow),
    kept: v.array(orphanRow),
  }),
  handler: async (ctx, { execute }) => {
    const write = execute ?? false;
    const budgets = await ctx.db.query("budgets").take(ROLLUP_SCAN_LIMIT);
    const deleted: (typeof orphanRow.type)[] = [];
    const kept: (typeof orphanRow.type)[] = [];
    let scanned = 0;

    for (const budget of budgets) {
      const refKind = budget.refKind;
      const scopeRefId = budget.scopeRefId;
      if ((refKind !== "event" && refKind !== "project") || !scopeRefId) continue;
      scanned++;

      // The definition of the set: the ref no longer resolves. `ctx.db.get`
      // on a stale id returns null rather than throwing — an id from a
      // deleted row keeps its table, so this is a lookup, not a parse.
      const ref = await ctx.db.get(
        scopeRefId as Id<"events"> | Id<"projects">,
      );
      if (ref) continue;

      const row = {
        budgetId: budget._id,
        name: budgetDisplayName(budget),
        refKind,
        scopeRefId,
        amountCents: budget.amountCents,
      };

      const linked = await ctx.db
        .query("transactions")
        .withIndex("by_budget", (q) => q.eq("budgetId", budget._id))
        .take(ROLLUP_SCAN_LIMIT);
      if (linked.length > 0) {
        const total = linked.reduce((sum, tr) => sum + tr.amountCents, 0);
        kept.push({
          ...row,
          keptBecause:
            `${linked.length} transaction(s) totalling ${formatCents(total)} are coded ` +
            `to it — recode them, then delete it, or leave it as their home`,
        });
        continue;
      }

      const planLine = await ctx.db
        .query("budgetLines")
        .withIndex("by_budget", (q) => q.eq("budgetId", budget._id))
        .first();
      if (planLine) {
        kept.push({ ...row, keptBecause: "carries budgetLines planning rows" });
        continue;
      }

      if (write) await cascadeDeleteBudget(ctx, budget._id);
      deleted.push(row);
    }

    console.log(
      `[finances] sweepOrphanedRefBudgets (${write ? "execute" : "dry run"}): scanned ` +
        `${scanned} ref-linked budgets, ${deleted.length} orphaned + empty, ` +
        `${kept.length} orphaned but kept.`,
    );
    return { dryRun: !write, scanned, deleted, kept };
  },
});
