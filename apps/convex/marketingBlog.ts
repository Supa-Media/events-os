/**
 * THE BLOG's backend — posts as rows, so the seat that owns the org's public
 * voice can publish the org's public writing without a developer.
 *
 * Read `@events-os/shared`'s `marketingBlog.ts` first: it is the contract
 * (statuses, the `BlogPost` shape, the slug rule, the preview mechanism) and
 * this module is only its enforcement. `schema/marketingBlog.ts` has the
 * table. `lib/blogPage.ts` is the public renderer that consumes the two
 * `internalQuery`s at the bottom.
 *
 * ── The shape this copies ───────────────────────────────────────────────────
 * `listings.ts`, deliberately and almost line for line: a draft/publish split
 * where a partial save is always allowed and COMPLETENESS is checked at the
 * one moment it matters (`problemsBlockingPublish`), a slug minted once from
 * the title, and a named access resolver on every write. That file's module
 * doc explains why the arrangement is worth copying; this is its third use.
 *
 * ── Where it deliberately differs from `listings.ts` ────────────────────────
 * THREE places, each because a blog post is not a job posting:
 *
 *  1. TWO gates, not one. `requireBlogEdit` writes; `requireBlogPublish`
 *     publishes and takes down. `lib/marketingAccess.ts` explains why this is
 *     the one place on the Marketing desk that asks for a second party — a
 *     post goes on the internet under the Corporation's name and gets quoted
 *     back years later.
 *  2. THREE states, not a boolean. An `archived` post still RESOLVES, to a
 *     page that says it was taken down, because a link shared once is shared
 *     forever and a 404 is a worse answer.
 *  3. A published post CANNOT be deleted. `listings.ts` hard-deletes freely
 *     because a listing's applications are denormalized snapshots. A post's
 *     URL is held by strangers and its reactions are keyed on its slug, so
 *     `deletePost` refuses and names archiving instead.
 *
 * ── One thing to know before editing a write path ───────────────────────────
 * The slug is FROZEN once `publishedAt` is set. `blogReactions` keys on the
 * slug string (`schema/blog.ts` says why it still does), so renaming a live
 * post orphans its reactions AND 404s every shared link. The freeze is in
 * `upsertPost` and nowhere else; do not add a second way to write `slug`.
 *
 * Every refusal is a `ConvexError({ code, message })`, never a plain `Error`,
 * so the app's AuthErrorBoundary can surface it.
 */
import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  BLOG_AUDIENCE_MAX,
  BLOG_AUTHOR_MAX,
  BLOG_BODY_MAX,
  BLOG_DEFAULT_AUTHOR,
  BLOG_DESCRIPTION_MAX,
  BLOG_POST_STATUSES,
  BLOG_PREVIEW_TOKEN_BYTES,
  BLOG_SLUG_RULE,
  BLOG_SUBTITLE_MAX,
  BLOG_TAGS_MAX_COUNT,
  BLOG_TAG_MAX,
  BLOG_TITLE_MAX,
  blogSlugFromTitle,
  extractHeadings,
  isValidBlogSlug,
  readingMinutes,
  renderBlogMarkdown,
  type BlogHeading,
  type BlogPost,
  type BlogPostSummary,
} from "@events-os/shared";
import { requireBlogEdit, requireBlogPublish } from "./lib/marketingAccess";
import { requireUserId } from "./lib/context";
import { DOXOLOGY_BODY, DOXOLOGY_POST } from "./lib/seed/blogPosts";

/**
 * Generous bound on a whole-table read. The org has published one post; a
 * decade of weekly posting is ~500. Bounded anyway, per CLAUDE.md — and if the
 * blog ever outgrows it, the fix is pagination on the desk list, not a bigger
 * number here.
 */
const POST_SCAN_LIMIT = 500;

const statusValidator = v.union(
  ...BLOG_POST_STATUSES.map((s) => v.literal(s)),
);

// ── Serialization ────────────────────────────────────────────────────────────

/**
 * The ONE place a `blogPosts` row becomes the shared `BlogPost` — the OS
 * editor and the public page both speak this type, so this is the seam that
 * must not drift.
 *
 * `updatedAt` maps from the row's `revisedAt`, NOT from its housekeeping
 * `updatedAt`. The contract's field means "this post was materially revised
 * after it went public", which is what the page prints as "Updated <date>".
 * The housekeeping column moves on every keystroke-batch a writer saves, so
 * wiring it through would put an "Updated today" line on a post whose author
 * fixed a typo — a claim the page would be making on the org's behalf that
 * isn't true.
 */
function serialize(doc: Doc<"blogPosts">): BlogPost {
  return {
    id: String(doc._id),
    slug: doc.slug,
    status: doc.status,
    title: doc.title,
    description: doc.description,
    subtitle: doc.subtitle ?? null,
    audience: doc.audience ?? null,
    author: doc.author,
    body: doc.body,
    tags: doc.tags,
    heroImageUrl: doc.heroImageUrl ?? null,
    publishedAt: doc.publishedAt ?? null,
    updatedAt: doc.revisedAt ?? null,
    reactionsEnabled: doc.reactionsEnabled,
  };
}

/** Everything but the body — what the index, the feed, and the desk list need,
 *  so listing fifty posts does not ship fifty essays. `readingMinutes` rides
 *  along because this side already holds the body and the far side does not;
 *  computing it here is the difference between the desk showing "12 min read"
 *  and the desk shipping the essay to find out. */
function summarize(
  doc: Doc<"blogPosts">,
): BlogPostSummary & { readingMinutes: number } {
  const { body, ...rest } = serialize(doc);
  return { ...rest, readingMinutes: readingMinutes(body) };
}

/**
 * The hero's servable URL: the cached one, or a live resolve when the cache is
 * empty.
 *
 * The cache is written by `upsertPost`. This fallback is what makes it a pure
 * speedup: a row inserted by the seed, or one whose cached URL was never
 * written, still renders its image instead of quietly losing it.
 */
async function heroUrl(
  ctx: QueryCtx,
  doc: Doc<"blogPosts">,
): Promise<string | null> {
  if (doc.heroImageUrl) return doc.heroImageUrl;
  if (!doc.heroStorage) return null;
  return await ctx.storage.getUrl(doc.heroStorage);
}

// ── Input hygiene ────────────────────────────────────────────────────────────

/** Trim and bound one text field, naming the field in the refusal. The bounds
 *  are the shared constants the editor's live counters use, so the counter
 *  turning red and the server saying no are the same rule. */
function bounded(value: string, max: number, what: string): string {
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: `Shorten ${what} — it can be at most ${max} characters.`,
    });
  }
  return trimmed;
}

/** Trim, drop blanks, de-duplicate, and bound both the tag and the count.
 *  De-duplication is case-insensitive because "Worship" and "worship" render
 *  as two chips that look like a mistake. */
function cleanTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    if (tag.length > BLOG_TAG_MAX) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: `"${tag}" is too long for a tag — ${BLOG_TAG_MAX} characters at most.`,
      });
    }
    seen.add(key);
    out.push(tag);
    if (out.length > BLOG_TAGS_MAX_COUNT) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: `A post can carry at most ${BLOG_TAGS_MAX_COUNT} tags.`,
      });
    }
  }
  return out;
}

/**
 * A URL-safe secret for a post's preview link.
 *
 * `crypto.getRandomValues` (not `Math.random`) — the token is the ONLY thing
 * standing between an unpublished post and the internet, exactly as
 * `ticketing.ts#newGuestToken` is for an unpublished event page. Hex rather
 * than that function's mixed-case alphabet so a token survives being retyped
 * or lowercased by a mail client on its way to a reviewer.
 */
function newPreviewToken(): string {
  const bytes = new Uint8Array(BLOG_PREVIEW_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A slug no other post holds. Appends `-2`, `-3`… on collision — two posts
 *  can honestly share a title ("Notes from the road") and must not share a
 *  URL. Mirrors `listings.ts#uniqueSlug`. */
async function uniqueSlug(ctx: MutationCtx, base: string): Promise<string> {
  let candidate = base;
  let n = 2;
  // Bounded: a realistic collision count is 1–2.
  for (let i = 0; i < 100; i++) {
    const clash = await ctx.db
      .query("blogPosts")
      .withIndex("by_slug", (q) => q.eq("slug", candidate))
      .first();
    if (!clash) return candidate;
    candidate = `${base}-${n++}`;
  }
  return `${base}-${Date.now()}`;
}

/**
 * What is still missing before a post may go PUBLIC, as human sentences.
 *
 * The direct copy of `listings.ts#problemsBlockingPublish`, for the same
 * reason: returned as a LIST rather than thrown one at a time, so the editor
 * can show a writer everything left to do at once. The bar is deliberately
 * low — a title, a description, and words in the body. A blog post has no
 * structural sections to leave half-filled; what it can be is empty, or
 * missing the sentence search engines and the index card will quote.
 */
function problemsBlockingPublish(doc: Doc<"blogPosts">): string[] {
  const problems: string[] = [];
  if (doc.title.trim().length === 0) problems.push("a title");
  if (doc.description.trim().length === 0) {
    problems.push("a description (it is the summary on the index and in search results)");
  }
  if (doc.body.trim().length === 0) problems.push("something in the body");
  if (!isValidBlogSlug(doc.slug)) problems.push(`a usable web address (${BLOG_SLUG_RULE})`);
  return problems;
}

/** Load a post or refuse. One message, so a stale editor tab and a bad id read
 *  the same. */
async function loadPost(
  ctx: QueryCtx,
  postId: Id<"blogPosts">,
): Promise<Doc<"blogPosts">> {
  const post = await ctx.db.get(postId);
  if (!post) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "That post doesn't exist — it may have been deleted.",
    });
  }
  return post;
}

// ── DESK reads (gated on `marketing.blog.edit`) ──────────────────────────────

/**
 * Every post — drafts and archived ones included — for the OS desk.
 *
 * Summaries, not full rows: the desk index renders a card per post and has no
 * use for the markdown, and the one existing post is 17KB of it. The editor
 * fetches the body it needs through `getPost`.
 *
 * Order is newest-touched first rather than by status. The desk groups by
 * status itself (`BlogView.tsx`'s `STATUS_ORDER`), and inside a group "what I
 * was last working on" is the thing a writer is looking for.
 */
export const listPosts = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<(BlogPostSummary & { readingMinutes: number })[]> => {
    await requireBlogEdit(ctx);
    const rows = await ctx.db.query("blogPosts").take(POST_SCAN_LIMIT);
    // Sorted as ROWS, before serializing: the wire shape's `updatedAt` is the
    // public "revised" stamp and is null for almost every post, so it cannot
    // order this list. The row's housekeeping clock can, and only the row has
    // it.
    rows.sort((a, b) => b.updatedAt - a.updatedAt);
    return await Promise.all(
      rows.map(async (doc) => ({
        ...summarize(doc),
        heroImageUrl: await heroUrl(ctx, doc),
      })),
    );
  },
});

/**
 * One post in full, for the editor — the shared `BlogPost` plus the preview
 * token.
 *
 * The token rides on THIS query and no other. `listPosts` deliberately does
 * not carry it: the desk index shows a "Copy preview link" button that fetches
 * the post on press, so a token only ever crosses the wire when somebody asked
 * for the link. Handing every card a live secret to render a button is how a
 * token ends up in a screenshot.
 */
export const getPost = query({
  args: { postId: v.id("blogPosts") },
  handler: async (
    ctx,
    args,
  ): Promise<(BlogPost & { previewToken: string }) | null> => {
    await requireBlogEdit(ctx);
    const post = await ctx.db.get(args.postId);
    if (!post) return null;
    return {
      ...serialize(post),
      heroImageUrl: await heroUrl(ctx, post),
      previewToken: post.previewToken,
    };
  },
});

// ── DESK writes ──────────────────────────────────────────────────────────────

/**
 * Create or edit a post. The desk's only save path.
 *
 * CREATE (no `postId`): a `title` is required — it is the post's identity and
 * the slug is minted from it here. Everything else defaults empty so a writer
 * can save a stub at 2am and come back; the post is born a DRAFT whatever else
 * is passed, because a first save is never a decision to publish. A preview
 * token is minted at the same moment, so there is no window in which the row
 * exists but has no shareable link.
 *
 * EDIT (with `postId`): every field is patched only when its arg was sent —
 * the `undefined`-means-leave-it rule `listings.ts` and `sponsorships.ts` both
 * use, so the editor can save one section without blanking the others. The
 * hero is the one field that cannot use it (a form never learns the bytes
 * behind a saved image, so "not sent" MUST mean keep), which is why removing
 * one takes an explicit `clearHero`.
 *
 * THE SLUG. Derived from the title on create; re-derived on a title change
 * ONLY while the post has never been published. Once `publishedAt` is set it
 * is frozen — see this module's header and `BLOG_SLUG_RULE`. This is silent
 * rather than a refusal on purpose: a writer fixing a typo in a live post's
 * headline is doing something completely reasonable, and the right answer is
 * to let them and keep the URL, not to make them choose.
 *
 * Publishing is NOT done here. `setPostStatus` owns it, so completeness is
 * checked at exactly the moment it matters and the second gate applies to
 * exactly the action that needs it.
 */
export const upsertPost = mutation({
  args: {
    postId: v.optional(v.id("blogPosts")),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    subtitle: v.optional(v.string()),
    audience: v.optional(v.string()),
    author: v.optional(v.string()),
    body: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    reactionsEnabled: v.optional(v.boolean()),
    heroStorage: v.optional(v.id("_storage")),
    /** Remove the hero. Explicit because omission means KEEP — see the doc. */
    clearHero: v.optional(v.boolean()),
  },
  returns: v.id("blogPosts"),
  handler: async (ctx, args): Promise<Id<"blogPosts">> => {
    await requireBlogEdit(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const now = Date.now();

    // Resolve the hero once — `ctx.storage.getUrl` is a round trip and the
    // three-state rule (set / clear / leave) is easier to read here than
    // spread through two patch objects.
    const hero =
      args.clearHero === true
        ? { heroStorage: undefined, heroImageUrl: undefined }
        : args.heroStorage
          ? {
              heroStorage: args.heroStorage,
              heroImageUrl:
                (await ctx.storage.getUrl(args.heroStorage)) ?? undefined,
            }
          : null;

    if (args.postId) {
      const existing = await loadPost(ctx, args.postId);

      const title =
        args.title !== undefined
          ? bounded(args.title, BLOG_TITLE_MAX, "the title")
          : undefined;

      // The freeze, in one expression. A post that has never been published
      // may still have its address corrected; one that has, may not.
      const slug =
        title !== undefined &&
        title !== existing.title &&
        existing.publishedAt === undefined
          ? await uniqueSlug(ctx, blogSlugFromTitle(title) || existing.slug)
          : undefined;

      await ctx.db.patch(args.postId, {
        ...(title !== undefined ? { title } : {}),
        ...(slug !== undefined ? { slug } : {}),
        ...(args.description !== undefined
          ? {
              description: bounded(
                args.description,
                BLOG_DESCRIPTION_MAX,
                "the description",
              ),
            }
          : {}),
        // An emptied standfirst/audience becomes `undefined`, not `""` — the
        // page branches on presence, and a blank string would render an empty
        // element where the design expects nothing at all.
        ...(args.subtitle !== undefined
          ? {
              subtitle:
                bounded(args.subtitle, BLOG_SUBTITLE_MAX, "the standfirst") ||
                undefined,
            }
          : {}),
        ...(args.audience !== undefined
          ? {
              audience:
                bounded(args.audience, BLOG_AUDIENCE_MAX, "the audience line") ||
                undefined,
            }
          : {}),
        ...(args.author !== undefined
          ? {
              author:
                bounded(args.author, BLOG_AUTHOR_MAX, "the author") ||
                BLOG_DEFAULT_AUTHOR,
            }
          : {}),
        ...(args.body !== undefined
          ? { body: boundedBody(args.body) }
          : {}),
        ...(args.tags !== undefined ? { tags: cleanTags(args.tags) } : {}),
        ...(args.reactionsEnabled !== undefined
          ? { reactionsEnabled: args.reactionsEnabled }
          : {}),
        ...(hero ?? {}),
        // Editing a LIVE post is a revision the page says out loud; editing a
        // draft is just writing. The public "Updated" line has to mean
        // something, so only the first case stamps it.
        ...(existing.status === "published" ? { revisedAt: now } : {}),
        updatedBy: userId,
        updatedAt: now,
      });
      return args.postId;
    }

    // CREATE
    const title = bounded(args.title ?? "", BLOG_TITLE_MAX, "the title");
    if (!title) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Give the post a title to start — the web address is built from it.",
      });
    }
    const base = blogSlugFromTitle(title);
    if (!base) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: `That title has nothing usable in a web address (${BLOG_SLUG_RULE}) — add some letters or numbers.`,
      });
    }
    return await ctx.db.insert("blogPosts", {
      slug: await uniqueSlug(ctx, base),
      status: "draft",
      title,
      description: bounded(
        args.description ?? "",
        BLOG_DESCRIPTION_MAX,
        "the description",
      ),
      subtitle:
        bounded(args.subtitle ?? "", BLOG_SUBTITLE_MAX, "the standfirst") ||
        undefined,
      audience:
        bounded(args.audience ?? "", BLOG_AUDIENCE_MAX, "the audience line") ||
        undefined,
      author:
        bounded(args.author ?? "", BLOG_AUTHOR_MAX, "the author") ||
        BLOG_DEFAULT_AUTHOR,
      body: boundedBody(args.body ?? ""),
      tags: cleanTags(args.tags ?? []),
      reactionsEnabled: args.reactionsEnabled ?? true,
      ...(hero ?? {}),
      previewToken: newPreviewToken(),
      createdBy: userId,
      updatedBy: userId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** The body is bounded but NOT trimmed of internal whitespace — markdown's
 *  trailing-double-space hard break is significant, and a writer's blank line
 *  between sections is the document's structure. Only the ends go. */
function boundedBody(body: string): string {
  if (body.length > BLOG_BODY_MAX) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: `This post is longer than the ${BLOG_BODY_MAX.toLocaleString()} character limit. Split it into two.`,
    });
  }
  return body.replace(/^\n+|\s+$/g, "");
}

/**
 * Move a post between the three states — the action that puts words on the
 * internet under the org's name, and the one that takes them down.
 *
 * `requireBlogPublish`, not `requireBlogEdit`: an associate may write, and
 * only the Marketing Director or the ED may publish. `lib/marketingAccess.ts`
 * has the argument.
 *
 * The transitions, and what each one means:
 *
 *   → published   Runs `problemsBlockingPublish` and refuses an incomplete
 *                 post, naming everything still needed (the shape
 *                 `listings.ts#setListingPublished` uses). Stamps
 *                 `publishedAt` if it is unset — first publication is when a
 *                 post gets its date, and re-publishing an archived post does
 *                 NOT re-date it, because the post is from when it is from.
 *                 That stamp is also what freezes the slug.
 *   → archived    Always allowed. Taking something down is never blocked.
 *   → draft       Allowed only from `draft` (i.e. a no-op). A post that has
 *                 been public cannot be walked back to "never published" —
 *                 the honest state for "we took it down" is `archived`, which
 *                 keeps the URL resolving. Refusing here is what stops the
 *                 desk from silently 404ing a shared link.
 */
export const setPostStatus = mutation({
  args: { postId: v.id("blogPosts"), status: statusValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireBlogPublish(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    const post = await loadPost(ctx, args.postId);
    const now = Date.now();

    if (args.status === post.status) return null;

    if (args.status === "draft") {
      // `publishedAt` is the honest test, not `status`. A post archived
      // straight from draft — a mistaken click on a piece nobody outside the
      // org ever saw — has no link out there to protect, and refusing it left
      // that post stuck forever behind an error message that was false about
      // its own case ("a post that has been public…" when it never had been).
      if (post.publishedAt !== undefined) {
        throw new ConvexError({
          code: "INVALID_TRANSITION",
          message:
            "A post that has been public can't go back to being a draft — its link is out there. Archive it instead: the page keeps resolving and says it was taken down.",
        });
      }
    }

    if (args.status === "published") {
      const problems = problemsBlockingPublish(post);
      if (problems.length > 0) {
        throw new ConvexError({
          code: "INCOMPLETE_POST",
          message: `This post still needs ${problems.join(", ")} before it can go live.`,
        });
      }
    }

    await ctx.db.patch(args.postId, {
      status: args.status,
      ...(args.status === "published" && post.publishedAt === undefined
        ? { publishedAt: now }
        : {}),
      updatedBy: userId,
      updatedAt: now,
    });
    return null;
  },
});

/**
 * Delete a post — and refuse while it is published.
 *
 * The refusal is the point, and it is where this parts company with
 * `listings.ts#deleteListing`. A published post's URL is held by strangers,
 * search engines, and whatever newsletter quoted it; its `blogReactions` rows
 * key on its slug. Deleting it 404s all of that. Archiving keeps the URL
 * resolving to a page that says the post was taken down, which is the honest
 * answer and the one the public renderer is built for.
 *
 * ── Two gates, because there are two different deletions ────────────────────
 * A post that was NEVER public is a draft somebody wrote and thought better
 * of; `marketing.blog.edit` — the power to write — is the right authority to
 * throw it away.
 *
 * A post that HAS been public is different even once archived: its URL is
 * still out there resolving, and deleting it turns a page that says "we took
 * this down" into a 404 while orphaning its reactions. Taking it down needed
 * `marketing.blog.publish`; erasing the evidence that it ever existed should
 * not need less. Gating this on `edit` let a writer undo a Director's decision
 * one screen later, which is the shape of every separation-of-duties bug.
 */
export const deletePost = mutation({
  args: { postId: v.id("blogPosts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireBlogEdit(ctx);
    const post = await ctx.db.get(args.postId);
    if (!post) return null; // deleting twice is not an error
    if (post.publishedAt !== undefined) await requireBlogPublish(ctx);
    if (post.status === "published") {
      throw new ConvexError({
        code: "PUBLISHED_POST",
        message:
          "A published post can't be deleted — every link anyone has shared would 404, and its reactions are counted against its address. Archive it instead: the page keeps resolving and says it was taken down.",
      });
    }
    await ctx.db.delete(args.postId);
    return null;
  },
});

/**
 * Mint a fresh preview token, invalidating every link handed out so far.
 *
 * `requireBlogEdit` rather than `requireBlogPublish`: rotating a token makes a
 * draft LESS reachable, and a writer who thinks a link went to the wrong
 * person should never have to find a director first. This is the revocation
 * the retired shared-password scheme had no equivalent of — one password in a
 * public repo covered every draft forever, and there was nothing to rotate.
 */
export const rotatePreviewToken = mutation({
  args: { postId: v.id("blogPosts") },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    await requireBlogEdit(ctx);
    const userId = (await requireUserId(ctx)) as Id<"users">;
    await loadPost(ctx, args.postId);
    const previewToken = newPreviewToken();
    await ctx.db.patch(args.postId, {
      previewToken,
      updatedBy: userId,
      updatedAt: Date.now(),
    });
    return previewToken;
  },
});

/** Upload URL for a post's hero image. Gated on `marketing.blog.edit` rather
 *  than reusing `api.storage.generateUploadUrl` (which any signed-in user can
 *  call), so the desk's uploads carry the desk's power — the same reason
 *  `marketingSite.ts#generateLinkImageUploadUrl` exists. */
export const generateHeroUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireBlogEdit(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

// ── PUBLIC reads (no auth — internal, reached through `lib/blogPage.ts`) ─────

/**
 * Every PUBLISHED post, newest first, as summaries.
 *
 * `internalQuery`, not `query`, for the reason `listings.ts#publicListings`
 * gives: the public surface is exactly the server-rendered routes in
 * `lib/blogPage.ts` (`/blog`, the RSS feed, the sitemap), not a second
 * directly-callable function that could drift out of the page's framing.
 *
 * Ordering is by `publishedAt` descending, read off the `by_status_published`
 * index — so this never walks the drafts. A published post always has a
 * `publishedAt` (`setPostStatus` stamps it), which is what makes the index
 * usable rather than merely present.
 */
export const publicPostList = internalQuery({
  args: {},
  returns: v.array(v.any()),
  handler: async (ctx): Promise<BlogPostSummary[]> => {
    const rows = await ctx.db
      .query("blogPosts")
      .withIndex("by_status_published", (q) => q.eq("status", "published"))
      .order("desc")
      .take(POST_SCAN_LIMIT);
    return await Promise.all(
      rows.map(async (doc) => {
        const { readingMinutes: _minutes, ...summary } = summarize(doc);
        return { ...summary, heroImageUrl: await heroUrl(ctx, doc) };
      }),
    );
  },
});

/**
 * One post by slug, rendered — the whole of what `/blog/<slug>` needs.
 *
 * Returns the post, its body as HTML, and its headings. The HTML and the
 * headings come from the SAME parse pass in `blogMarkdown.ts`, which is what
 * guarantees a table-of-contents link can never point at an anchor the page
 * does not have.
 *
 * ── Who resolves ────────────────────────────────────────────────────────────
 *   published  — always.
 *   archived   — always, and the caller reads `post.status` to render "this
 *                was taken down" rather than the article. Resolving is the
 *                whole point of the state (see the shared contract).
 *   draft      — ONLY with a matching `previewToken`.
 *
 * A draft without a token returns `null`, indistinguishable from a slug that
 * was never written. That is deliberate: a 404 that differed would confirm the
 * draft exists, which is exactly what an unpublished post must not do.
 *
 * The token comparison is a plain `===` on a 128-bit random hex string. A
 * constant-time compare was considered and is not worth it here: the secret is
 * per-post and rotatable, an attacker gets no oracle finer than "page or 404"
 * across a network, and the timing signal on a 32-character string comparison
 * is far below the noise floor of an HTTP round trip. `ticketing.ts` makes the
 * same call for the same reason.
 */
export const publicPost = internalQuery({
  args: { slug: v.string(), previewToken: v.optional(v.string()) },
  returns: v.union(v.null(), v.any()),
  handler: async (
    ctx,
    args,
  ): Promise<{
    post: BlogPost;
    html: string;
    headings: BlogHeading[];
  } | null> => {
    const post = await ctx.db
      .query("blogPosts")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
    if (!post) return null;

    if (post.status === "draft") {
      const token = args.previewToken;
      if (!token || token !== post.previewToken) return null;
    }

    return {
      post: { ...serialize(post), heroImageUrl: await heroUrl(ctx, post) },
      html: renderBlogMarkdown(post.body),
      headings: extractHeadings(post.body),
    };
  },
});

// ── one-time migration ───────────────────────────────────────────────────────

/**
 * Seed the ONE post that existed as markdown when the blog moved into the OS.
 *
 * Idempotent by the same "if empty" rule as `listings.ts#seedListingsIfEmpty`
 * and `marketingSite.ts#seedSiteContent`: it no-ops on a table that already has
 * a post, so once anyone creates one through the OS this never touches the
 * table again.
 *
 * ── RUNS ON DEPLOY, not from a runbook ──────────────────────────────────────
 * `migrations/0080_seed_marketing_desk.ts` calls the plain function below. That
 * is not a preference: the sibling site-content seed shipped as "run this once
 * after deploy", nobody ran it, and the founder opened an empty Links tab and
 * reported the feature as broken. Here the stakes are higher still — this seed
 * carries the ONLY remaining copy of a live, already-shared blog post, since
 * the markdown file it came from is deleted in the same change. Skipping it
 * would not leave an empty tab; it would take `/blog/doxology` off the
 * internet.
 *
 * The `internalMutation` stays for a manual re-run.
 *
 * `lib/seed/blogPosts.ts` holds the content, verbatim, and explains why the
 * slug is pinned to `doxology` rather than derived from the title.
 */
export async function seedBlogPosts(
  ctx: MutationCtx,
): Promise<{ inserted: number }> {
  const existing = await ctx.db.query("blogPosts").first();
  if (existing) return { inserted: 0 };
  const now = Date.now();
  await ctx.db.insert("blogPosts", {
    ...DOXOLOGY_POST,
    body: DOXOLOGY_BODY,
    // A migrated post still gets a token: it is a draft's mechanism, but the
    // row must never exist without one (the field is required, and a lazy
    // mint is a second write path onto a secret).
    previewToken: newPreviewToken(),
    createdAt: now,
    updatedAt: now,
  });
  return { inserted: 1 };
}

export const seedBlogPostsIfEmpty = internalMutation({
  args: {},
  returns: v.object({ inserted: v.number() }),
  handler: async (ctx) => await seedBlogPosts(ctx),
});
