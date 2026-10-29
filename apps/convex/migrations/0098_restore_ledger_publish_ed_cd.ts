import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";

/**
 * Founder correction (2026-10-29), the same evening as `0097`: "Don't take the
 * power away from the executive director [and] the chapter director. What I
 * meant to change was the rule that nobody can publish a month they sent for
 * review themselves."
 *
 * `0097` had already run on production and removed `finance.ledger.publish`
 * from the live Executive Director row (the Chapter Director rows had already
 * lost it in an earlier in-app edit). The seat template grants it to both
 * again, so this puts it back on the live rows. Treasurers keep the power
 * `0097` gave them.
 *
 * Additive and content-idempotent, the `0089` shape: it only APPENDS the
 * power to a row that lacks it (in either spelling) and never removes
 * anything.
 */
const PUBLISH = "finance.ledger.publish";
const PUBLISH_SPELLINGS = new Set([PUBLISH, "finance.publish"]);
const TARGET_SLUGS = ["executive_director", "chapter_director"] as const;

export async function runRestoreLedgerPublishEdCd(ctx: MutationCtx) {
  let patched = 0;
  let skipped = 0;
  for (const slug of TARGET_SLUGS) {
    const rows = await ctx.db
      .query("seatDefs")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .collect();
    for (const row of rows) {
      if (row.capabilities.some((c) => PUBLISH_SPELLINGS.has(c))) {
        skipped++;
        continue;
      }
      await ctx.db.patch(row._id, {
        capabilities: [...row.capabilities, PUBLISH],
        updatedAt: Date.now(),
      });
      patched++;
    }
  }
  return { patched, skipped };
}

export const restoreLedgerPublishEdCd: Migration = {
  name: "0098_restore_ledger_publish_ed_cd",
  run: runRestoreLedgerPublishEdCd,
};
