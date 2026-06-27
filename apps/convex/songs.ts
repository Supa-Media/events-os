/**
 * Songs library — chapter-scoped CRUD for the reusable song catalog.
 *
 * Lyrics are entered once here and reused across events via setlists (see
 * `setlists.ts`). Every function resolves the caller's chapter and scopes
 * reads/writes to it, mirroring `people.ts`.
 */
import { query, mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import {
  requireUserId,
  requireChapterId,
  requireOwned,
  getChapterIdOrNull,
} from "./lib/context";

/** List the chapter's song library (optionally filtered), sorted by title. */
export const list = query({
  args: { search: v.optional(v.string()) },
  handler: async (ctx, { search }) => {
    const chapterId = await getChapterIdOrNull(ctx);
    if (!chapterId) return [];
    const all = await ctx.db
      .query("songs")
      .withIndex("by_chapter", (q) =>
        q.eq("chapterId", chapterId as Id<"chapters">),
      )
      .collect();
    const term = (search ?? "").trim().toLowerCase();
    const filtered = term
      ? all.filter(
          (s) =>
            s.title.toLowerCase().includes(term) ||
            (s.author ?? "").toLowerCase().includes(term) ||
            (s.tags ?? []).some((t) => t.toLowerCase().includes(term)),
        )
      : all;
    return filtered.sort((a, b) => a.title.localeCompare(b.title));
  },
});

/** Fetch a single song in the caller's chapter. */
export const get = query({
  args: { songId: v.id("songs") },
  handler: async (ctx, { songId }) =>
    await requireOwned(ctx, "songs", songId, "Song"),
});

/** Add a song to the chapter library. */
export const create = mutation({
  args: {
    title: v.string(),
    author: v.optional(v.string()),
    lyrics: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const chapterId = await requireChapterId(ctx);
    await requireUserId(ctx);
    const title = args.title.trim();
    if (!title) {
      throw new ConvexError({ code: "INVALID", message: "A song needs a title." });
    }
    const now = Date.now();
    return await ctx.db.insert("songs", {
      chapterId: chapterId as Id<"chapters">,
      title,
      author: args.author?.trim() || undefined,
      lyrics: args.lyrics,
      tags: args.tags,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Update a song's title / author / lyrics / tags. `null` clears a field. */
export const update = mutation({
  args: {
    songId: v.id("songs"),
    title: v.optional(v.string()),
    author: v.optional(v.union(v.string(), v.null())),
    lyrics: v.optional(v.union(v.string(), v.null())),
    tags: v.optional(v.union(v.array(v.string()), v.null())),
  },
  handler: async (ctx, { songId, ...patch }) => {
    await requireOwned(ctx, "songs", songId, "Song");
    const fields: Record<string, unknown> = { updatedAt: Date.now() };
    if (patch.title !== undefined) {
      const t = patch.title.trim();
      if (t) fields.title = t;
    }
    if (patch.author !== undefined)
      fields.author = patch.author === null ? undefined : patch.author.trim() || undefined;
    if (patch.lyrics !== undefined)
      fields.lyrics = patch.lyrics === null ? undefined : patch.lyrics;
    if (patch.tags !== undefined)
      fields.tags = patch.tags === null ? undefined : patch.tags;
    await ctx.db.patch(songId, fields);
    return songId;
  },
});

/**
 * Delete a song. Cascades to its setlist entries on every event; any public
 * requests that pointed at it keep their `songTitle` snapshot but have `songId`
 * cleared so they don't dangle.
 */
export const remove = mutation({
  args: { songId: v.id("songs") },
  handler: async (ctx, { songId }) => {
    await requireOwned(ctx, "songs", songId, "Song");
    const entries = await ctx.db
      .query("setlistEntries")
      .withIndex("by_song", (q) => q.eq("songId", songId))
      .collect();
    for (const e of entries) await ctx.db.delete(e._id);
    const reqs = await ctx.db
      .query("songRequests")
      .filter((q) => q.eq(q.field("songId"), songId))
      .collect();
    for (const r of reqs) await ctx.db.patch(r._id, { songId: undefined });
    await ctx.db.delete(songId);
    return songId;
  },
});
