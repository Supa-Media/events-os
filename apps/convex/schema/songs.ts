import { defineTable } from "convex/server";
import { v } from "convex/values";
import { SONG_REQUEST_STATUSES } from "@events-os/shared";

/**
 * Songs module — a chapter song library, per-event setlists, and public song
 * requests.
 *
 * Unlike the planning surfaces, songs are NOT modeled through the unified
 * items/grid model: lyrics, an ordered setlist, a single "current" song, and
 * anonymous public requests are bespoke shapes, so they get dedicated tables.
 *
 *   songs          → the reusable LIBRARY (lyrics live here, entered once)
 *   setlistEntries → a song placed on ONE event's setlist (ordered, ≤1 current)
 *   songRequests   → an anonymous request submitted from the public QR page
 *
 * Everything is chapter-scoped from day one (multi-city is V3). Requests carry
 * their own `chapterId` (copied from the event) so the moderation queue stays
 * tenant-isolated even though it's written by logged-out callers.
 */

/** A chapter-wide reusable song: title, author, full lyrics, and tags. */
export const songs = defineTable({
  chapterId: v.id("chapters"),
  title: v.string(),
  // Hymn author / songwriter / artist (display only).
  author: v.optional(v.string()),
  // Full lyrics (plain text / light markdown). Surfaced on the public page when
  // the song is the one the team is currently on.
  lyrics: v.optional(v.string()),
  // Free-form tags; `doxology` and `well_known` are first-class (see
  // FIRST_CLASS_SONG_TAGS) — songs carrying either are surfaced as default
  // suggestions on the public request page even when off the setlist.
  tags: v.optional(v.array(v.string())),
  createdBy: v.optional(v.id("people")),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  .index("by_chapter_title", ["chapterId", "title"]);

/**
 * A song placed on a specific event's setlist. `order` drives the scroll order
 * day-of; `isCurrent` marks the single song the team is on right now (the
 * backend clears the others when one is set), which the public page reads to
 * show live lyrics.
 */
export const setlistEntries = defineTable({
  eventId: v.id("events"),
  chapterId: v.id("chapters"),
  songId: v.id("songs"),
  order: v.number(),
  isCurrent: v.optional(v.boolean()),
  createdAt: v.number(),
})
  .index("by_event", ["eventId"])
  .index("by_event_song", ["eventId", "songId"])
  .index("by_song", ["songId"]);

/**
 * A public, anonymous song request tied to an event. Written by logged-out
 * callers from `/songs/<eventId>`, so it carries a `songTitle` snapshot (and an
 * optional `songId` when requested from a suggested library song) plus a tiny
 * status lifecycle the worship leader works during the service.
 */
export const songRequests = defineTable({
  eventId: v.id("events"),
  chapterId: v.id("chapters"),
  songId: v.optional(v.id("songs")),
  songTitle: v.string(),
  requesterName: v.optional(v.string()),
  note: v.optional(v.string()),
  // The requester is offering to help SING/lead this song themselves (their
  // name in `requesterName` is who to look for). Lets the worship leader pull
  // willing voices up front.
  willSing: v.optional(v.boolean()),
  status: v.union(...SONG_REQUEST_STATUSES.map((s) => v.literal(s))),
  createdAt: v.number(),
})
  .index("by_event", ["eventId"])
  .index("by_event_status", ["eventId", "status"])
  .index("by_event_song", ["eventId", "songId"])
  // Lets `songs.remove` clear a deleted song's requests without a table scan.
  .index("by_song", ["songId"]);
