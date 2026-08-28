import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { ensurePostsRow } from "../marketingSite";

/**
 * Give every existing deployment the Important Links grid's second auto row —
 * the one that shows the latest blog posts.
 *
 * ── Why a migration and not the seed ────────────────────────────────────────
 * `seedSiteContent` is all-or-nothing PER TABLE: a `siteLinks` table with any
 * row in it is left completely alone, which is what stops the seed from
 * resurrecting a card somebody deliberately deleted. That rule is right, and it
 * is exactly why the seed cannot deliver this: production's `siteLinks` has
 * been populated since 0080, so adding the posts row to the seed reaches only a
 * deployment nobody has used yet. The founder would open Marketing → Links,
 * find no posts row, and report the feature as not shipped — correctly.
 *
 * This is the same lesson 0080 exists to record, one step further on: it is not
 * enough to move a seed out of a runbook, because a seed only ever fires once.
 * **A new row in an already-seeded table is a migration, always.**
 *
 * ── Why insert-if-missing is safe here ──────────────────────────────────────
 * Per-row "insert if missing" is normally forbidden in this registry, because
 * it resurrects rows a human removed on purpose. It is safe for this one row
 * for a structural reason rather than a hopeful one: the posts row, like the
 * events row, is UNDELETABLE — `deleteLink` refuses it, because deleting it
 * would not take the posts off the page, it would take away the marketer's only
 * handle on how many show and where they land. Taking them off the page is what
 * `published: false` is for, and this migration does not touch `published` on a
 * row that already exists.
 *
 * So for this row, absent can only ever mean "predates the feature". There is
 * no state in which a human chose its absence, which is precisely the condition
 * the no-resurrection rule protects.
 *
 * The insert itself lives in `marketingSite.ts` beside the code that owns the
 * table's shape, so a manual re-run and this migration execute the same lines.
 */
export const addPostsLinkRow: Migration = {
  name: "0081_add_posts_link_row",
  run: async (ctx: MutationCtx) => {
    const { inserted } = await ensurePostsRow(ctx);
    return { inserted };
  },
};
