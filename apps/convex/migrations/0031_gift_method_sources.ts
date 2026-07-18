import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Gift sources cutover (docs/plans/giving-territories.md — territories P4).
 *
 * The `gifts.method` union merged into one "source" field and widened to add
 * `zelle | venmo | givebutter | other`. `imported` is now DEPRECATED LEGACY —
 * this relabels every remaining `imported` gift onto the new vocabulary so a
 * follow-up PR can drop the literal from the schema (DEPLOY-B(gift-sources)):
 *
 *  - `imported` → `givebutter` when the gift looks Givebutter-sourced: it has an
 *    `externalRef` (the Givebutter txn id, set by the CSV import dedup) OR its
 *    donor's `source === "givebutter-import"`.
 *  - `imported` → `other` otherwise (a manual "other" entry with no better
 *    channel — e.g. the event dual-write's fallback for a non-card/cash method).
 *
 * PURE RELABEL — amounts, scopes, donors, rollups, and the launch pot are ALL
 * untouched (only the `method` label changes), so there is nothing to net out.
 *
 * IDEMPOTENT: after a run no gift has `method: "imported"` left, so a re-run
 * relabels nothing. Bounded by pagination; prod data is near-empty at this stage
 * (same note as 0029/0030), so this completes in one pass.
 */

/** Rows per page — bounded reads over the (small) gifts table. */
const PAGE_SIZE = 500;

export async function runGiftMethodSources(ctx: MutationCtx) {
  const result = { relabeled: 0, toGivebutter: 0, toOther: 0 };
  let cursor: string | null = null;

  for (;;) {
    const page = await ctx.db
      .query("gifts")
      .paginate({ numItems: PAGE_SIZE, cursor });

    for (const gift of page.page) {
      if (gift.method !== "imported") continue;

      let next: "givebutter" | "other" = "other";
      if (gift.externalRef !== undefined) {
        next = "givebutter";
      } else {
        const donor = await ctx.db.get(gift.donorId);
        if (donor?.source === "givebutter-import") next = "givebutter";
      }

      await ctx.db.patch(gift._id, { method: next });
      result.relabeled++;
      if (next === "givebutter") result.toGivebutter++;
      else result.toOther++;
    }

    if (page.isDone) break;
    cursor = page.continueCursor;
  }

  return result;
}

export const giftMethodSources: Migration = {
  name: "0031_gift_method_sources",
  run: runGiftMethodSources,
};
