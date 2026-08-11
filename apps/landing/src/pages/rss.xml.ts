/**
 * The blog's RSS feed, at /rss.xml.
 *
 * Hand-rolled rather than pulling in @astrojs/rss: the feed is ~30 lines of
 * XML and this app's dependency list (and the pnpm lockfile that CI installs
 * with --frozen-lockfile) is not worth growing for it.
 *
 * Published posts only — `getPublishedPosts` is the single definition of
 * that, shared with the index and the sitemap filter, so a draft cannot leak
 * into the feed by way of a second opinion about what "published" means.
 */
import type { APIRoute } from "astro";
import { getPublishedPosts } from "../lib/blog";

/** XML text escaping. Titles and descriptions are prose written by humans —
 *  an unescaped ampersand or quote in one would break the whole feed. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export const GET: APIRoute = async ({ site }) => {
  // `site` comes from astro.config.mjs; a feed needs absolute URLs, so bail
  // loudly rather than emitting relative links no reader can follow.
  if (!site) throw new Error("astro.config.mjs must set `site` to build /rss.xml");

  const posts = await getPublishedPosts();
  const items = posts
    .map((post) => {
      const link = new URL(`/blog/${post.id}`, site).toString();
      return `    <item>
      <title>${escapeXml(post.data.title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="true">${escapeXml(link)}</guid>
      <description>${escapeXml(post.data.description)}</description>
      <pubDate>${post.data.pubDate.toUTCString()}</pubDate>
    </item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Public Worship — Blog</title>
    <link>${escapeXml(new URL("/blog", site).toString())}</link>
    <atom:link href="${escapeXml(new URL("/rss.xml", site).toString())}" rel="self" type="application/rss+xml" />
    <description>Writing from the Public Worship team on worship, songwriting, and taking Jesus into the streets of New York City.</description>
    <language>en-us</language>
${items}
  </channel>
</rss>
`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
