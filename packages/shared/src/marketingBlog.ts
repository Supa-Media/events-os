/**
 * THE BLOG — posts as data, so marketing can write one without a developer.
 *
 * A post used to be a markdown file in `apps/landing/src/content/blog/`, built
 * statically by Astro. Publishing one was a pull request and a deploy, which
 * meant the seat that owns the org's public voice could not publish the org's
 * public writing.
 *
 * ── Why this one is Convex-RENDERED, not hydrated ───────────────────────────
 * The Marketing desk's other public surfaces (the homepage's copy, the link
 * cards) are patched into a statically-built page at runtime. That works
 * because the page ships real fallback content, so a crawler always sees words.
 * A blog post has no fallback: it exists only here. And a post that is invisible
 * to crawlers, absent from the RSS feed, and missing from the sitemap is not a
 * blog post — it is a page nobody will ever find, which defeats the reason to
 * write one.
 *
 * So `/blog` and `/blog/<slug>` are server-rendered by Convex, the way `/give`
 * and `/finances` already are: real `<title>`, canonical, `og:*`, and a
 * description on first byte. RSS and the sitemap are served from the same rows.
 *
 * ── The three states a post can be in ───────────────────────────────────────
 * `status` is one field with three values rather than two booleans, because
 * `published && !archived` is the kind of pair that eventually disagrees:
 *
 *   `draft`      — being written. Reachable only through a preview link.
 *   `published`  — public, in the index, in the feed, in the sitemap.
 *   `archived`   — WAS public and no longer is. The URL still resolves, to a
 *                  page that says so, because a link that was shared once is
 *                  shared forever and a 404 is a worse answer than "this was
 *                  taken down."
 */

// ── Status ───────────────────────────────────────────────────────────────────

export const BLOG_POST_STATUSES = ["draft", "published", "archived"] as const;
export type BlogPostStatus = (typeof BLOG_POST_STATUSES)[number];

export const BLOG_POST_STATUS_LABELS: Record<BlogPostStatus, string> = {
  draft: "Draft",
  published: "Published",
  archived: "Taken down",
};

/** Whether a post in this state is public. The ONE predicate — the index, the
 *  feed, the sitemap, and the page's own gate all read it, so they cannot
 *  disagree about what "live" means. */
export function isPubliclyVisible(status: BlogPostStatus): boolean {
  return status === "published";
}

/** Whether a post in this state should be indexed by search engines. Archived
 *  posts still RESOLVE (see the module doc) but must not be indexed — the org
 *  took them down. */
export function isIndexable(status: BlogPostStatus): boolean {
  return status === "published";
}

// ── The post ─────────────────────────────────────────────────────────────────

/**
 * One post, as the public page and the OS editor both see it.
 *
 * `body` is markdown. It is rendered to HTML by `blogMarkdown.ts` at request
 * time rather than stored as HTML, so a fix to the renderer fixes every post
 * that ever existed instead of only the ones written afterwards.
 */
export interface BlogPost {
  id: string;
  /** The URL segment. Stable once published — see `BLOG_SLUG_RULE`. */
  slug: string;
  status: BlogPostStatus;
  title: string;
  /** Used verbatim as `<meta name="description">` and the index card's summary,
   *  so it is written as a sentence, not keywords. */
  description: string;
  /** The italic standfirst under the title. */
  subtitle: string | null;
  /** Who it is written for, shown above the title. Posts here are aimed at
   *  specific rooms and saying so is the difference between a reader leaning
   *  in and bouncing. */
  audience: string | null;
  author: string;
  /** Markdown. */
  body: string;
  tags: string[];
  /** A servable URL for the hero image, or null. */
  heroImageUrl: string | null;
  /** When it was first published. Null while it is still a draft — a post
   *  gets its date the moment it goes live, not when someone started typing. */
  publishedAt: number | null;
  /** Set when a published post is materially revised, so the page can say
   *  "updated" honestly rather than implying the original was always this. */
  updatedAt: number | null;
  /** The emoji bar (`blogReactions`). Off for a post where a reaction would be
   *  tasteless. */
  reactionsEnabled: boolean;
}

/** What the index and the feed need — everything but the body, so listing
 *  fifty posts does not ship fifty essays. */
export type BlogPostSummary = Omit<BlogPost, "body">;

export const BLOG_TITLE_MAX = 120;
export const BLOG_DESCRIPTION_MAX = 300;
export const BLOG_SUBTITLE_MAX = 300;
export const BLOG_AUDIENCE_MAX = 80;
export const BLOG_AUTHOR_MAX = 80;
export const BLOG_TAG_MAX = 30;
export const BLOG_TAGS_MAX_COUNT = 8;
/** Generous — the one existing post is ~17KB of markdown. */
export const BLOG_BODY_MAX = 200_000;
export const BLOG_DEFAULT_AUTHOR = "The Public Worship Team";

/** Words per minute for the reading estimate. Matches what the Astro site
 *  used, so the number on a migrated post does not change under the reader. */
export const BLOG_READING_WPM = 220;

/**
 * Reading time in whole minutes, minimum 1.
 *
 * Strips HTML tags before counting, because posts are markdown-WITH-RAW-HTML
 * (the existing doxology post embeds tables and callouts) and counting `<td>`
 * as a word inflates the estimate on exactly the longest posts.
 */
export function readingMinutes(body: string): number {
  const words = body
    .replace(/<[^>]*>/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(words / BLOG_READING_WPM));
}

// ── Slugs ────────────────────────────────────────────────────────────────────

/**
 * THE SLUG RULE, stated once because three things depend on it: the public
 * route, the `blogReactions` table (which keys on a slug string, not a foreign
 * key), and every link anyone has ever shared.
 *
 * A slug is lowercase, alphanumeric, hyphen-separated. It is derived from the
 * title on first save and then FROZEN once the post is published — changing it
 * would orphan the post's reactions and 404 every shared link, and neither is
 * worth the tidier URL.
 */
export const BLOG_SLUG_RULE = "lowercase letters, numbers, and hyphens";
export const BLOG_SLUG_MAX = 80;

/** Derive a slug from a title. Returns `""` for a title with nothing usable in
 *  it, which callers turn into a message rather than storing a blank. */
export function blogSlugFromTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    // Strip combining marks so "Doxología" becomes "doxologia" rather than
    // losing the letter entirely.
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, BLOG_SLUG_MAX)
    .replace(/-+$/, "");
}

/** Whether a slug is one the router and the reactions table will accept.
 *  Deliberately stricter than `blogReactions`'s own `normalizeSlug` (which
 *  permits `/`): a post's slug is one path segment. */
export function isValidBlogSlug(slug: string): boolean {
  return (
    slug.length > 0 &&
    slug.length <= BLOG_SLUG_MAX &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
  );
}

// ── Preview links ────────────────────────────────────────────────────────────

/**
 * How a draft gets shared with an editor before it is public.
 *
 * This REPLACES the landing repo's `/blog/drafts/<slug>` + shared-password
 * gate, and it is an improvement rather than a like-for-like port. That
 * password lives in `wrangler.jsonc` in a public repository, which the router's
 * own doc admits — so what it actually bought was obscurity, not secrecy, and
 * one password covered every draft forever.
 *
 * A per-post token is the `/rsvp/<slug>?preview=` mechanism this codebase
 * already uses for unpublished event pages: unguessable, scoped to one post,
 * and revocable by rotating that post's token alone.
 */
export const BLOG_PREVIEW_PARAM = "preview";
export const BLOG_PREVIEW_TOKEN_BYTES = 16;

// ── Paths ────────────────────────────────────────────────────────────────────

/** The public path for a post. One function, so the page, the index, the feed,
 *  the sitemap, and the OS's "copy link" button cannot disagree. */
export function blogPostPath(slug: string): string {
  return `/blog/${slug}`;
}

export const BLOG_INDEX_PATH = "/blog";
export const BLOG_FEED_PATH = "/blog/rss.xml";
export const BLOG_SITEMAP_PATH = "/blog/sitemap.xml";

/** A draft's shareable preview link. */
export function blogPreviewPath(slug: string, token: string): string {
  return `${blogPostPath(slug)}?${BLOG_PREVIEW_PARAM}=${encodeURIComponent(token)}`;
}
