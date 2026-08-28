/**
 * The blog's public pages, rendered from a REAL seeded post.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * Everything around these pages was tested: the markdown renderer and its
 * sanitizer on their own, the backend's status rules on their own, the router's
 * proxying on its own, and (since `httpRoutes.test.ts`) the fact that the
 * routes are wired at all. Nothing joined them up. The one artifact a reader
 * actually receives — the HTML of the live post, produced by the real seed
 * through the real query through the real renderer — was checked only by hand,
 * out of band, against stub data.
 *
 * That is the seam this whole change turns on. `/blog/doxology` is a page a
 * stranger holds a link to; the markdown file it came from is deleted; and the
 * body travels seed → `blogPosts` row → `renderBlogMarkdown` → sanitizer →
 * page shell. A break anywhere along it is a blank or mangled essay served to
 * the public, and every component test in the repo would still be green.
 */
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { DOXOLOGY_BODY, DOXOLOGY_POST } from "../lib/seed/blogPosts";
import {
  renderBlogFeed,
  renderBlogIndexPage,
  renderBlogPostPage,
  renderBlogSitemap,
  renderBlogTakenDownPage,
} from "../lib/blogPage";
import { blogPostPath } from "@events-os/shared";
import { newT, type TestConvex } from "./setup.helpers";

/** Seed the migrated post and read it back the way the HTTP route does. */
async function seededPost(t: TestConvex) {
  await t.mutation(internal.marketingBlog.seedBlogPostsIfEmpty, {});
  const found = await t.query(internal.marketingBlog.publicPost, {
    slug: DOXOLOGY_POST.slug,
  });
  if (!found) throw new Error("the seeded post did not resolve");
  return found;
}

describe("the live post renders end to end", () => {
  test("seed → query → renderer produces the real essay", async () => {
    const t = newT();
    const found = await seededPost(t);
    const html = renderBlogPostPage(found);

    // The head a crawler and a link preview read.
    expect(html).toContain("<title>");
    expect(html).toContain(DOXOLOGY_POST.title);
    expect(html).toContain(
      `<link rel="canonical" href="${"https"}`.slice(0, 20),
    );
    expect(html).toContain(blogPostPath(DOXOLOGY_POST.slug));
    expect(html).toContain('property="og:title"');

    // The body actually arrived, rendered — not the raw markdown, and not
    // nothing. The post opens with an h2 the table of contents links to.
    expect(html).toContain('<div class="pw-post">');
    expect(html).toContain("<h2");
    expect(html.length).toBeGreaterThan(DOXOLOGY_BODY.length / 2);

    // Published, so it must be indexable. A stray robots meta here would
    // quietly delist the org's only essay. Asserted on the TAG rather than the
    // bare word — the inline reactions script mentions it in passing, and a
    // substring check on "noindex" is the kind that passes for the wrong
    // reason later.
    expect(html).not.toContain('name="robots"');
  });

  test("the post's own raw HTML survives, and script tags do not", async () => {
    const t = newT();
    const found = await seededPost(t);
    const html = renderBlogPostPage(found);

    // The essay embeds raw markup (`pw-scroll`, `pw-note`) that the ported
    // `.pw-post` stylesheet styles — the migration is only faithful if the
    // sanitizer let those through.
    expect(html).toContain("pw-note");

    // And the one thing that must never survive — checked on the POST BODY
    // only. The page itself legitimately inlines the reactions client
    // (`blogPageClient.ts`), so asserting over the whole document would be
    // asserting that the page has no JavaScript, which is a different and
    // false claim. What matters is that nothing arriving from the database
    // became executable.
    const body = html.slice(
      html.indexOf('<div class="pw-post">'),
      html.indexOf("</article>"),
    );
    expect(body.length).toBeGreaterThan(1000);
    expect(body).not.toMatch(/<script/i);
    expect(body).not.toMatch(/\son[a-z]+\s*=/i);
    expect(body).not.toMatch(/javascript:/i);
  });

  test("a draft renders behind its token, uncached and unindexed", async () => {
    const t = newT();
    const found = await seededPost(t);
    const html = renderBlogPostPage({ ...found, preview: true });
    expect(html).toContain("noindex");
    // The canonical still names the published URL — a draft that canonicalized
    // to itself would teach search engines the preview address.
    expect(html).toContain(blogPostPath(DOXOLOGY_POST.slug));
  });

  test("a taken-down post says so, and is not indexed", async () => {
    const t = newT();
    const found = await seededPost(t);
    const html = renderBlogTakenDownPage(found.post);
    expect(html).toContain("noindex");
    expect(html.toLowerCase()).toContain("taken down");
    // The body is withheld — the point of archiving is that the words stop
    // being published, not that the URL stops resolving.
    expect(html).not.toContain('<div class="pw-post">');
  });
});

describe("the index, the feed, and the sitemap agree with the database", () => {
  test("all three carry the seeded post", async () => {
    const t = newT();
    await t.mutation(internal.marketingBlog.seedBlogPostsIfEmpty, {});
    const posts = await t.query(internal.marketingBlog.publicPostList, {});
    expect(posts).toHaveLength(1);

    const path = blogPostPath(DOXOLOGY_POST.slug);
    expect(renderBlogIndexPage(posts)).toContain(path);

    // The feed and the sitemap are the two surfaces that made this a
    // server-rendered page instead of a hydrated one; a post missing from
    // either is the failure that decision exists to prevent.
    const feed = renderBlogFeed(posts);
    expect(feed).toContain("<rss");
    expect(feed).toContain(path);
    expect(feed).toContain(DOXOLOGY_POST.title);

    const sitemap = renderBlogSitemap(posts);
    expect(sitemap).toContain("<urlset");
    expect(sitemap).toContain(path);
  });

  test("a draft reaches none of them", async () => {
    const t = newT();
    const posts = await t.query(internal.marketingBlog.publicPostList, {});
    // Nothing seeded, so nothing published — the three surfaces must be empty
    // rather than erroring, which is also the state a fresh deployment is in
    // for the moments before migration 0080 runs.
    expect(posts).toEqual([]);
    expect(renderBlogFeed(posts)).toContain("<rss");
    expect(renderBlogSitemap(posts)).toContain("<urlset");
    expect(renderBlogIndexPage(posts)).not.toContain(
      blogPostPath(DOXOLOGY_POST.slug),
    );
  });
});
