/**
 * The marketing blog's backend — today, just its emoji reactions.
 *
 * The posts themselves are NOT here. They are markdown in the landing site's
 * repo (apps/landing/src/content/blog/) and build to static HTML, so this
 * backend owns exactly one thing the static site can't: the counter under
 * each post. See lib/blogReactions.ts for the rules and schema/blog.ts for
 * the shape.
 *
 * The read + toggle functions are PUBLIC and unauthenticated — there is no
 * login on publicworship.life. They are reached over HTTP from the post page
 * via `/api/blog/reactions` (lib/blogApiRoutes.ts), not through the Convex
 * client. The staff-facing summary is gated by lib/blogAccess.ts.
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import {
  BLOG_REACTION_EMOJIS,
  normalizeActorKey,
  normalizeEmoji,
  normalizeSlug,
  tally,
  type BlogReactionCounts,
} from "./lib/blogReactions";
import { requireBlogModerate } from "./lib/blogAccess";

/**
 * Every reaction row on a post.
 *
 * A full index scan per read, deliberately: a post gets tens to hundreds of
 * taps, the response is cached at the edge for a minute
 * (lib/blogApiRoutes.ts), and Convex queries are reactive-cached besides. If
 * a post ever draws enough traffic for this to matter, the fix is the
 * aggregate component (see lib/peopleAggregate.ts), not a denormalized
 * counter that can drift from the rows.
 */
async function countsForSlug(
  ctx: QueryCtx,
  slug: string,
): Promise<BlogReactionCounts> {
  const rows = await ctx.db
    .query("blogReactions")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .collect();
  return tally(rows);
}

/** Distinct browsers that have opened this post. Same full-scan posture as
 *  countsForSlug — rows are written once per (post, browser), and the
 *  response is edge-cached; the aggregate component is the fix if a post
 *  ever draws enough traffic to matter. */
async function readersForSlug(ctx: QueryCtx, slug: string): Promise<number> {
  const rows = await ctx.db
    .query("blogReads")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .collect();
  return rows.length;
}

/** The emoji this reader has already left on this post. */
async function mineForSlug(
  ctx: QueryCtx,
  slug: string,
  actorKey: string | undefined,
): Promise<string[]> {
  if (!actorKey) return [];
  const rows = await ctx.db
    .query("blogReactions")
    .withIndex("by_slug_actor", (q) =>
      q.eq("slug", slug).eq("actorKey", actorKey),
    )
    .collect();
  return rows.map((r) => r.emoji);
}

/**
 * PUBLIC. The reaction state for one post: the available emoji, the counts,
 * and (when the caller sends their browser-local key) which ones are theirs
 * so the bar can render pressed.
 */
export const getReactions = query({
  args: { slug: v.string(), actorKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const slug = normalizeSlug(args.slug);
    // An unparseable actorKey is not worth failing a READ over — the page
    // still deserves its counts, just without the pressed state.
    let actorKey: string | undefined;
    try {
      actorKey = args.actorKey ? normalizeActorKey(args.actorKey) : undefined;
    } catch {
      actorKey = undefined;
    }
    return {
      slug,
      emojis: [...BLOG_REACTION_EMOJIS],
      counts: await countsForSlug(ctx, slug),
      mine: await mineForSlug(ctx, slug, actorKey),
      readers: await readersForSlug(ctx, slug),
    };
  },
});

/**
 * PUBLIC. Count this browser as a reader of this post — once, ever — and
 * return the post's full state so the page needs one round trip, not two.
 *
 * Idempotent per (post, browser): the first call inserts a row, every later
 * call finds it and moves on. So a refresh, a back-button, or a re-shared
 * link never inflates the count — "readers" stays distinct browsers.
 */
export const recordRead = mutation({
  args: { slug: v.string(), actorKey: v.string() },
  handler: async (ctx, args) => {
    const slug = normalizeSlug(args.slug);
    const actorKey = normalizeActorKey(args.actorKey);

    const existing = await ctx.db
      .query("blogReads")
      .withIndex("by_slug_actor", (q) =>
        q.eq("slug", slug).eq("actorKey", actorKey),
      )
      .first();
    if (!existing) {
      await ctx.db.insert("blogReads", { slug, actorKey, createdAt: Date.now() });
    }

    return {
      slug,
      emojis: [...BLOG_REACTION_EMOJIS],
      counts: await countsForSlug(ctx, slug),
      mine: await mineForSlug(ctx, slug, actorKey),
      readers: await readersForSlug(ctx, slug),
    };
  },
});

/**
 * PUBLIC. Add or remove this reader's reaction, and return the post's fresh
 * state so the caller never has to follow up with a read.
 *
 * Idempotent per (post, reader, emoji): tapping twice lands back where it
 * started, which is what makes an anonymous counter survivable.
 */
export const toggleReaction = mutation({
  args: { slug: v.string(), emoji: v.string(), actorKey: v.string() },
  handler: async (ctx, args) => {
    const slug = normalizeSlug(args.slug);
    const emoji = normalizeEmoji(args.emoji);
    const actorKey = normalizeActorKey(args.actorKey);

    const existing = await ctx.db
      .query("blogReactions")
      .withIndex("by_slug_actor_emoji", (q) =>
        q.eq("slug", slug).eq("actorKey", actorKey).eq("emoji", emoji),
      )
      .first();

    if (existing) {
      await ctx.db.delete(existing._id);
    } else {
      await ctx.db.insert("blogReactions", {
        slug,
        emoji,
        actorKey,
        createdAt: Date.now(),
      });
    }

    return {
      slug,
      emojis: [...BLOG_REACTION_EMOJIS],
      counts: await countsForSlug(ctx, slug),
      mine: await mineForSlug(ctx, slug, actorKey),
      readers: await readersForSlug(ctx, slug),
    };
  },
});

/**
 * STAFF. Per-post totals across the whole blog, busiest first — "did anyone
 * actually read the thing?" without opening the database.
 *
 * Gated by `requireBlogModerate` (lib/blogAccess.ts), never by an inline
 * check here.
 */
export const reactionSummary = query({
  args: {},
  handler: async (ctx) => {
    await requireBlogModerate(ctx);
    const rows = await ctx.db.query("blogReactions").collect();
    const readRows = await ctx.db.query("blogReads").collect();
    const readsBySlug = new Map<string, number>();
    for (const r of readRows) {
      readsBySlug.set(r.slug, (readsBySlug.get(r.slug) ?? 0) + 1);
    }
    const bySlug = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = bySlug.get(row.slug);
      if (list) list.push(row);
      else bySlug.set(row.slug, [row]);
    }
    // A post can have readers but no reactions yet — it still belongs in
    // the summary, so seed the map from the read side too.
    for (const slug of readsBySlug.keys()) {
      if (!bySlug.has(slug)) bySlug.set(slug, []);
    }
    return [...bySlug.entries()]
      .map(([slug, slugRows]) => ({
        slug,
        total: slugRows.length,
        counts: tally(slugRows),
        // Distinct browsers that reacted — see lib/blogReactions.ts.
        reactors: new Set(slugRows.map((r) => r.actorKey)).size,
        // Distinct browsers that opened the post (schema/blog.ts#blogReads).
        readers: readsBySlug.get(slug) ?? 0,
        lastAt: slugRows.length
          ? Math.max(...slugRows.map((r) => r.createdAt))
          : 0,
      }))
      .sort((a, b) => b.total - a.total);
  },
});

/**
 * STAFF. Wipe a post's reactions AND its read count — the spam remedy for
 * counters that anyone on the internet can bump. One hammer on purpose: an
 * inflated post gets reset whole, not half. Returns how many rows went.
 */
export const clearReactions = mutation({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    await requireBlogModerate(ctx);
    const slug = normalizeSlug(args.slug);
    const rows = await ctx.db
      .query("blogReactions")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    const readRows = await ctx.db
      .query("blogReads")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .collect();
    for (const row of readRows) await ctx.db.delete(row._id);
    return { slug, removed: rows.length, readsRemoved: readRows.length };
  },
});
