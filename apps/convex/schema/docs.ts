import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Doc — the standalone target behind a "How-To" cell.
 *
 * Every How-To cell points at one doc row (its value is the `Id<"docs">`), so
 * each how-to has its own identity and public share URL — even a bare link. A
 * doc renders one of four ways (`kind`): an external `link`, a `video`
 * (youtube/dropbox/etc.), a short inline `note`, or a full editable `markdown`
 * page. `body` is always LITERAL Markdown (note/markdown); `url` backs
 * link/video.
 *
 * `shareId` is a short, unguessable public slug — the capability for the no-auth
 * `/d/<shareId>` route (same trust model as the crew share page). Chapter
 * scoping keeps authed reads/writes inside the caller's chapter.
 */
export const docs = defineTable({
  chapterId: v.id("chapters"),
  kind: v.union(
    v.literal("link"),
    v.literal("video"),
    v.literal("note"),
    v.literal("markdown"),
  ),
  title: v.string(),
  // link / video target.
  url: v.optional(v.string()),
  // note / markdown source (literal Markdown).
  body: v.optional(v.string()),
  // Short public slug for the unauthenticated share route.
  shareId: v.string(),
  // Public/internal visibility. Undefined (or "public") → readable at the no-auth
  // `/d/<shareId>` route; "internal" → `getPublic` returns null. Optional so all
  // existing docs default to PUBLIC.
  visibility: v.optional(v.union(v.literal("public"), v.literal("internal"))),
  // Copy-on-write origin. A template's How-To doc is `scope: "template"` and is
  // shared by reference into every event; editing it from an event forks a
  // `scope: "event"` copy (see `forkForEventItem` in docs.ts). Optional so rows
  // that predate this model still validate.
  scope: v.optional(v.union(v.literal("template"), v.literal("event"))),
  // Provenance for an event copy — the template-origin doc it was forked from.
  forkedFromDocId: v.optional(v.id("docs")),
  createdBy: v.id("people"),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_chapter", ["chapterId"])
  .index("by_share", ["shareId"]);
