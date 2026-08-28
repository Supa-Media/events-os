import type { MutationCtx } from "../_generated/server";
import type { Migration } from "./index";
import { seedSiteContent } from "../marketingSite";
import { seedBrandKit } from "../marketingDesigns";
import { seedBlogPosts } from "../marketingBlog";

/**
 * Put the Marketing desk's content in the database on deploy, instead of
 * asking a human to run three commands afterwards.
 *
 * ── Why this exists, which is a mistake worth not repeating ─────────────────
 * The homepage's link cards and impact numbers shipped as
 * `marketingSite:seedSiteContentIfEmpty`, an internal mutation with "run once
 * after deploy" in its doc. Nobody ran it. The founder opened Marketing →
 * Links on the day it shipped and saw an empty grid, and reported the feature
 * as not working — correctly, from where he was sitting. The cards were on
 * publicworship.life the whole time, served from the YAML fallback, so the
 * page looked right and the desk looked broken.
 *
 * That is the general shape of the bug: **a seed whose absence is
 * indistinguishable from a bug does not belong in a runbook.** An empty tab
 * cannot tell you it is unseeded — it can only look like nothing works — and
 * the one person who could diagnose it is the one who wrote the runbook step.
 * So it runs here, on the deploy, where forgetting is not an option.
 *
 * ── What it seeds ───────────────────────────────────────────────────────────
 *  - `siteLinks` / `siteStats` — the Important Links cards and the impact
 *    numbers that were `links.yaml` / `impact.yaml`.
 *  - `brandColors` / `brandFonts` / `designFolders` — the brand kit, read off
 *    `PUBLIC_WORSHIP_THEME` and the Academy's own brand lesson.
 *  - `blogPosts` — the doxology essay, whose markdown file is DELETED in the
 *    same change. This one is not a convenience: it is the only remaining copy
 *    of a live, already-shared post, so skipping it would take
 *    `/blog/doxology` off the internet rather than leaving a tab empty.
 *
 * ── Idempotence ─────────────────────────────────────────────────────────────
 * Every body is all-or-nothing PER TABLE: a table with any row in it is left
 * completely alone. Per-row "insert if missing" was rejected in each — it
 * would resurrect a card or a color somebody deliberately deleted, every time
 * the migration ran. That makes this safe under the ledger and safe without
 * it, which is the standard every migration in this registry holds to.
 *
 * The three seeds stay separate functions in their own modules rather than
 * being inlined here, so a manual re-run
 * (`npx convex run marketingSite:seedSiteContentIfEmpty`) executes the exact
 * same code this did — a second copy would be a second thing to keep true.
 */
export const seedMarketingDesk: Migration = {
  name: "0080_seed_marketing_desk",
  run: async (ctx: MutationCtx) => {
    const site = await seedSiteContent(ctx);
    const brand = await seedBrandKit(ctx);
    const blog = await seedBlogPosts(ctx);
    return {
      links: site.links,
      stats: site.stats,
      colors: brand.colors,
      fonts: brand.fonts,
      folders: brand.folders,
      posts: blog.inserted,
    };
  },
};
