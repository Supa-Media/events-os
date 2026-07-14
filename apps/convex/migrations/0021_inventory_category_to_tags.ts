import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Inventory: fold the retired single `category` enum into free-form `tags`.
 *
 * The `assets.category` field was replaced by `tags: string[]` (an asset can be
 * both "audio" and "cable"). For any legacy row this backfills `tags` from its
 * old category (when tags are still empty) and clears the retired field, so the
 * new schema — which has no `category` and requires `tags` — validates.
 *
 * The chapter gear registry shipped empty (no seed creates assets), so on the
 * current deployment this is a no-op; it exists for safety and idempotency. The
 * legacy `category` read/clear is routed through `any` because the new typed
 * `Doc<"assets">` no longer carries the field (mirrors 0016_clear_legacy_fields).
 */
export async function runInventoryCategoryToTags(ctx: MutationCtx) {
  let migrated = 0;
  for (const row of await ctx.db.query("assets").collect()) {
    const legacyCategory = (row as any).category as string | undefined;
    const tags = (row as any).tags as string[] | undefined;
    const patch: Record<string, unknown> = {};
    if ((!tags || tags.length === 0) && legacyCategory && legacyCategory !== "other") {
      patch.tags = [legacyCategory];
    } else if (!tags) {
      patch.tags = [];
    }
    if (legacyCategory !== undefined) patch.category = undefined;
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(row._id, patch as any);
      migrated++;
    }
  }
  return { migrated };
}

export const inventoryCategoryToTags: Migration = {
  name: "0021_inventory_category_to_tags",
  run: runInventoryCategoryToTags,
};
