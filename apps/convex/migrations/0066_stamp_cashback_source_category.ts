import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { CASHBACK_SOURCE_CATEGORY } from "@events-os/shared";

/**
 * Stamp `sourceCategory: "cashback_payment"` on the Increase cashback rows
 * ingested before the field existed.
 *
 * WHY. Increase's `source.category` reached `applyIncreaseAccountTransaction`
 * as a logging-only arg and was thrown away, so the bank's own classification
 * of a cashback payment never landed on the row. The owner hit the result on
 * the Explain worklist (2026-08-13): "we don't really have a way to explain
 * these cashback things… there's literally nothing for me to code there.
 * It's just money back — auto code these ones as well." `autoExplainedKind`
 * now keys the cashback auto-explanation off `sourceCategory` (a positive
 * marker, stored at ingestion from here on), which leaves exactly the
 * already-ingested history unmarked. This is the one-time stamp for it.
 *
 * WHAT. Every `source:"increase_ach"` transaction with no `sourceCategory`
 * whose provider `description` starts with Increase's fixed cashback string
 * ("Cashback payment") gets `sourceCategory: "cashback_payment"`. The
 * description-prefix match is an INFERENCE and therefore lives only HERE —
 * one migration, run once, its scope reviewable in this file — never in the
 * read path (`processorFees.ts`'s feeOrigin rule: a positive marker, not a
 * name match; going forward the marker is written at ingestion).
 *
 * BOUNDS. Scoped by the `by_external_id` index to Increase transaction ids
 * (`"transaction_…"` — every Increase-ingested row's externalId carries the
 * provider's own id prefix), so this never scans the genesis/CSV history at
 * all. Capped at `SCAN_LIMIT`; the result reports if the cap bit (it cannot
 * on this deployment's row counts — the cap is a backstop, not a page size).
 *
 * IDEMPOTENT: a stamped row has `sourceCategory` set and never matches again.
 */
const SCAN_LIMIT = 5000;
const CASHBACK_DESCRIPTION_PREFIX = "Cashback payment";

export type StampCashbackSourceCategoryResult = {
  scanned: number;
  stamped: number;
  /** The scan cap bit — rows past it were not examined; re-run to continue. */
  truncated: boolean;
};

export async function runStampCashbackSourceCategory(
  ctx: MutationCtx,
): Promise<StampCashbackSourceCategoryResult> {
  const rows = await ctx.db
    .query("transactions")
    .withIndex("by_external_id", (q) =>
      // All Increase object ids for transactions start "transaction_" — this
      // range covers exactly the Increase-ingested rows (card AND account
      // lanes) and nothing else.
      q.gte("externalId", "transaction_").lt("externalId", "transaction`"),
    )
    .take(SCAN_LIMIT);

  const result: StampCashbackSourceCategoryResult = {
    scanned: rows.length,
    stamped: 0,
    truncated: rows.length === SCAN_LIMIT,
  };

  for (const tr of rows) {
    if (tr.source !== "increase_ach") continue;
    if (tr.sourceCategory != null) continue;
    if (!tr.description?.startsWith(CASHBACK_DESCRIPTION_PREFIX)) continue;
    await ctx.db.patch(tr._id, { sourceCategory: CASHBACK_SOURCE_CATEGORY });
    result.stamped++;
  }

  return result;
}

export const stampCashbackSourceCategory: Migration = {
  name: "0066_stamp_cashback_source_category",
  run: runStampCashbackSourceCategory,
};
