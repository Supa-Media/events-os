import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Founder (2026-11-16): "make sure the NYC chapter director can see the
 * recruiting tab and all the people that applied for nyc roles or open to
 * other roles."
 *
 * The seat template now grants `hiring.view` to the Chapter Director, and
 * `hiring.view` held at a chapter scope reads that chapter's slice of the
 * applications (`lib/hiringAccess.ts`). This puts the power on the live
 * Chapter Director rows, which predate it.
 *
 * Additive and content-idempotent, the `0098` shape: it only APPENDS the
 * power to a row that lacks it and never removes anything.
 */
const POWER = "hiring.view";
const TARGET_SLUGS = ["chapter_director"] as const;

export async function runChapterDirectorHiringView(ctx: MutationCtx) {
  let patched = 0;
  let skipped = 0;
  for (const slug of TARGET_SLUGS) {
    const rows = await ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .collect();
    for (const row of rows) {
      if (row.capabilities.includes(POWER)) {
        skipped++;
        continue;
      }
      await ctx.db.patch(row._id, {
        capabilities: [...row.capabilities, POWER],
        updatedAt: Date.now(),
      });
      patched++;
    }
  }
  return { patched, skipped };
}

export const chapterDirectorHiringView: Migration = {
  name: "0099_chapter_director_hiring_view",
  run: runChapterDirectorHiringView,
};
