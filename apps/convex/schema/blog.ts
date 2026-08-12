import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Blog reactions — the emoji bar under each post on publicworship.life.
 *
 * One row per (post, reader, emoji). The reader is anonymous: `actorKey` is a
 * random id their browser mints and keeps in localStorage, which exists only
 * to make the reaction a TOGGLE (react / un-react) and to stop an accidental
 * double count. It is not an identity and carries no PII — see
 * lib/blogReactions.ts's module doc.
 *
 * Deliberately NOT chapter-scoped, unlike almost every other table here: the
 * blog is an org-level marketing surface, not chapter work, so there is no
 * chapterId to attribute a stranger's tap to.
 *
 * `slug` is the landing site's content-collection slug (apps/landing's
 * `src/content/blog/<slug>.md`) — a plain string rather than a foreign key,
 * because the posts live in the repo and are built statically. Renaming a
 * post's file therefore orphans its reactions; that is the accepted cost of
 * keeping posts in git rather than in this database.
 */
export const blogReactions = defineTable({
  slug: v.string(),
  emoji: v.string(),
  actorKey: v.string(),
  createdAt: v.number(),
})
  // Counting a post's reactions.
  .index("by_slug", ["slug"])
  // "Which ones did THIS reader leave?" — the toggle state on page load.
  .index("by_slug_actor", ["slug", "actorKey"])
  // The exact row a toggle flips, without scanning the reader's other taps.
  .index("by_slug_actor_emoji", ["slug", "actorKey", "emoji"]);

/**
 * Blog reads — the "N readers" count next to the reaction bar.
 *
 * One row per (post, browser), written once when a browser first opens the
 * post and never again: the count is DISTINCT READERS, not page views, so a
 * refresh doesn't inflate it. Same anonymous `actorKey` as blogReactions,
 * with the same honesty caveat: it counts browsers that ran the script, so
 * it undercounts (JS off, storage blocked → fresh key each visit is the one
 * overcount path) and a determined person can clear storage and count
 * again. A warmth signal for the writers, never a metric.
 */
export const blogReads = defineTable({
  slug: v.string(),
  actorKey: v.string(),
  createdAt: v.number(),
})
  // Counting a post's readers.
  .index("by_slug", ["slug"])
  // The dedup check: has THIS browser already been counted for this post?
  .index("by_slug_actor", ["slug", "actorKey"]);
