import { defineTable } from "convex/server";
import { v } from "convex/values";
import { BLOG_POST_STATUSES } from "@events-os/shared";

/**
 * BLOG POSTS — the writing itself, as rows.
 *
 * A post used to be a markdown file in `apps/landing/src/content/blog/`, which
 * meant publishing one was a pull request and a deploy. `@events-os/shared`'s
 * `marketingBlog.ts` carries the whole argument for moving them here; this is
 * only the shape.
 *
 * ── This table is NOT `blogReactions`' parent ───────────────────────────────
 * `schema/blog.ts`'s `blogReactions`/`blogReads` key on a slug STRING, and
 * deliberately still do. Making them point at `blogPosts._id` was considered
 * and rejected: the reaction rows are written by anonymous strangers over an
 * unauthenticated HTTP route that only ever knows the URL it was on, and the
 * counts that exist today were all recorded against `doxological-worship` as
 * a string. Introducing a foreign key would orphan them and buy nothing the
 * slug doesn't already give.
 *
 * What that costs is a RULE, not a column: a post's slug is frozen the moment
 * it is published (`BLOG_SLUG_RULE`, enforced in `marketingBlog.ts#upsertPost`).
 * Renaming a live post would orphan its reactions AND 404 every link anyone
 * has shared, which is why the freeze lives at the one write path rather than
 * being a comment somebody has to remember.
 *
 * ── Chapter scope ───────────────────────────────────────────────────────────
 * There isn't one, matching `blogReactions` and `siteCopy`/`siteLinks`. There
 * is one blog, and `marketing.blog.edit`/`marketing.blog.publish` are declared
 * `scope: "central"` — a chapter-scope grant reaches nothing, enforced at
 * derivation (`lib/seats.ts#getSeatDerivedMarketingCapabilities`).
 */
export const blogPosts = defineTable({
  /** The URL segment, and the key `blogReactions` counts against. Unique;
   *  minted from the title on create and frozen once `publishedAt` is set. */
  slug: v.string(),
  status: v.union(...BLOG_POST_STATUSES.map((s) => v.literal(s))),

  title: v.string(),
  /** Verbatim `<meta name="description">` and the index card's summary. */
  description: v.string(),
  /** The italic standfirst under the title. `undefined` (not `""`) when the
   *  post has none, so "no standfirst" and "a standfirst that is blank" can't
   *  drift apart in the renderer. */
  subtitle: v.optional(v.string()),
  /** Who the post is written for, shown above the title. */
  audience: v.optional(v.string()),
  author: v.string(),
  /** Markdown. Rendered to HTML at request time by
   *  `@events-os/shared`'s `blogMarkdown.ts` — never stored as HTML, so a fix
   *  to the renderer fixes every post that ever existed. */
  body: v.string(),
  tags: v.array(v.string()),

  /**
   * The hero image, as an upload.
   *
   * TWO fields, on purpose. `heroStorage` is the truth; `heroImageUrl` is the
   * servable URL cached at write time so the PUBLIC page doesn't pay a
   * `ctx.storage.getUrl` round trip per render (the index renders one per
   * card). The public read still falls back to a live `getUrl` when the cache
   * is missing — a row written before this field existed, or a storage id
   * swapped underneath it — so the cache can only ever be a speedup, never the
   * reason an image disappears.
   */
  heroStorage: v.optional(v.id("_storage")),
  heroImageUrl: v.optional(v.string()),

  /**
   * When the post FIRST went public. Set once, by `setPostStatus`, and never
   * cleared — un-publishing a post does not un-happen it, and the date is what
   * the feed, the sitemap's `lastmod`, and "first published" all read.
   * Also the flag the slug freeze checks.
   */
  publishedAt: v.optional(v.number()),
  /** Set when a PUBLISHED post is materially revised, so the page can say
   *  "updated" honestly. Never set while the post is still a draft — a draft
   *  being edited is a draft, not a revision. */
  revisedAt: v.optional(v.number()),

  /** The emoji bar (`blogReactions`). Off for a post where a reaction would be
   *  tasteless. */
  reactionsEnabled: v.boolean(),

  /**
   * The secret that makes a draft shareable — `/blog/<slug>?preview=<token>`.
   *
   * The same mechanism `eventPages.previewToken` uses, and it REPLACES the
   * landing repo's one shared draft password (which lived in a public
   * `wrangler.jsonc` and covered every draft forever). Minted at create, so
   * there is no lazy path that can hand out a link before the row has one, and
   * revocable per post by `rotatePreviewToken`.
   */
  previewToken: v.string(),

  createdBy: v.optional(v.id("users")),
  updatedBy: v.optional(v.id("users")),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  // The public route's only lookup: `/blog/<slug>` → the row.
  .index("by_slug", ["slug"])
  // The index, the feed, and the sitemap all want published posts newest
  // first; the index field pairs status with the date so that is one range
  // read rather than a scan of every draft ever started.
  .index("by_status_published", ["status", "publishedAt"]);
