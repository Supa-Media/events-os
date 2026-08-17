import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { INTEREST_SOURCE_CATEGORY } from "@events-os/shared";

/**
 * Stamp `sourceCategory: "interest_payment"` on the Increase interest rows
 * ingested before the field existed — the interest half of what migration 0066
 * did for cashback.
 *
 * WHY. `autoExplainedKind` already treats interest exactly like cashback
 * ("nobody chose it, there is nothing to code"), and both key off
 * `sourceCategory`. But 0066 stamped only the cashback description prefix, so
 * historical INTEREST rows kept an absent `sourceCategory` and stayed
 * un-auto-explained. That left them looking like money nobody had accounted
 * for: the 2026-07 interest payment ($0.85) sat in the reconciliation panel's
 * "credits that look like giving but are recorded as nothing" lead alongside
 * two cashback rows, telling the owner to go confirm bank interest as a
 * donation. The read-path fix (this PR: `isCandidateShaped` consults
 * `autoExplainedKind`) removes the cashback rows immediately, because those
 * carry the marker; only a stamp can reach the interest ones.
 *
 * WHAT. Every `source:"increase_ach"` transaction with no `sourceCategory`
 * whose provider `description` starts with Increase's fixed interest string
 * ("Interest payment") gets `sourceCategory: "interest_payment"`.
 *
 * The description-prefix match is an INFERENCE, and — exactly as 0066 argued —
 * it therefore lives only HERE: one migration, run once, its whole scope
 * reviewable in this file, never in a read path. Going forward the marker is
 * written at ingestion from Increase's own `source.category`.
 *
 * BOUNDS. Scoped through `by_external_id` to Increase transaction ids
 * (`"transaction_…"`), so the genesis/CSV history is never scanned. Capped at
 * `SCAN_LIMIT`, and the result reports whether the cap bit.
 *
 * IDEMPOTENT: a stamped row has `sourceCategory` set and never matches again.
 */
const SCAN_LIMIT = 5000;
const INTEREST_DESCRIPTION_PREFIX = "Interest payment";

export type StampInterestSourceCategoryResult = {
  scanned: number;
  stamped: number;
  /** The scan cap bit — rows past it were not examined; re-run to continue. */
  truncated: boolean;
};

export async function runStampInterestSourceCategory(
  ctx: MutationCtx,
): Promise<StampInterestSourceCategoryResult> {
  const rows = await ctx.db
    .query("transactions")
    .withIndex("by_external_id", (q) =>
      q.gte("externalId", "transaction_").lt("externalId", "transaction`"),
    )
    .take(SCAN_LIMIT);

  const result: StampInterestSourceCategoryResult = {
    scanned: rows.length,
    stamped: 0,
    truncated: rows.length === SCAN_LIMIT,
  };

  for (const tr of rows) {
    if (tr.source !== "increase_ach") continue;
    if (tr.sourceCategory != null) continue;
    if (!tr.description?.startsWith(INTEREST_DESCRIPTION_PREFIX)) continue;
    await ctx.db.patch(tr._id, { sourceCategory: INTEREST_SOURCE_CATEGORY });
    result.stamped++;
  }

  return result;
}

export const stampInterestSourceCategory: Migration = {
  name: "0078_stamp_interest_source_category",
  run: runStampInterestSourceCategory,
};
