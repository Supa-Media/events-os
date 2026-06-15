import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Site-map marker — a labelled pin placed on an event's venue map at a
 * normalized position (x,y in 0..1 of the image), categorized (team area,
 * station, equipment drop, stage…). The visual layout of where things go.
 */
export const siteMarkers = defineTable({
  chapterId: v.id("chapters"),
  eventId: v.id("events"),
  x: v.number(),
  y: v.number(),
  label: v.string(),
  // Free color name (e.g. "red"); markers aren't a fixed category set.
  color: v.optional(v.string()),
  // Legacy category (older markers); no longer set by the UI.
  category: v.optional(v.string()),
  createdAt: v.number(),
})
  .index("by_event", ["eventId"])
  .index("by_chapter", ["chapterId"]);

/**
 * Site-map shape — a basic sketched element so you can rough out the venue
 * WITHOUT a background image. `rect`/`circle` use (x,y) top-left + (w,h);
 * `line` uses (x,y)→(x2,y2). All coords normalized 0..1.
 */
export const siteShapes = defineTable({
  chapterId: v.id("chapters"),
  eventId: v.id("events"),
  type: v.union(v.literal("rect"), v.literal("circle"), v.literal("line")),
  x: v.number(),
  y: v.number(),
  w: v.optional(v.number()),
  h: v.optional(v.number()),
  x2: v.optional(v.number()),
  y2: v.optional(v.number()),
  color: v.optional(v.string()),
  label: v.optional(v.string()),
  createdAt: v.number(),
})
  .index("by_event", ["eventId"])
  .index("by_chapter", ["chapterId"]);

/**
 * Site-map placement — overlays an existing SUPPLY (eventItem, module
 * "supplies") or VOLUNTEER (engagement, type "volunteer") onto the venue map
 * as a positioned, draggable chip at a normalized position (x,y in 0..1).
 * `refId` is the source row's _id (kept as a string so one table can point at
 * either source); `kind` says which table it references.
 */
export const siteMapPlacements = defineTable({
  chapterId: v.id("chapters"),
  eventId: v.id("events"),
  kind: v.union(v.literal("supply"), v.literal("volunteer")),
  refId: v.string(), // the eventItem _id (supply) or engagement _id (volunteer)
  x: v.number(), // normalized 0..1
  y: v.number(),
  createdAt: v.number(),
})
  .index("by_event", ["eventId"])
  .index("by_event_kind", ["eventId", "kind"])
  .index("by_chapter", ["chapterId"]);
