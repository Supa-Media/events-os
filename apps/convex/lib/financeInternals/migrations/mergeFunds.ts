import { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { findGeneralFundId } from "../categoriesAndFunds";
import { ROLLUP_SCAN_LIMIT } from "../constants";

/**
 * Merge every extra fund in ONE chapter into its General Fund (resolved via
 * {@link findGeneralFundId} — by name, else lowest-sortOrder unrestricted,
 * else lowest-sortOrder). Repoints every `fundId`/`defaultFundId` reference
 * (`budgetCategories` — required field, so a dangling extra-fund reference
 * would otherwise break category display; `budgets`; `transactions`;
 * `reimbursementLineItems`; `legacyAccounts.defaultFundId`), then deletes the
 * now-empty extra fund docs.
 *
 * Also fixes a stale `transactions.aiSuggestion.fundId` pointing at the extra
 * fund, via TWO passes: the `by_fund`-indexed transactions scan above repoints
 * a suggestion in the same patch as a coded txn's top-level `fundId`; a
 * second, cached chapter-wide scan (reusing the same pattern as `budgets`/
 * `reimbursementLineItems`) catches an UNCODED txn — top-level `fundId` unset
 * — whose stored suggestion still points at the extra fund, which the
 * `by_fund` index alone would miss. Left uncaught, that dangling suggestion
 * id would survive the fund's deletion below and could later be copied onto
 * the transaction by `acceptSuggestion`.
 *
 * A chapter with 0 or 1 funds is a no-op (nothing to merge) — this is what
 * makes a re-run of the whole migration idempotent.
 */
export async function runMergeFundsIntoGeneralForChapter(
  ctx: MutationCtx,
  chapterId: Id<"chapters">,
): Promise<{
  merged: boolean;
  fundsDeleted: number;
  categoriesRepointed: number;
  budgetsRepointed: number;
  transactionsRepointed: number;
  reimbursementLineItemsRepointed: number;
  legacyAccountsRepointed: number;
}> {
  const zero = {
    merged: false,
    fundsDeleted: 0,
    categoriesRepointed: 0,
    budgetsRepointed: 0,
    transactionsRepointed: 0,
    reimbursementLineItemsRepointed: 0,
    legacyAccountsRepointed: 0,
  };
  const keeperId = await findGeneralFundId(ctx, chapterId);
  if (!keeperId) return zero; // fund-less chapter — nothing to merge

  const funds = await ctx.db
    .query("funds")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(ROLLUP_SCAN_LIMIT);
  const extras = funds.filter((f) => f._id !== keeperId);
  if (extras.length === 0) return zero; // already down to one fund

  let categoriesRepointed = 0;
  let budgetsRepointed = 0;
  let transactionsRepointed = 0;
  let reimbursementLineItemsRepointed = 0;
  let legacyAccountsRepointed = 0;

  // Cache the chapter-wide scans that lack a `by_fund` index — one bounded
  // read per table, reused across every extra fund instead of per-fund.
  const chapterBudgets = await ctx.db
    .query("budgets")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(ROLLUP_SCAN_LIMIT);
  const chapterLines = await ctx.db
    .query("reimbursementLineItems")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(ROLLUP_SCAN_LIMIT);
  const chapterAccounts = await ctx.db
    .query("legacyAccounts")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(ROLLUP_SCAN_LIMIT);
  // Chapter-wide, so it also catches a dangling `aiSuggestion.fundId` on an
  // uncoded txn (top-level `fundId` unset) — see the docstring above.
  const chapterTransactions = await ctx.db
    .query("transactions")
    .withIndex("by_chapter", (q) => q.eq("chapterId", chapterId))
    .take(ROLLUP_SCAN_LIMIT);

  for (const extra of extras) {
    // budgetCategories.fundId is REQUIRED — a dangling reference here would
    // break category display/grouping the instant the fund doc is deleted.
    const categories = await ctx.db
      .query("budgetCategories")
      .withIndex("by_fund", (q) => q.eq("fundId", extra._id))
      .take(ROLLUP_SCAN_LIMIT);
    for (const c of categories) {
      await ctx.db.patch(c._id, { fundId: keeperId });
      categoriesRepointed++;
    }

    for (const b of chapterBudgets) {
      if (b.fundId === extra._id) {
        await ctx.db.patch(b._id, { fundId: keeperId });
        budgetsRepointed++;
      }
    }

    const transactions = await ctx.db
      .query("transactions")
      .withIndex("by_fund", (q) => q.eq("fundId", extra._id))
      .take(ROLLUP_SCAN_LIMIT);
    for (const tr of transactions) {
      await ctx.db.patch(tr._id, {
        fundId: keeperId,
        // Fix a stale AI suggestion on the SAME row while we're already here.
        ...(tr.aiSuggestion?.fundId === extra._id
          ? { aiSuggestion: { ...tr.aiSuggestion, fundId: keeperId } }
          : {}),
      });
      transactionsRepointed++;
    }

    // The `by_fund` scan above only finds txns whose TOP-LEVEL fundId is the
    // extra fund. An uncoded txn (no top-level fundId) whose stored AI
    // suggestion picked the extra fund would otherwise escape — repoint its
    // suggestion too, from the cached chapter-wide scan. Skip rows already
    // handled above (top-level fundId === extra) to avoid a double count.
    for (const tr of chapterTransactions) {
      if (tr.fundId === extra._id) continue;
      if (tr.aiSuggestion?.fundId === extra._id) {
        await ctx.db.patch(tr._id, {
          aiSuggestion: { ...tr.aiSuggestion, fundId: keeperId },
        });
        transactionsRepointed++;
      }
    }

    for (const l of chapterLines) {
      if (l.fundId === extra._id) {
        await ctx.db.patch(l._id, { fundId: keeperId });
        reimbursementLineItemsRepointed++;
      }
    }

    for (const a of chapterAccounts) {
      if (a.defaultFundId === extra._id) {
        await ctx.db.patch(a._id, { defaultFundId: keeperId });
        legacyAccountsRepointed++;
      }
    }

    await ctx.db.delete(extra._id);
  }

  return {
    merged: true,
    fundsDeleted: extras.length,
    categoriesRepointed,
    budgetsRepointed,
    transactionsRepointed,
    reimbursementLineItemsRepointed,
    legacyAccountsRepointed,
  };
}
