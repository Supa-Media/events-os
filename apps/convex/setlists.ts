/**
 * Setlists + song requests.
 *
 * Two audiences share this file:
 *  - AUTHED, chapter-scoped: the worship leader building/running the setlist
 *    (add/remove/reorder songs, mark the current song, open/close requests) and
 *    working the incoming request queue.
 *  - PUBLIC, no-auth: the congregation's QR/link page — `publicBoard` (read) and
 *    `submitRequest` (write). These intentionally do NOT call
 *    `requireChapterId`/`requireUserId`, mirroring `events.publicCrew` /
 *    `docs.getPublic`. They return/accept only safe, request-facing data and
 *    derive `chapterId` from the event so writes stay tenant-isolated.
 */
import { query, mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import { requireEvent, requireOwned } from "./lib/context";
import { SONG_REQUEST_STATUSES, SONG_REQUEST_LIMITS } from "@events-os/shared";

const requestStatus = v.union(...SONG_REQUEST_STATUSES.map((s) => v.literal(s)));

/** Count active (non-dismissed) requests per songId for an event. */
async function requestCountsBySong(
  ctx: any,
  eventId: Id<"events">,
): Promise<Map<string, number>> {
  const requests = await ctx.db
    .query("songRequests")
    .withIndex("by_event", (q: any) => q.eq("eventId", eventId))
    .collect();
  const counts = new Map<string, number>();
  for (const r of requests) {
    if (r.songId && r.status !== "dismissed") {
      counts.set(r.songId, (counts.get(r.songId) ?? 0) + 1);
    }
  }
  return counts;
}

// ── Authed: setlist read + management ────────────────────────────────────────

/**
 * The event's setlist for the authed performer view: each entry joined with its
 * song (title/author/lyrics), whether it's current, and its live request count.
 */
export const forEvent = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const event = await requireEvent(ctx, eventId);
    const entries = (
      await ctx.db
        .query("setlistEntries")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect()
    ).sort((a, b) => a.order - b.order);
    const counts = await requestCountsBySong(ctx, eventId);
    const songs = await Promise.all(
      entries.map(async (e) => {
        const song = await ctx.db.get(e.songId);
        return {
          entryId: e._id,
          songId: e.songId,
          order: e.order,
          isCurrent: e.isCurrent === true,
          title: song?.title ?? "(deleted song)",
          author: song?.author ?? null,
          lyrics: song?.lyrics ?? null,
          requestCount: counts.get(e.songId) ?? 0,
        };
      }),
    );
    return { requestsOpen: event.songRequestsOpen !== false, songs };
  },
});

/** The full request queue for an event (newest first), for the requests panel. */
export const requests = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    await requireEvent(ctx, eventId);
    const reqs = (
      await ctx.db
        .query("songRequests")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect()
    ).sort((a, b) => b.createdAt - a.createdAt);
    return reqs.map((r) => ({
      _id: r._id,
      songId: r.songId ?? null,
      songTitle: r.songTitle,
      requesterName: r.requesterName ?? null,
      note: r.note ?? null,
      willSing: r.willSing === true,
      status: r.status,
      createdAt: r.createdAt,
    }));
  },
});

/** Add a library song to the event's setlist (appended; idempotent per song). */
export const addSong = mutation({
  args: { eventId: v.id("events"), songId: v.id("songs") },
  handler: async (ctx, { eventId, songId }) => {
    const event = await requireEvent(ctx, eventId);
    await requireOwned(ctx, "songs", songId, "Song");
    const existing = await ctx.db
      .query("setlistEntries")
      .withIndex("by_event_song", (q) =>
        q.eq("eventId", eventId).eq("songId", songId),
      )
      .first();
    if (existing) return existing._id;
    const entries = await ctx.db
      .query("setlistEntries")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();
    const maxOrder = entries.reduce((m, e) => Math.max(m, e.order), -1);
    return await ctx.db.insert("setlistEntries", {
      eventId,
      chapterId: event.chapterId,
      songId,
      order: maxOrder + 1,
      createdAt: Date.now(),
    });
  },
});

/** Remove a song from the setlist. */
export const removeEntry = mutation({
  args: { entryId: v.id("setlistEntries") },
  handler: async (ctx, { entryId }) => {
    const entry = await requireOwned(ctx, "setlistEntries", entryId, "Setlist entry");
    await ctx.db.delete(entryId);
    return entry.eventId;
  },
});

/** Move a setlist entry up/down by swapping order with its neighbor. */
export const move = mutation({
  args: {
    entryId: v.id("setlistEntries"),
    direction: v.union(v.literal("up"), v.literal("down")),
  },
  handler: async (ctx, { entryId, direction }) => {
    const entry = await requireOwned(ctx, "setlistEntries", entryId, "Setlist entry");
    const entries = (
      await ctx.db
        .query("setlistEntries")
        .withIndex("by_event", (q) => q.eq("eventId", entry.eventId))
        .collect()
    ).sort((a, b) => a.order - b.order);
    const idx = entries.findIndex((e) => e._id === entryId);
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= entries.length) return entryId;
    const other = entries[swapIdx];
    await ctx.db.patch(entry._id, { order: other.order });
    await ctx.db.patch(other._id, { order: entry.order });
    return entryId;
  },
});

/**
 * Mark which setlist entry the team is currently on (or clear with `null`).
 * Enforces the single-current invariant by clearing every other entry, so the
 * public page always shows at most one set of lyrics.
 */
export const setCurrent = mutation({
  args: {
    eventId: v.id("events"),
    entryId: v.union(v.id("setlistEntries"), v.null()),
  },
  handler: async (ctx, { eventId, entryId }) => {
    await requireEvent(ctx, eventId);
    const entries = await ctx.db
      .query("setlistEntries")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .collect();
    for (const e of entries) {
      const shouldBeCurrent = entryId !== null && e._id === entryId;
      if ((e.isCurrent === true) !== shouldBeCurrent) {
        await ctx.db.patch(e._id, { isCurrent: shouldBeCurrent });
      }
    }
    return eventId;
  },
});

/** Open or close the public request page for an event. */
export const setRequestsOpen = mutation({
  args: { eventId: v.id("events"), open: v.boolean() },
  handler: async (ctx, { eventId, open }) => {
    await requireEvent(ctx, eventId);
    await ctx.db.patch(eventId, { songRequestsOpen: open });
    return open;
  },
});

/** Update a request's status (queue / mark played / dismiss). */
export const setRequestStatus = mutation({
  args: { requestId: v.id("songRequests"), status: requestStatus },
  handler: async (ctx, { requestId, status }) => {
    await requireOwned(ctx, "songRequests", requestId, "Request");
    await ctx.db.patch(requestId, { status });
    return requestId;
  },
});

// ── Public: no-auth board read + request submit ──────────────────────────────

/**
 * PUBLIC, no-auth board for `/songs/<eventId>` — the congregation's view.
 *
 * Returns ONLY request-facing data: the event name, whether requests are open,
 * the lyrics of the current song (so people can follow along), and a suggestion
 * list (the setlist songs first, then any chapter doxologies not already on the
 * setlist) with live request counts. No chapter data, roster, or money.
 */
export const publicBoard = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get(eventId);
    if (!event) return null;

    const entries = (
      await ctx.db
        .query("setlistEntries")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect()
    ).sort((a, b) => a.order - b.order);
    const counts = await requestCountsBySong(ctx, eventId);

    // Current song → its lyrics.
    let currentSong:
      | { title: string; author: string | null; lyrics: string | null }
      | null = null;
    const currentEntry = entries.find((e) => e.isCurrent === true);
    if (currentEntry) {
      const s = await ctx.db.get(currentEntry.songId);
      if (s)
        currentSong = {
          title: s.title,
          author: s.author ?? null,
          lyrics: s.lyrics ?? null,
        };
    }

    // Suggestions = setlist songs (in order) + chapter doxologies not on it.
    const setlistSongIds = new Set(entries.map((e) => e.songId as string));
    const suggestions: {
      songId: string;
      title: string;
      author: string | null;
      count: number;
    }[] = [];
    for (const e of entries) {
      const s = await ctx.db.get(e.songId);
      if (s)
        suggestions.push({
          songId: e.songId,
          title: s.title,
          author: s.author ?? null,
          count: counts.get(e.songId) ?? 0,
        });
    }
    const doxologies = (
      await ctx.db
        .query("songs")
        .withIndex("by_chapter", (q) => q.eq("chapterId", event.chapterId))
        .collect()
    )
      .filter(
        (s) =>
          (s.tags ?? []).includes("doxology") &&
          !setlistSongIds.has(s._id as string),
      )
      .sort((a, b) => a.title.localeCompare(b.title));
    for (const s of doxologies) {
      suggestions.push({
        songId: s._id,
        title: s.title,
        author: s.author ?? null,
        count: counts.get(s._id) ?? 0,
      });
    }

    return {
      eventName: event.name,
      requestsOpen: event.songRequestsOpen !== false,
      currentSong,
      suggestions,
    };
  },
});

/**
 * PUBLIC, no-auth request submit. Accepts either a suggested library `songId`
 * (validated to belong to the event's chapter) or a free-text `songTitle`.
 * Refuses when the event is missing or requests are closed, and clamps every
 * field length defensively since the caller is anonymous.
 */
export const submitRequest = mutation({
  args: {
    eventId: v.id("events"),
    songId: v.optional(v.id("songs")),
    songTitle: v.optional(v.string()),
    requesterName: v.optional(v.string()),
    note: v.optional(v.string()),
    // The requester volunteers to help sing/lead this song.
    willSing: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (!event) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "This event isn't available.",
      });
    }
    if (event.songRequestsOpen === false) {
      throw new ConvexError({
        code: "CLOSED",
        message: "Song requests are closed for this event right now.",
      });
    }

    let songId: Id<"songs"> | undefined;
    let title = (args.songTitle ?? "").trim();
    if (args.songId) {
      const song = await ctx.db.get(args.songId);
      // Only honor a songId that belongs to THIS event's chapter (no cross-tenant
      // reference smuggled in by a crafted public call).
      if (song && song.chapterId === event.chapterId) {
        songId = args.songId;
        if (!title) title = song.title;
      }
    }
    if (!title) {
      throw new ConvexError({
        code: "INVALID",
        message: "Tell us which song you'd like.",
      });
    }

    const clip = (s: string | undefined, max: number) =>
      s && s.trim() ? s.trim().slice(0, max) : undefined;

    await ctx.db.insert("songRequests", {
      eventId: args.eventId,
      chapterId: event.chapterId,
      songId,
      songTitle: title.slice(0, SONG_REQUEST_LIMITS.title),
      requesterName: clip(args.requesterName, SONG_REQUEST_LIMITS.name),
      note: clip(args.note, SONG_REQUEST_LIMITS.note),
      // Only record an offer to sing when a name is attached — an anonymous
      // "I'll sing" is no use to the worship leader.
      willSing: args.willSing === true && !!clip(args.requesterName, SONG_REQUEST_LIMITS.name),
      status: "new",
      createdAt: Date.now(),
    });
    return { ok: true };
  },
});
