import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Cleanup after the guide slug renames (workstream → area vocabulary):
 *   docs/guides/so-you-own-a-workstream.md   → so-you-own-an-area.md
 *   docs/guides/owning-the-comms-workstream.md → owning-the-comms-area.md
 *
 * The guide seeder upserts platform docs by (chapterId, slug), so every chapter
 * re-seeds the guides under the NEW slugs and the old-slug rows linger as
 * orphaned platform docs. This deletes the old-slug rows in every chapter.
 *
 * Idempotent: a second run finds nothing to delete.
 */
const OLD_SLUGS = ["so-you-own-a-workstream", "owning-the-comms-workstream"];

export async function runCleanupRenamedGuideSlugs(ctx: MutationCtx) {
  let deleted = 0;
  for (const chapter of await ctx.db.query("chapters").collect()) {
    for (const slug of OLD_SLUGS) {
      const doc = await ctx.db
        .query("docs")
        .withIndex("by_chapter_and_slug", (q) =>
          q.eq("chapterId", chapter._id).eq("slug", slug),
        )
        .unique();
      if (doc) {
        await ctx.db.delete(doc._id);
        deleted++;
      }
    }
  }
  return { deleted };
}

export const cleanupRenamedGuideSlugs: Migration = {
  name: "0007_cleanup_renamed_guide_slugs",
  run: runCleanupRenamedGuideSlugs,
};
