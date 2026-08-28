/**
 * THE BLOG, server-rendered — `/blog`, `/blog/<slug>`, the feed, the sitemap.
 *
 * Same house pattern as `publicLedgerPage.ts` and `givePage.ts`: an
 * `httpAction` returns a complete document with its own `<head>`, inline CSS
 * and JS, no external assets beyond the shared font link, and real canonical
 * + `og:*` tags on the first byte. Registered onto the main router by
 * `http.ts` via `registerBlogPageRoutes` at the bottom of this file.
 *
 * ── WHY THESE PAGES ARE RENDERED HERE AND NOT HYDRATED IN ASTRO ─────────────
 * Posts now live in Convex so marketing can publish without a deploy
 * (`packages/shared/src/marketingBlog.ts` has the whole argument). The
 * alternative on the table was to keep the Astro pages and fetch the post at
 * runtime, and it was rejected because a post exists ONLY in the database: a
 * statically-built page has no fallback copy to ship, so a crawler would read
 * an empty article under a generic `<title>`, `/rss.xml` would list nothing,
 * and the sitemap would name no post. The Marketing desk's other surfaces
 * (homepage copy, link cards) hydrate safely precisely because they DO ship
 * real fallback content. A blog nobody can find is not worth writing.
 *
 * ── THE THREE STATES, AND WHAT EACH ONE OWES A CRAWLER ──────────────────────
 * `published` — indexable, in the index, the feed, and the sitemap.
 * `draft`     — resolves only with `?preview=<token>`; `noindex,nofollow` and
 *               `no-store`. SHARING A LINK IS NOT THE SAME AS BEING INDEXED
 *               (`givePage.ts#ogHead` makes this argument at length): the
 *               token is what makes the draft shareable, and `noindex` is
 *               what keeps a leaked link out of the index. Its canonical
 *               points at the FUTURE published URL, exactly as the retired
 *               Astro draft page did, so a leak sends search engines to where
 *               the post will actually live rather than to the token URL.
 * `archived`  — resolves, at 200, to a page that says it was taken down, and
 *               carries `noindex`. NOT a 404 and deliberately not a 410: a
 *               link that was shared once is shared forever, 410 tells a
 *               crawler to forget a URL people still hold, and "this was
 *               taken down" is a better answer to a reader than either.
 *
 * ── THE DESIGN IS A PORT ────────────────────────────────────────────────────
 * `apps/landing/src/layouts/PostLayout.astro` and the `.pw-post` prose block
 * in `apps/landing/src/styles/global.css` are the visual target — a live,
 * well-designed post moved here and a reader must not be able to tell.
 * `blogPageStyles.ts` carries the transcribed CSS; the markup below mirrors
 * the layout element for element (audience eyebrow, title, standfirst,
 * byline, hero, h2-only table of contents, body, tags, reactions, back link).
 */
import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { BASE_CSS, FAVICON, FONTS } from "./landingPageStyles";
import { BLOG_CSS } from "./blogPageStyles";
import { BLOG_REACTIONS_JS } from "./blogPageClient";
import { BLOG_REACTION_EMOJIS } from "./blogReactions";
import { escapeHtml as esc } from "./html";
import { siteUrl } from "./siteUrl";
import {
  BLOG_FEED_PATH,
  BLOG_INDEX_PATH,
  BLOG_PREVIEW_PARAM,
  BLOG_SITEMAP_PATH,
  blogPostPath,
  isIndexable,
  readingMinutes,
  type BlogHeading,
  type BlogPost,
  type BlogPostSummary,
} from "@events-os/shared";

/**
 * The blog's own one-liner — `<meta name="description">` on the index and the
 * RSS channel description, which is why it is a constant rather than two
 * strings that agree today. Carried over verbatim from the Astro index and
 * feed so the description search engines already hold does not change under
 * them mid-migration.
 */
const BLOG_DESCRIPTION =
  "Writing from the Public Worship team on worship, songwriting, and taking Jesus into the streets of New York City.";

// ── Formatting ───────────────────────────────────────────────────────────────

/** "August 11, 2026" — spelled out, in UTC. UTC and not the org's Eastern
 *  timezone on purpose: this is the port of `apps/landing/src/lib/blog.ts`'s
 *  `formatPostDate`, and a migrated post whose date shifted by a day under a
 *  reader would be a visible regression for no gain. */
function postDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** `datetime` for `<time>`. */
function isoDate(ts: number): string {
  return new Date(ts).toISOString();
}

/** XML text escaping, for the feed and the sitemap. Distinct from `esc()`:
 *  XML has no `&quot;`-vs-`&#39;` subtlety to preserve and spells the
 *  apostrophe `&apos;`, which HTML does not. Ported unchanged from
 *  `apps/landing/src/pages/rss.xml.ts` — titles and descriptions are prose
 *  written by humans, and one unescaped ampersand breaks a whole feed. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Escape a heading's text for the table of contents.
 *
 * `BlogHeading.text` (`packages/shared/src/blogMarkdown.ts`) is the ONE string
 * on this page that may legitimately arrive carrying HTML entities: it comes
 * out of the markdown parser, which preserves what the author typed —
 * `&ldquo;`, `&amp;` — rather than re-encoding it, and its doc comment says to
 * escape it this way or write it into a text node. Plain `esc()` would print
 * `&ldquo;` at the reader inside a link whose target heading renders a real
 * quotation mark. So this mirrors that module's private `escapeText`: a
 * well-formed entity survives (the alternative is first, so it wins the
 * match), and everything that could open a tag does not.
 *
 * Deliberately NOT used anywhere else here. A title, a tag or a description is
 * prose an editor typed into a form, where a literal `&` means `&` — those go
 * through `esc()` like every other interpolation.
 */
function escapeHeadingText(text: string): string {
  return text.replace(
    /&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});|[&<>]/g,
    (m) =>
      m.length > 1 ? m : m === "&" ? "&amp;" : m === "<" ? "&lt;" : "&gt;",
  );
}

/** Absolute URL for a site-relative path. */
function absolute(path: string): string {
  return `${siteUrl()}${path}`;
}

// ── Page shell ───────────────────────────────────────────────────────────────

/**
 * Every blog document's `<head>` and chrome.
 *
 * The topbar is the compact one `/finances` uses rather than the landing
 * site's full `Header.astro` — that header is a Tailwind + Astro component
 * with a mobile menu controller behind it, and re-implementing it here would
 * be a second copy of the site's navigation to keep in sync. The wordmark
 * links home, which is what the nav is actually for on a page somebody
 * arrived at from a shared link.
 */
function shell(opts: {
  /** Page title WITHOUT the site suffix — added here so every page carries
   *  it, as `BaseLayout.astro` did. */
  title: string;
  description: string;
  /** Path the canonical + `og:url` point at. For a draft preview this is the
   *  post's future PUBLISHED path, never the token URL. */
  canonicalPath: string;
  body: string;
  noindex?: boolean;
  /** "article" for a post, so a share renders as writing rather than a site. */
  ogType?: "website" | "article";
  /** The post's hero image, when it has one. No fallback share card: the
   *  Astro layout defaulted to `/og-default.jpg`, which is not in
   *  `apps/landing/public/` and never was — porting it would advertise a
   *  404 to every scraper. */
  imageUrl?: string | null;
  /** Include the reaction-bar script. Only a post with reactions enabled
   *  needs it; the index and the error pages ship no JS at all. */
  script?: boolean;
}): string {
  const fullTitle = `${opts.title} — Public Worship`;
  const url = absolute(opts.canonicalPath);
  const image = opts.imageUrl
    ? `<meta property="og:image" content="${esc(opts.imageUrl)}">
<meta property="og:image:alt" content="${esc(opts.title)}">
<meta name="twitter:image" content="${esc(opts.imageUrl)}">`
    : "";
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${opts.noindex ? `<meta name="robots" content="noindex, nofollow">\n` : ""}<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(opts.description)}">
<link rel="canonical" href="${esc(url)}">
<link rel="alternate" type="application/rss+xml" title="Public Worship — Blog" href="${esc(BLOG_FEED_PATH)}">
<meta property="og:type" content="${opts.ogType ?? "website"}">
<meta property="og:site_name" content="Public Worship">
<meta property="og:title" content="${esc(fullTitle)}">
<meta property="og:description" content="${esc(opts.description)}">
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="${opts.imageUrl ? "summary_large_image" : "summary"}">
<meta name="twitter:title" content="${esc(fullTitle)}">
<meta name="twitter:description" content="${esc(opts.description)}">
${image}
<meta name="theme-color" content="#FDF6F6">
${FAVICON}${FONTS}
<style>${BASE_CSS}${BLOG_CSS}</style>
</head><body>
<main>
<div class="topbar">
  <a class="wordmark" href="/">PUBLIC WORSHIP</a>
  <nav class="topnav">
    <a href="${esc(BLOG_INDEX_PATH)}">Blog</a>
    <a href="/give">Give</a>
    <a href="/finances">Finances</a>
  </nav>
</div>
${opts.body}
</main>${opts.script ? `\n<script>${BLOG_REACTIONS_JS}</script>` : ""}
</body></html>`;
}

/** The eyebrow chip at the top of the index — `.pw-eyebrow` plus the sparkle
 *  from `apps/landing/src/components/icons/SparkleIcon.astro`, inlined
 *  because the whole point of these pages is that they need no assets. */
const EYEBROW = `<span class="eyebrow"><svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0l1.5 5.5L15 7l-5.5 1.5L8 14l-1.5-5.5L1 7l5.5-1.5z"/></svg>Public Worship</span>`;

// ── The index ────────────────────────────────────────────────────────────────

/**
 * `/blog` — published posts, newest first.
 *
 * The empty state is kept from the Astro index even though there is now
 * always at least one post: "nothing published yet" is a sentence a reader
 * can act on, and the alternative (an unexplained blank page) is what a
 * first-run deployment or an emptied table would otherwise show.
 */
export function renderBlogIndexPage(posts: BlogPostSummary[]): string {
  const items = posts
    .map(
      (post) => `<li>
  <article>
    ${post.audience ? `<p class="audience">Written for ${esc(post.audience)}</p>` : ""}
    <h2 class="postlink"><a href="${esc(blogPostPath(post.slug))}">${esc(post.title)}</a></h2>
    <p class="postsummary">${esc(post.description)}</p>
    ${
      post.publishedAt
        ? `<p class="postmeta"><time datetime="${esc(isoDate(post.publishedAt))}">${esc(postDate(post.publishedAt))}</time></p>`
        : ""
    }
  </article>
</li>`,
    )
    .join("\n");

  const body = `<div class="indexhead">
  ${EYEBROW}
  <h1 class="indextitle">The <span class="accent">Blog</span></h1>
  <p class="indexlede">Writing from our team on worship, songwriting, and what we're learning taking Jesus into the streets, parks, and trains of New York City.</p>
</div>
${
  posts.length === 0
    ? `<p class="empty">Nothing published yet — the first pieces are being written now. Check back soon.</p>`
    : `<ul class="postlist">\n${items}\n</ul>`
}
<p class="feedline">Prefer a reader? <a href="${esc(BLOG_FEED_PATH)}">Subscribe by RSS</a>.</p>`;

  return shell({
    title: "Blog",
    description: BLOG_DESCRIPTION,
    canonicalPath: BLOG_INDEX_PATH,
    body,
  });
}

// ── One post ─────────────────────────────────────────────────────────────────

/** Emoji → accessible name. A screen reader announcing "🙏 button" tells
 *  nobody anything. The emoji themselves come from `blogReactions.ts`, which
 *  is the server's authority on what it will accept — unlike the retired
 *  Astro component, this renderer can simply import that list instead of
 *  hand-syncing a copy of it. */
const REACTION_LABELS: Record<string, string> = {
  "🙏": "Amen",
  "🙌": "Praise",
  "❤️": "Love",
  "🔥": "Fire",
  "💡": "This helped",
  // The disagreement slot — see `blogReactions.ts` on why the bar carries one
  // on purpose.
  "🤔": "Not so sure",
};

/** The reaction bar, rendered with zeroed counts so the row exists on first
 *  paint and never shifts the page when the real numbers land
 *  (`blogPageClient.ts` fills them in). */
function reactionsHtml(slug: string): string {
  const buttons = BLOG_REACTION_EMOJIS.map((emoji) => {
    const label = REACTION_LABELS[emoji] ?? emoji;
    return `<button type="button" class="pw-reaction" data-emoji="${esc(emoji)}" aria-pressed="false" aria-label="${esc(label)}" title="${esc(label)}"><span class="emoji" aria-hidden="true">${esc(emoji)}</span><span class="count" data-count>0</span></button>`;
  }).join("");

  return `<section class="reactions" data-blog-reactions data-slug="${esc(slug)}" aria-labelledby="reactions-heading">
  <h2 id="reactions-heading">Did this land?</h2>
  <p class="blurb">No sign-in, no comment box — just tap. You can tap again to take it back. <span data-reader-count></span></p>
  <div class="reactionlist">${buttons}</div>
  <p class="reactionerror" data-reaction-error role="status" aria-live="polite"></p>
</section>`;
}

/**
 * `/blog/<slug>` — the post itself, and `?preview=<token>` the same post in
 * draft.
 *
 * The two are ONE renderer, as they were in Astro (`PostLayout.astro` served
 * both `/blog/<slug>` and `/blog/drafts/<slug>`): a reviewer has to be
 * reading the real thing, and nothing about a post's presentation can be
 * allowed to differ between its draft and published forms. The banner and the
 * `noindex` in the head are the entire difference.
 */
export function renderBlogPostPage(opts: {
  post: BlogPost;
  /** The rendered body, from `packages/shared/src/blogMarkdown.ts` via
   *  `internal.marketingBlog.publicPost`. */
  html: string;
  headings: BlogHeading[];
  /** Rendering a draft through its preview token. */
  preview?: boolean;
}): string {
  const { post, headings, preview } = opts;

  // h2s only. The posts here run long enough to need a map, and including
  // every h3 turns the map into a second copy of the article — the rule
  // PostLayout.astro applied, kept.
  const toc = headings.filter((h) => h.depth === 2);
  const tocHtml =
    toc.length > 2
      ? `<nav class="toc" aria-labelledby="toc-heading">
  <h2 id="toc-heading">In this post</h2>
  <ol>${toc.map((h) => `<li><a href="#${esc(h.id)}">${escapeHeadingText(h.text)}</a></li>`).join("")}</ol>
</nav>`
      : "";

  const banner = preview
    ? `<p class="banner"><strong>Unpublished draft.</strong> This post is left out of the blog index, the feed, the sitemap, and search engines. The token in this link is the only way to reach it — anyone you send it to can read it, and rotating the post's token revokes it.</p>`
    : "";

  const dateLine = post.publishedAt
    ? `<time datetime="${esc(isoDate(post.publishedAt))}">${esc(postDate(post.publishedAt))}</time>`
    : `<span>Not published yet</span>`;

  const minutes = readingMinutes(post.body);

  const body = `${banner}
<article>
  <header>
    ${post.audience ? `<p class="audience">Written for ${esc(post.audience)}</p>` : ""}
    <h1 class="posttitle">${esc(post.title)}</h1>
    ${post.subtitle ? `<p class="standfirst">${esc(post.subtitle)}</p>` : ""}
    <p class="byline">
      <span>${esc(post.author)}</span>
      <span aria-hidden="true">·</span>
      ${dateLine}
      <span aria-hidden="true">·</span>
      <span>${minutes} min read</span>
    </p>
    ${
      post.updatedAt
        ? `<p class="updated">Updated <time datetime="${esc(isoDate(post.updatedAt))}">${esc(postDate(post.updatedAt))}</time></p>`
        : ""
    }
  </header>
  ${post.heroImageUrl ? `<img class="hero" src="${esc(post.heroImageUrl)}" alt="" loading="eager">` : ""}
  ${tocHtml}
  <div class="pw-post">
${
  // THE ONE PLACE THIS FILE INSERTS UNESCAPED HTML. `opts.html` is the post
  // body already rendered AND sanitized by `blogMarkdown.ts`, which is the
  // single place that decides what markup a post may contain — escaping it
  // here would print the article's own tags at the reader. Every other
  // interpolation on this page goes through `esc()`.
  opts.html
}
  </div>
  ${
    post.tags.length > 0
      ? `<ul class="tags" aria-label="Topics">${post.tags.map((tag) => `<li>${esc(tag)}</li>`).join("")}</ul>`
      : ""
  }
  ${post.reactionsEnabled ? reactionsHtml(post.slug) : ""}
  <p class="backlink"><a href="${esc(BLOG_INDEX_PATH)}">← All posts</a></p>
</article>`;

  return shell({
    title: post.title,
    description: post.description,
    // The FUTURE published path even for a draft — see the module doc.
    canonicalPath: blogPostPath(post.slug),
    body,
    ogType: "article",
    imageUrl: post.heroImageUrl,
    noindex: !isIndexable(post.status),
    script: post.reactionsEnabled,
  });
}

/**
 * An archived post — 200, not 404. See the module doc for why a taken-down
 * URL keeps resolving.
 *
 * The post's own title is on the page (a reader following an old link should
 * be able to tell they found the right thing), but the BODY is not: it was
 * taken down, and re-serving it under a notice saying otherwise would make
 * the notice a lie.
 */
export function renderBlogTakenDownPage(post: BlogPostSummary): string {
  const body = `<div class="takedown">
  <h1>This post was taken down</h1>
  <p><strong>${esc(post.title)}</strong> was published${post.publishedAt ? ` on ${esc(postDate(post.publishedAt))}` : ""} and is no longer up. The link still works — we don't break links people have shared — but the piece itself has been withdrawn.</p>
  <p>If you were looking for something specific in it, <a href="${esc(BLOG_INDEX_PATH)}">the rest of the blog</a> is still here.</p>
</div>`;
  return shell({
    title: `${post.title} — no longer published`,
    description: "This post was taken down and is no longer published.",
    canonicalPath: blogPostPath(post.slug),
    body,
    noindex: true,
  });
}

/** No such post — including every retired `/blog/drafts/<slug>` URL, which
 *  now lands here rather than on a password form. */
export function renderBlogNotFound(): string {
  const body = `<div class="takedown">
  <h1>We couldn't find that post</h1>
  <p>The link may be mistyped, or the post may never have been published.</p>
  <p><a href="${esc(BLOG_INDEX_PATH)}">Read what we have published</a>.</p>
</div>`;
  return shell({
    title: "Post not found",
    description: "That post couldn't be found.",
    canonicalPath: BLOG_INDEX_PATH,
    body,
    noindex: true,
  });
}

// ── Feed + sitemap ───────────────────────────────────────────────────────────

/**
 * `/blog/rss.xml` — a straight port of `apps/landing/src/pages/rss.xml.ts`,
 * down to the channel copy and the element order, so a reader that already
 * has the feed sees the same items described the same way.
 *
 * Still hand-rolled rather than a feed library: it is thirty lines of XML.
 *
 * MOVED from `/rss.xml`, which was an Astro route and could not follow the
 * posts here without teaching the edge router a one-file exception. The old
 * path 301s to this one (`infra/router/src/route.ts`), so existing
 * subscribers follow along.
 */
export function renderBlogFeed(posts: BlogPostSummary[]): string {
  const items = posts
    .map((post) => {
      const link = absolute(blogPostPath(post.slug));
      return `    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="true">${escapeXml(link)}</guid>
      <description>${escapeXml(post.description)}</description>
      <pubDate>${new Date(post.publishedAt ?? Date.now()).toUTCString()}</pubDate>
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Public Worship — Blog</title>
    <link>${escapeXml(absolute(BLOG_INDEX_PATH))}</link>
    <atom:link href="${escapeXml(absolute(BLOG_FEED_PATH))}" rel="self" type="application/rss+xml" />
    <description>${escapeXml(BLOG_DESCRIPTION)}</description>
    <language>en-us</language>
${items}
  </channel>
</rss>
`;
}

/**
 * `/blog/sitemap.xml` — published posts, plus the index.
 *
 * THIS IS THE BLOG'S ONLY SITEMAP. Astro's `@astrojs/sitemap` builds
 * `sitemap-index.xml` from the pages it statically generates, and these URLs
 * are not among them — they are served by this backend, so nothing in that
 * build knows they exist. That gap is real and PRE-EXISTING: `/give`,
 * `/give/<slug>` and `/finances/*` have never appeared in the Astro sitemap
 * either. It is closed for the blog specifically because a blog whose posts
 * no crawler is told about is the failure mode this whole migration exists to
 * avoid, and `apps/landing/public/robots.txt` names this file so it is
 * actually discovered.
 */
export function renderBlogSitemap(posts: BlogPostSummary[]): string {
  const urls = [
    `  <url>\n    <loc>${escapeXml(absolute(BLOG_INDEX_PATH))}</loc>\n  </url>`,
    ...posts.filter((p) => isIndexable(p.status)).map((post) => {
      // `lastmod` is the last MATERIAL change: a revision if there was one,
      // otherwise publication. It is omitted rather than faked for a post
      // carrying neither.
      const changed = post.updatedAt ?? post.publishedAt;
      return `  <url>\n    <loc>${escapeXml(absolute(blogPostPath(post.slug)))}</loc>${
        changed ? `\n    <lastmod>${escapeXml(new Date(changed).toISOString())}</lastmod>` : ""
      }\n  </url>`;
    }),
  ].join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

// ── Routes ───────────────────────────────────────────────────────────────────

/** The last path segment of the feed and the sitemap, derived from the shared
 *  paths rather than re-typed: the prefix route dispatches on them, and a
 *  literal here that drifted from the contract would serve a post page for
 *  `/blog/rss.xml` instead of the feed. */
const FEED_SEGMENT = BLOG_FEED_PATH.slice(BLOG_INDEX_PATH.length + 1);
const SITEMAP_SEGMENT = BLOG_SITEMAP_PATH.slice(BLOG_INDEX_PATH.length + 1);

/** A published page changes only when somebody publishes, and the whole point
 *  of the move is that publishing is now instant — a minute is short enough
 *  that nobody waits on a correction and long enough to absorb a share. */
const BLOG_CACHE = "public, max-age=60";
/** The feed and the sitemap are polled by machines on their own schedule, and
 *  an hour of staleness costs a reader nothing. Matches what the Astro feed
 *  already sent. */
const FEED_CACHE = "public, max-age=3600";

function htmlResponse(body: string, status: number, cache: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": cache },
  });
}

function xmlResponse(body: string, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": contentType, "Cache-Control": FEED_CACHE },
  });
}

export function registerBlogPageRoutes(http: HttpRouter): void {
  // `/blog` (exact) and everything under `/blog/` — the same exact-path +
  // prefix pair `/give` and `/finances` use, because Convex's router has no
  // single rule that covers both. The paths come from the shared contract
  // rather than being written out here, so this file, the OS's links, and
  // `infra/router/src/route.ts`'s drift test all read the same definition.
  http.route({
    path: BLOG_INDEX_PATH,
    method: "GET",
    handler: httpAction(async (ctx) => {
      const posts = await ctx.runQuery(internal.marketingBlog.publicPostList, {});
      return htmlResponse(renderBlogIndexPage(posts), 200, BLOG_CACHE);
    }),
  });

  http.route({
    pathPrefix: `${BLOG_INDEX_PATH}/`,
    method: "GET",
    handler: httpAction(async (ctx, req) => {
      const url = new URL(req.url);
      // ["blog"] | ["blog", slug] | ["blog", "rss.xml"] | ["blog", "sitemap.xml"]
      const segments = url.pathname.split("/").filter(Boolean);

      // `?preview=<token>` must never end up in a cacheable response on ANY
      // branch below, INCLUDING a 404. A shared cache keys on the full URL,
      // query string included, so a `public, max-age=60` entry for a URL
      // carrying a live token is a leak surface in itself — the lesson
      // `publicLedgerPage`'s route learned the hard way. So the token decides
      // the cache header first, before anything decides what to render.
      const previewToken = url.searchParams.get(BLOG_PREVIEW_PARAM);
      const cache = previewToken ? "no-store, private" : BLOG_CACHE;
      const notFound = () => htmlResponse(renderBlogNotFound(), 404, cache);

      // `/blog/` — the index under a trailing slash. Served rather than
      // redirected: the Astro site ran `trailingSlash: "ignore"`, so both
      // spellings have always worked and links to either are in circulation.
      // The canonical tag names `/blog`, which is what search engines need.
      if (segments.length === 1) {
        if (previewToken) return notFound();
        const posts = await ctx.runQuery(internal.marketingBlog.publicPostList, {});
        return htmlResponse(renderBlogIndexPage(posts), 200, BLOG_CACHE);
      }
      // Nothing nests under a post: `/blog/drafts/<slug>` (the retired
      // password-gated URLs) and any other two-deep path land here.
      if (segments.length > 2) return notFound();

      // A malformed percent-escape (`/blog/%E0%A4%A`) makes this throw, which
      // would be a 500 for what is really just a bad URL.
      let slug: string;
      try {
        slug = decodeURIComponent(segments[1]);
      } catch {
        return notFound();
      }

      if (slug === FEED_SEGMENT) {
        const posts = await ctx.runQuery(internal.marketingBlog.publicPostList, {});
        return xmlResponse(renderBlogFeed(posts), "application/rss+xml; charset=utf-8");
      }
      if (slug === SITEMAP_SEGMENT) {
        const posts = await ctx.runQuery(internal.marketingBlog.publicPostList, {});
        return xmlResponse(renderBlogSitemap(posts), "application/xml; charset=utf-8");
      }

      // The query is the only thing that decides whether a draft resolves: a
      // draft without a matching token comes back null and is indistinguishable
      // here from a slug that was never written, which is the point — a 404
      // that differed would confirm the draft exists.
      const result = await ctx.runQuery(internal.marketingBlog.publicPost, {
        slug,
        ...(previewToken ? { previewToken } : {}),
      });
      if (!result) return notFound();

      if (result.post.status === "archived") {
        // 200, not 404 — see the module doc.
        return htmlResponse(renderBlogTakenDownPage(result.post), 200, cache);
      }

      return htmlResponse(
        renderBlogPostPage({
          post: result.post,
          html: result.html,
          headings: result.headings,
          preview: result.post.status === "draft",
        }),
        200,
        // A published post read through a preview link is still uncacheable:
        // the URL carries the token either way.
        cache,
      );
    }),
  });
}
