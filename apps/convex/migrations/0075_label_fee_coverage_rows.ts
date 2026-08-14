import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { FEE_COVERAGE_LABEL } from "../cards";

/**
 * Name the fee-coverage rows that were booked before they had a name.
 *
 * `0074` posted two of them into production and they landed in Reconcile as
 * "Unlabeled charge / Uncategorized / For: None" — a $3.35 and a $0.49 row that
 * say nothing about themselves, on a page whose entire purpose is that no line
 * is a mystery. Founder: "will it always read unlabeled charge? cant we label
 * it personal charge fee coverage or something."
 *
 * The sibling change names them at the point they are written. This names the
 * two that already exist, and any other the settle path posted in between.
 *
 * ── IT MOVES NO MONEY, AND THAT IS WHY IT CAN BE THIS SIMPLE ────────────────
 * Every other migration in this wave had to pin an exact row, because getting
 * it wrong meant crediting somebody money they never sent. This one only writes
 * a label and a category onto rows that already exist and are already correct,
 * so it can safely take every row carrying `feeCoverageOrigin` — there is no
 * "wrong row" to hit, and a re-run writes the same two fields to the same
 * values.
 *
 * ONLY FILLS WHAT IS EMPTY. A merchant name a human typed, or a category a
 * bookkeeper chose, outranks anything here — the point is to replace an absence,
 * never a decision.
 */
const FEE_CATEGORY_NAME = "Bank & Fees";

export async function runLabelFeeCoverageRows(
  ctx: MutationCtx,
): Promise<{ labelled: number; categorised: number }> {
  let labelled = 0;
  let categorised = 0;

  const rows = (await ctx.db.query("transactions").collect()).filter(
    (t) => t.feeCoverageOrigin != null,
  );

  // One read per book rather than per row — in practice one book, but the shape
  // is what stops this scaling badly if coverage ever spans chapters.
  const categoryByChapter = new Map<string, string | null>();

  for (const row of rows) {
    const patch: { merchantName?: string; categoryId?: never } = {};
    if (row.merchantName == null) {
      patch.merchantName = FEE_COVERAGE_LABEL;
      labelled += 1;
    }

    let categoryId: string | null = null;
    // Categories went ORG-WIDE on 2026-08-14, so this no longer keys off the
    // row's book at all — there is one list, and a central row can now carry a
    // category exactly like a chapter row. The per-chapter memo below survives
    // as a single-entry cache under a constant key rather than being unwound,
    // so a re-run of this historical migration keeps its shape.
    if (row.categoryId == null) {
      const key = "org";
      if (!categoryByChapter.has(key)) {
        const found = (
          await ctx.db.query("budgetCategories").collect()
        ).find((c) => c.name === FEE_CATEGORY_NAME);
        categoryByChapter.set(key, found ? String(found._id) : null);
      }
      categoryId = categoryByChapter.get(key) ?? null;
      if (categoryId) categorised += 1;
    }

    if (patch.merchantName == null && categoryId == null) continue;
    await ctx.db.patch(row._id, {
      ...(patch.merchantName ? { merchantName: patch.merchantName } : {}),
      ...(categoryId ? { categoryId: categoryId as never } : {}),
    });
  }

  console.log(
    `[0075] labelled ${labelled} fee-coverage row(s), categorised ${categorised}.`,
  );
  return { labelled, categorised };
}

export const labelFeeCoverageRows: Migration = {
  name: "0075_label_fee_coverage_rows",
  run: runLabelFeeCoverageRows,
};
