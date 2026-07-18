import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Gift sources cutover (docs/plans/giving-territories.md — territories P4).
 *
 * The `gifts.method` union merged into one "source" field and widened to add
 * `zelle | venmo | givebutter | other`. `imported` was DEPRECATED LEGACY —
 * this relabels every remaining `imported` gift onto the new vocabulary:
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
 *
 * Territories Deploy B dropped `"imported"` from `GIFT_METHODS` (this migration
 * already ran in prod, so it never needs to match that literal again live), so
 * `gift.method` is read as a plain `string` below rather than the (now
 * narrower) schema union — same reasoning as the undeclared-table `any` reads
 * elsewhere in this registry (e.g. `0017_purge_guest_allowlist.ts`), just for a
 * since-narrowed field instead of a since-dropped table.
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
      // `"imported"` no longer types as a `gifts.method` literal (dropped from
      // `GIFT_METHODS` in Territories Deploy B) — cast to `string` for the
      // comparison so this ledgered migration still compiles.
      if ((gift.method as string) !== "imported") continue;

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
